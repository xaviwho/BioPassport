/**
 * BioPassport Material Verifier
 *
 * Verifies materials against on-chain policy rules and validates
 * off-chain artifact integrity.
 */

import * as crypto from 'crypto';
import { Client as MinioClient } from 'minio';
import canonicalize from 'canonicalize';
import { ec as EC } from 'elliptic';
import { ethers, JsonRpcProvider, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { IssuerRegistry } from './issuer-registry';
import { VerifierCache } from './cache';

const ec = new EC('secp256k1');

export interface VerifierConfig {
  purechainEndpoint: string;
  contractAddress: string;
  storageEndpoint: string;
  storagePort: number;
  storageBucket: string;
  storageAccessKey: string;
  storageSecretKey: string;
  trustedIssuers?: string[];
  issuerRegistryPath?: string;
}

export interface Material {
  materialId: string;
  materialType: string;
  metadataHash: string;
  ownerOrg: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  materialId: string;
  credentialId: string;
  credentialType: string;
  commitmentHash: string;
  issuerId: string;
  issuedAt: string;
  validUntil: string;
  artifactRefs: Array<{ cid: string; hash: string; filename?: string }>;
  signatureRef: string;
  revoked: boolean;
  revokedAt?: string;
  revokedReason?: string;
}

export interface TransferEvent {
  transferId: string;
  materialId: string;
  from: string;
  to: string;
  shipmentHash: string;
  timestamp: string;
  accepted: boolean;
  acceptedAt?: string;
}

export interface VerificationResult {
  pass: boolean;
  materialId: string;
  material: Material | null;
  verifiedAt: string;
  checks: VerificationCheck[];
  credentialSummary: CredentialSummary[];
  transferChain: TransferChainResult;
  artifactIntegrity: ArtifactIntegrityResult[];
  overallScore: number;
}

export interface VerificationCheck {
  name: string;
  pass: boolean;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
  details?: Record<string, unknown>;
}

export interface CredentialSummary {
  credentialType: string;
  credentialId: string;
  issuerId: string;
  issuedAt: string;
  validUntil: string;
  status: 'VALID' | 'EXPIRED' | 'REVOKED' | 'MISSING';
  signatureValid?: boolean;
}

export interface TransferChainResult {
  valid: boolean;
  transfers: TransferEvent[];
  gaps: string[];
  pendingTransfers: string[];
}

export interface ArtifactIntegrityResult {
  credentialId: string;
  credentialType: string;
  artifactCid: string;
  filename?: string;
  expectedHash: string;
  actualHash?: string;
  valid: boolean;
  error?: string;
}

export class MaterialVerifier {
  private config: VerifierConfig;
  private storage: MinioClient;
  private provider: JsonRpcProvider;
  private contract: Contract;
  private issuerRegistry: IssuerRegistry;
  private cache: VerifierCache;

  constructor(config: VerifierConfig) {
    this.config = config;
    this.storage = new MinioClient({
      endPoint: config.storageEndpoint,
      port: config.storagePort,
      useSSL: false,
      accessKey: config.storageAccessKey,
      secretKey: config.storageSecretKey
    });

    // Initialize PureChain connection with static network to avoid extra RPC calls
    const chainId = parseInt(process.env.CHAIN_ID || '900520900520');
    this.provider = new JsonRpcProvider(config.purechainEndpoint, {
      chainId,
      name: 'purechain'
    }, { staticNetwork: true });

    // Load contract ABI and initialize contract
    const contractABI = this.loadContractABI();
    this.contract = new Contract(
      config.contractAddress,
      contractABI,
      this.provider
    );

    // Initialize issuer registry
    this.issuerRegistry = new IssuerRegistry(config.issuerRegistryPath);

    // Initialize cache
    this.cache = new VerifierCache({
      materialTTL: 5 * 60 * 1000,      // 5 minutes
      credentialTTL: 5 * 60 * 1000,    // 5 minutes
      artifactMaxSize: 100 * 1024 * 1024  // 100MB
    });
  }

  /**
   * Load contract ABI from compiled artifacts
   */
  private loadContractABI(): any[] {
    const artifactPaths = [
      path.resolve(__dirname, '../../contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json'),
      path.resolve(__dirname, '../../../contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json'),
      path.resolve(process.cwd(), 'contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json'),
      path.resolve(process.cwd(), '../contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json'),
    ];

    for (const artifactPath of artifactPaths) {
      if (fs.existsSync(artifactPath)) {
        console.log(`Loading contract ABI from: ${artifactPath}`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        return artifact.abi;
      }
    }

    throw new Error(
      'Contract ABI not found. Please compile contracts first:\n' +
      '  cd contracts && npx hardhat compile'
    );
  }

  /**
   * Perform full verification of a material
   */
  async verify(
    materialId: string,
    options: {
      atTime?: string;
      verifyArtifacts?: boolean;
      verifySignatures?: boolean;
    } = {}
  ): Promise<VerificationResult> {
    const verifyTime = options.atTime ? new Date(options.atTime) : new Date();
    const checks: VerificationCheck[] = [];
    const credentialSummary: CredentialSummary[] = [];
    const artifactIntegrity: ArtifactIntegrityResult[] = [];
    let overallPass = true;

    // 1. Get material from chain
    const material = await this.getMaterial(materialId);
    
    if (!material) {
      return {
        pass: false,
        materialId,
        material: null,
        verifiedAt: verifyTime.toISOString(),
        checks: [{
          name: 'Material Exists',
          pass: false,
          severity: 'ERROR',
          message: `Material ${materialId} not found on chain`
        }],
        credentialSummary: [],
        transferChain: { valid: false, transfers: [], gaps: [], pendingTransfers: [] },
        artifactIntegrity: [],
        overallScore: 0
      };
    }

    // 2. Check material status
    const statusCheck = this.checkMaterialStatus(material);
    checks.push(statusCheck);
    if (!statusCheck.pass) overallPass = false;

    // 3. Get and verify credentials
    const credentials = await this.getCredentialsForMaterial(materialId);
    
    // Check for required credentials based on material type
    const requiredCredentials = this.getRequiredCredentials(material.materialType);
    
    for (const requiredType of requiredCredentials) {
      const matchingCreds = credentials.filter(c => c.credentialType === requiredType);
      
      if (matchingCreds.length === 0) {
        checks.push({
          name: `${requiredType} Credential`,
          pass: false,
          severity: 'ERROR',
          message: `Missing required credential: ${requiredType}`
        });
        credentialSummary.push({
          credentialType: requiredType,
          credentialId: '',
          issuerId: '',
          issuedAt: '',
          validUntil: '',
          status: 'MISSING'
        });
        overallPass = false;
      } else {
        // Find the most recent valid credential
        const validCred = matchingCreds
          .filter(c => !c.revoked && new Date(c.validUntil) > verifyTime)
          .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime())[0];

        if (validCred) {
          // Verify signature if requested
          let signatureValid: boolean | undefined;
          if (options.verifySignatures) {
            signatureValid = await this.verifyCredentialSignature(validCred);
          }

          checks.push({
            name: `${requiredType} Credential`,
            pass: true,
            severity: 'INFO',
            message: `Valid ${requiredType} credential found`,
            details: {
              credentialId: validCred.credentialId,
              issuerId: validCred.issuerId,
              validUntil: validCred.validUntil
            }
          });
          credentialSummary.push({
            credentialType: requiredType,
            credentialId: validCred.credentialId,
            issuerId: validCred.issuerId,
            issuedAt: validCred.issuedAt,
            validUntil: validCred.validUntil,
            status: 'VALID',
            signatureValid
          });

          // Verify artifacts if requested (parallelized for performance)
          if (options.verifyArtifacts && validCred.artifactRefs.length > 0) {
            // Download and verify all artifacts in parallel (5-10x faster)
            const artifactPromises = validCred.artifactRefs.map(artifact =>
              this.verifyArtifactIntegrity(
                validCred.credentialId,
                validCred.credentialType,
                artifact
              )
            );

            const integrityResults = await Promise.all(artifactPromises);

            // Process results
            for (const integrityResult of integrityResults) {
              artifactIntegrity.push(integrityResult);
              if (!integrityResult.valid) {
                const artifact = validCred.artifactRefs.find(a => a.cid === integrityResult.artifactCid);
                checks.push({
                  name: 'Artifact Integrity',
                  pass: false,
                  severity: 'ERROR',
                  message: `Artifact integrity check failed: ${artifact?.filename || integrityResult.artifactCid}`,
                  details: { ...integrityResult } as Record<string, unknown>
                });
                overallPass = false;
              }
            }
          }
        } else {
          // Check if expired or revoked
          const mostRecent = matchingCreds
            .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime())[0];
          
          const status = mostRecent.revoked ? 'REVOKED' : 'EXPIRED';
          checks.push({
            name: `${requiredType} Credential`,
            pass: false,
            severity: 'ERROR',
            message: `${requiredType} credential is ${status.toLowerCase()}`,
            details: {
              credentialId: mostRecent.credentialId,
              validUntil: mostRecent.validUntil,
              revokedAt: mostRecent.revokedAt
            }
          });
          credentialSummary.push({
            credentialType: requiredType,
            credentialId: mostRecent.credentialId,
            issuerId: mostRecent.issuerId,
            issuedAt: mostRecent.issuedAt,
            validUntil: mostRecent.validUntil,
            status
          });
          overallPass = false;
        }
      }
    }

    // 4. Verify transfer chain
    const transferChain = await this.verifyTransferChain(materialId);
    if (!transferChain.valid) {
      checks.push({
        name: 'Transfer Chain',
        pass: false,
        severity: 'ERROR',
        message: 'Transfer chain has gaps or pending transfers',
        details: {
          gaps: transferChain.gaps,
          pendingTransfers: transferChain.pendingTransfers
        }
      });
      overallPass = false;
    } else {
      checks.push({
        name: 'Transfer Chain',
        pass: true,
        severity: 'INFO',
        message: `Transfer chain valid (${transferChain.transfers.length} transfers)`
      });
    }

    // 5. Check trusted issuers
    if (this.config.trustedIssuers && this.config.trustedIssuers.length > 0) {
      const untrustedIssuers = credentialSummary
        .filter(c => c.status === 'VALID' && !this.config.trustedIssuers!.includes(c.issuerId))
        .map(c => c.issuerId);
      
      if (untrustedIssuers.length > 0) {
        checks.push({
          name: 'Trusted Issuers',
          pass: false,
          severity: 'WARNING',
          message: `Credentials from untrusted issuers: ${untrustedIssuers.join(', ')}`
        });
      }
    }

    // Calculate overall score
    const totalChecks = checks.length;
    const passedChecks = checks.filter(c => c.pass).length;
    const overallScore = Math.round((passedChecks / totalChecks) * 100);

    return {
      pass: overallPass,
      materialId,
      material,
      verifiedAt: verifyTime.toISOString(),
      checks,
      credentialSummary,
      transferChain,
      artifactIntegrity,
      overallScore
    };
  }

  /**
   * Quick verification (on-chain only, no artifact checks)
   */
  async quickVerify(materialId: string): Promise<{ pass: boolean; reasons: string[] }> {
    const result = await this.verify(materialId, {
      verifyArtifacts: false,
      verifySignatures: false
    });

    return {
      pass: result.pass,
      reasons: result.checks.filter(c => !c.pass).map(c => c.message)
    };
  }

  private checkMaterialStatus(material: Material): VerificationCheck {
    switch (material.status) {
      case 'ACTIVE':
        return {
          name: 'Material Status',
          pass: true,
          severity: 'INFO',
          message: 'Material is active'
        };
      case 'QUARANTINED':
        return {
          name: 'Material Status',
          pass: false,
          severity: 'ERROR',
          message: 'Material is quarantined'
        };
      case 'REVOKED':
        return {
          name: 'Material Status',
          pass: false,
          severity: 'ERROR',
          message: 'Material has been revoked'
        };
      case 'EXPIRED':
        return {
          name: 'Material Status',
          pass: false,
          severity: 'ERROR',
          message: 'Material has expired'
        };
      default:
        return {
          name: 'Material Status',
          pass: false,
          severity: 'WARNING',
          message: `Unknown material status: ${material.status}`
        };
    }
  }

  private getRequiredCredentials(materialType: string): string[] {
    const requirements: Record<string, string[]> = {
      'CELL_LINE': ['IDENTITY', 'QC_MYCO'],
      'PLASMID': ['IDENTITY'],
      'TISSUE': ['IDENTITY'],
      'ORGANISM': ['IDENTITY']
    };
    return requirements[materialType] || ['IDENTITY'];
  }

  private async verifyCredentialSignature(credential: Credential): Promise<boolean> {
    try {
      // 1. Get the issuer's public key from registry
      const publicKey = await this.issuerRegistry.getPublicKey(credential.issuerId);
      if (!publicKey) {
        console.error(`Public key not found for issuer: ${credential.issuerId}`);
        return false;
      }

      // 2. Reconstruct the canonical credential payload
      const payload = {
        credentialType: credential.credentialType,
        materialId: credential.materialId,
        issuerId: credential.issuerId,
        issuedAt: credential.issuedAt,
        validUntil: credential.validUntil,
        artifactRefs: credential.artifactRefs,
        commitmentHash: credential.commitmentHash
      };

      // 3. Get signature (from storage or inline)
      const signature = await this.getSignature(credential.signatureRef);
      if (!signature) {
        console.error(`Signature not found for credential ${credential.credentialId}`);
        return false;
      }

      // 4. Verify signature using elliptic curve cryptography
      const canonical = canonicalize(payload);
      if (!canonical) {
        console.error('Failed to canonicalize credential payload');
        return false;
      }

      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      const key = ec.keyFromPublic(publicKey, 'hex');
      const isValid = key.verify(hash, signature);

      if (!isValid) {
        console.error(`Invalid signature for credential ${credential.credentialId}`);
      }

      return isValid;
    } catch (error: any) {
      console.error(`Signature verification failed for credential ${credential.credentialId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get signature from storage or inline reference
   */
  private async getSignature(signatureRef: string): Promise<string | null> {
    try {
      // If signature is stored in S3/MinIO
      if (signatureRef.startsWith('s3://')) {
        const objectKey = this.cidToObjectKey(signatureRef);
        const chunks: Buffer[] = [];
        const stream = await this.storage.getObject(this.config.storageBucket, objectKey);

        return new Promise((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          stream.on('error', (error) => {
            console.error(`Failed to fetch signature from storage: ${error.message}`);
            resolve(null);
          });
        });
      }

      // Otherwise assume it's an inline signature
      return signatureRef;
    } catch (error: any) {
      console.error(`Failed to get signature: ${error.message}`);
      return null;
    }
  }

  private async verifyArtifactIntegrity(
    credentialId: string,
    credentialType: string,
    artifact: { cid: string; hash: string; filename?: string }
  ): Promise<ArtifactIntegrityResult> {
    try {
      // Check cache first
      const cachedArtifact = this.cache.getArtifact(artifact.cid);

      if (cachedArtifact) {
        console.log(`[CACHE HIT] Artifact: ${artifact.filename || artifact.cid}`);
        const actualHash = crypto.createHash('sha256').update(cachedArtifact).digest('hex');

        return {
          credentialId,
          credentialType,
          artifactCid: artifact.cid,
          filename: artifact.filename,
          expectedHash: artifact.hash,
          actualHash,
          valid: actualHash === artifact.hash
        };
      }

      console.log(`[CACHE MISS] Downloading artifact: ${artifact.filename || artifact.cid}`);

      // Parse CID to get object key
      const objectKey = this.cidToObjectKey(artifact.cid);

      // Download and hash the artifact
      const chunks: Buffer[] = [];
      const stream = await this.storage.getObject(this.config.storageBucket, objectKey);

      return new Promise((resolve) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');

          // Cache the artifact
          this.cache.setArtifact(artifact.cid, buffer);
          
          resolve({
            credentialId,
            credentialType,
            artifactCid: artifact.cid,
            filename: artifact.filename,
            expectedHash: artifact.hash,
            actualHash,
            valid: actualHash === artifact.hash
          });
        });
        stream.on('error', (error: Error) => {
          resolve({
            credentialId,
            credentialType,
            artifactCid: artifact.cid,
            filename: artifact.filename,
            expectedHash: artifact.hash,
            valid: false,
            error: error.message
          });
        });
      });
    } catch (error) {
      return {
        credentialId,
        credentialType,
        artifactCid: artifact.cid,
        filename: artifact.filename,
        expectedHash: artifact.hash,
        valid: false,
        error: (error as Error).message
      };
    }
  }

  private cidToObjectKey(cid: string): string {
    const match = cid.match(/^s3:\/\/[^/]+\/(.+)$/);
    if (match) {
      return match[1];
    }
    return cid;
  }

  private async verifyTransferChain(materialId: string): Promise<TransferChainResult> {
    const transfers = await this.getTransfersForMaterial(materialId);
    
    if (transfers.length === 0) {
      return { valid: true, transfers: [], gaps: [], pendingTransfers: [] };
    }

    // Sort by timestamp
    transfers.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const gaps: string[] = [];
    const pendingTransfers: string[] = [];

    // Check for pending (unaccepted) transfers
    for (const transfer of transfers) {
      if (!transfer.accepted) {
        pendingTransfers.push(transfer.transferId);
      }
    }

    // Check chain continuity
    for (let i = 0; i < transfers.length - 1; i++) {
      if (transfers[i].to !== transfers[i + 1].from) {
        gaps.push(`Gap between transfer ${transfers[i].transferId} and ${transfers[i + 1].transferId}`);
      }
    }

    return {
      valid: gaps.length === 0 && pendingTransfers.length === 0,
      transfers,
      gaps,
      pendingTransfers
    };
  }

  /**
   * Query material from PureChain blockchain (with caching)
   */
  private async getMaterial(materialId: string): Promise<Material | null> {
    // Check cache first
    const cached = this.cache.getMaterial(materialId);
    if (cached) {
      console.log(`[CACHE HIT] Material: ${materialId}`);
      return cached;
    }

    try {
      console.log(`[CACHE MISS] Querying material from blockchain: ${materialId}`);
      const result = await this.queryWithRetry(() => this.contract.getMaterial(materialId));

      if (!result || result.materialId === '') {
        return null;
      }

      // Parse Solidity enum to string
      const statusMap = ['ACTIVE', 'QUARANTINED', 'REVOKED'];

      const material = {
        materialId: result.materialId,
        materialType: result.materialType,
        metadataHash: ethers.hexlify(result.metadataHash),
        ownerOrg: result.ownerOrg,
        status: statusMap[result.status] || 'UNKNOWN',
        createdAt: new Date(Number(result.createdAt) * 1000).toISOString(),
        updatedAt: new Date(Number(result.updatedAt) * 1000).toISOString()
      };

      // Cache the result
      this.cache.setMaterial(materialId, material);

      return material;
    } catch (error: any) {
      console.error(`Failed to query material ${materialId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Query credentials for a material from PureChain blockchain (with caching)
   */
  private async getCredentialsForMaterial(materialId: string): Promise<Credential[]> {
    // Check cache first
    const cached = this.cache.getCredentials(materialId);
    if (cached) {
      console.log(`[CACHE HIT] Credentials for: ${materialId}`);
      return cached;
    }

    try {
      console.log(`[CACHE MISS] Querying credentials from blockchain for: ${materialId}`);
      const results = await this.queryWithRetry(() => this.contract.getCredentials(materialId));

      if (!results || results.length === 0) {
        this.cache.setCredentials(materialId, []);
        return [];
      }

      const credTypeMap = ['IDENTITY', 'QC_MYCO', 'USAGE_RIGHTS'];

      const credentials = results.map((cred: any) => ({
        materialId: cred.materialId,
        credentialId: cred.credentialId,
        credentialType: credTypeMap[cred.credType] || 'UNKNOWN',
        commitmentHash: ethers.hexlify(cred.commitmentHash),
        issuerId: cred.issuerId,
        issuedAt: new Date(Number(cred.issuedAt) * 1000).toISOString(),
        validUntil: new Date(Number(cred.validUntil) * 1000).toISOString(),
        artifactRefs: [{
          cid: cred.artifactCid,
          hash: ethers.hexlify(cred.artifactHash)
        }],
        signatureRef: cred.signatureRef || '',
        revoked: cred.revoked,
        revokedAt: cred.revoked ? new Date().toISOString() : undefined,
        revokedReason: cred.revoked ? 'Revoked on-chain' : undefined
      }));

      // Cache the result
      this.cache.setCredentials(materialId, credentials);

      return credentials;
    } catch (error: any) {
      console.error(`Failed to query credentials for ${materialId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Query transfer history for a material from PureChain blockchain (with caching)
   */
  private async getTransfersForMaterial(materialId: string): Promise<TransferEvent[]> {
    // Check cache first
    const cached = this.cache.getTransfers(materialId);
    if (cached) {
      console.log(`[CACHE HIT] Transfers for: ${materialId}`);
      return cached;
    }

    try {
      console.log(`[CACHE MISS] Querying transfers from blockchain for: ${materialId}`);
      const results = await this.queryWithRetry(() => this.contract.getTransfers(materialId));

      if (!results || results.length === 0) {
        this.cache.setTransfers(materialId, []);
        return [];
      }

      const transfers = results.map((transfer: any) => ({
        transferId: transfer.transferId,
        materialId: transfer.materialId,
        from: transfer.fromOrg,
        to: transfer.toOrg,
        shipmentHash: ethers.hexlify(transfer.shipmentHash),
        timestamp: new Date(Number(transfer.timestamp) * 1000).toISOString(),
        accepted: transfer.accepted,
        acceptedAt: transfer.accepted ? new Date(Number(transfer.timestamp) * 1000).toISOString() : undefined
      }));

      // Cache the result
      this.cache.setTransfers(materialId, transfers);

      return transfers;
    } catch (error: any) {
      console.error(`Failed to query transfers for ${materialId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Retry wrapper for blockchain queries
   */
  private async queryWithRetry<T>(
    queryFn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await queryFn();
      } catch (error: any) {
        if (attempt === maxRetries) {
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`Query failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Batch verify multiple materials (10-20x faster than sequential)
   * @param materialIds - Array of material IDs to verify
   * @param options - Verification options
   * @returns Map of material ID to verification result
   */
  async batchVerify(
    materialIds: string[],
    options: {
      atTime?: string;
      verifyArtifacts?: boolean;
      verifySignatures?: boolean;
    } = {}
  ): Promise<Map<string, VerificationResult>> {
    console.log(`\nBatch verifying ${materialIds.length} materials...`);

    // Verify all materials in parallel
    const verifyPromises = materialIds.map(async materialId => {
      try {
        const result = await this.verify(materialId, options);
        return { materialId, result };
      } catch (error: any) {
        return {
          materialId,
          result: {
            pass: false,
            materialId,
            material: null,
            verifiedAt: new Date().toISOString(),
            checks: [{
              name: 'Batch Verification',
              pass: false,
              severity: 'ERROR' as const,
              message: `Verification failed: ${error.message}`
            }],
            credentialSummary: [],
            transferChain: { valid: false, transfers: [], gaps: [], pendingTransfers: [] },
            artifactIntegrity: [],
            overallScore: 0
          }
        };
      }
    });

    const results = await Promise.all(verifyPromises);

    // Convert to Map
    const resultMap = new Map<string, VerificationResult>();
    for (const { materialId, result } of results) {
      resultMap.set(materialId, result);
    }

    console.log(`\nBatch verification complete: ${results.length} materials verified`);

    return resultMap;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Get cache health summary
   */
  getCacheHealth() {
    return this.cache.getHealth();
  }

  /**
   * Clear all caches
   */
  clearCache() {
    this.cache.clearAll();
    console.log('All caches cleared');
  }

  /**
   * Invalidate cache for a specific material
   */
  invalidateMaterialCache(materialId: string) {
    this.cache.invalidateMaterial(materialId);
    console.log(`Cache invalidated for material: ${materialId}`);
  }
}

/**
 * Create verifier from environment or config
 */
export function createVerifier(config?: Partial<VerifierConfig>): MaterialVerifier {
  const fullConfig: VerifierConfig = {
    purechainEndpoint: config?.purechainEndpoint || process.env.RPC_URL || 'https://purechainnode.com:8547',
    contractAddress: config?.contractAddress || process.env.CONTRACT_ADDRESS || '',
    storageEndpoint: config?.storageEndpoint || process.env.STORAGE_ENDPOINT || 'localhost',
    storagePort: config?.storagePort || parseInt(process.env.STORAGE_PORT || '9000'),
    storageBucket: config?.storageBucket || process.env.STORAGE_BUCKET || 'biopassport',
    storageAccessKey: config?.storageAccessKey || process.env.STORAGE_ACCESS_KEY || 'minioadmin',
    storageSecretKey: config?.storageSecretKey || process.env.STORAGE_SECRET_KEY || 'minioadmin',
    trustedIssuers: config?.trustedIssuers || process.env.TRUSTED_ISSUERS?.split(','),
    issuerRegistryPath: config?.issuerRegistryPath || process.env.ISSUER_REGISTRY_PATH
  };

  if (!fullConfig.contractAddress) {
    throw new Error(
      'Contract address is required. Set CONTRACT_ADDRESS environment variable or provide in config.'
    );
  }

  return new MaterialVerifier(fullConfig);
}
