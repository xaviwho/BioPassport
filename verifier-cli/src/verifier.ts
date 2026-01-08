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

const ec = new EC('secp256k1');

export interface VerifierConfig {
  purechainEndpoint: string;
  storageEndpoint: string;
  storagePort: number;
  storageBucket: string;
  storageAccessKey: string;
  storageSecretKey: string;
  trustedIssuers?: string[];
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

  constructor(config: VerifierConfig) {
    this.config = config;
    this.storage = new MinioClient({
      endPoint: config.storageEndpoint,
      port: config.storagePort,
      useSSL: false,
      accessKey: config.storageAccessKey,
      secretKey: config.storageSecretKey
    });
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

          // Verify artifacts if requested
          if (options.verifyArtifacts && validCred.artifactRefs.length > 0) {
            for (const artifact of validCred.artifactRefs) {
              const integrityResult = await this.verifyArtifactIntegrity(
                validCred.credentialId,
                validCred.credentialType,
                artifact
              );
              artifactIntegrity.push(integrityResult);
              if (!integrityResult.valid) {
                checks.push({
                  name: 'Artifact Integrity',
                  pass: false,
                  severity: 'ERROR',
                  message: `Artifact integrity check failed: ${artifact.filename || artifact.cid}`,
                  details: integrityResult
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
    // In production, this would:
    // 1. Get the issuer's public key from a registry
    // 2. Reconstruct the canonical credential payload
    // 3. Verify the signature
    
    // For now, return true (signature verification would be implemented with actual keys)
    console.log(`Verifying signature for credential ${credential.credentialId}`);
    return true;
  }

  private async verifyArtifactIntegrity(
    credentialId: string,
    credentialType: string,
    artifact: { cid: string; hash: string; filename?: string }
  ): Promise<ArtifactIntegrityResult> {
    try {
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

  // Simulated chain queries (would connect to PureChain in production)
  private async getMaterial(materialId: string): Promise<Material | null> {
    // In production, query PureChain
    console.log(`Querying material: ${materialId}`);
    return null; // Would return actual material
  }

  private async getCredentialsForMaterial(materialId: string): Promise<Credential[]> {
    // In production, query PureChain
    console.log(`Querying credentials for: ${materialId}`);
    return []; // Would return actual credentials
  }

  private async getTransfersForMaterial(materialId: string): Promise<TransferEvent[]> {
    // In production, query PureChain
    console.log(`Querying transfers for: ${materialId}`);
    return []; // Would return actual transfers
  }
}

/**
 * Create verifier from environment or config
 */
export function createVerifier(config?: Partial<VerifierConfig>): MaterialVerifier {
  const fullConfig: VerifierConfig = {
    purechainEndpoint: config?.purechainEndpoint || process.env.PURECHAIN_ENDPOINT || 'localhost:7051',
    storageEndpoint: config?.storageEndpoint || process.env.STORAGE_ENDPOINT || 'localhost',
    storagePort: config?.storagePort || parseInt(process.env.STORAGE_PORT || '9000'),
    storageBucket: config?.storageBucket || process.env.STORAGE_BUCKET || 'biopassport',
    storageAccessKey: config?.storageAccessKey || process.env.STORAGE_ACCESS_KEY || 'minioadmin',
    storageSecretKey: config?.storageSecretKey || process.env.STORAGE_SECRET_KEY || 'minioadmin',
    trustedIssuers: config?.trustedIssuers || process.env.TRUSTED_ISSUERS?.split(',')
  };
  return new MaterialVerifier(fullConfig);
}
