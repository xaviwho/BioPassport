/**
 * Credential Issuer Service
 * 
 * Handles the full credential issuance pipeline:
 * 1. Build credential JSON
 * 2. Canonicalize and hash
 * 3. Sign with issuer key
 * 4. Upload artifacts to off-chain storage
 * 5. Anchor commitment hash on-chain
 */

import { v4 as uuidv4 } from 'uuid';
import { ec as EC } from 'elliptic';
import {
  IssuerConfig,
  MaterialMetadata,
  CredentialPayload,
  ArtifactUploadResult,
  SignedCredential,
  IssuanceResult,
  RegistrationResult
} from './types';
import {
  computeCommitmentHash,
  signCredential,
  sha256,
  canonicalizeJson,
  keyFromSeed
} from './crypto';
import { ArtifactStorage, createStorage } from './storage';
import { PureChainClient, createPureChainClient } from './purechain-client';

export class CredentialIssuer {
  private config: IssuerConfig;
  private privateKey: EC.KeyPair;
  private storage: ArtifactStorage;
  private purechain: PureChainClient;

  constructor(
    config: IssuerConfig,
    privateKey: EC.KeyPair,
    storage: ArtifactStorage,
    purechain: PureChainClient
  ) {
    this.config = config;
    this.privateKey = privateKey;
    this.storage = storage;
    this.purechain = purechain;
  }

  /**
   * Initialize connections
   */
  async init(): Promise<void> {
    await this.storage.init();
    await this.purechain.connect();
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    await this.purechain.disconnect();
  }

  /**
   * Register a new material
   */
  async registerMaterial(
    materialType: string,
    metadata: MaterialMetadata
  ): Promise<RegistrationResult> {
    // Canonicalize and hash metadata
    const metadataHash = computeCommitmentHash(metadata);

    // Submit to blockchain
    const result = await this.purechain.registerMaterial(materialType, metadataHash);

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to register material: ${result.error}`);
    }

    // Extract materialId from result
    const materialId = (result.result as { materialId?: string })?.materialId || 
      `bio:${materialType.toLowerCase()}:${uuidv4()}`;

    return {
      materialId,
      materialType,
      metadataHash,
      txId: result.txId,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Issue a credential for a material
   */
  async issueCredential(
    materialId: string,
    credentialType: string,
    payload: CredentialPayload,
    artifactPaths: string[] = [],
    validityDays: number = 90
  ): Promise<IssuanceResult> {
    // Ensure payload has required fields
    const fullPayload: CredentialPayload = {
      ...payload,
      credentialType,
      materialId,
      issuerId: this.config.orgId,
      issuedAt: new Date().toISOString()
    };

    // Compute validity period
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);
    fullPayload.validUntil = validUntil.toISOString();

    // Upload artifacts
    const artifactRefs: ArtifactUploadResult[] = [];
    for (const artifactPath of artifactPaths) {
      const uploadResult = await this.storage.uploadArtifact(
        artifactPath,
        materialId,
        credentialType
      );
      artifactRefs.push(uploadResult);
    }

    // Add artifact references to payload
    fullPayload.artifactRefs = artifactRefs.map(a => ({
      cid: a.cid,
      hash: a.hash,
      filename: a.filename
    }));

    // Compute commitment hash
    const commitmentHash = computeCommitmentHash(fullPayload);

    // Sign the credential
    const signature = signCredential(fullPayload, this.privateKey);

    // Anchor on-chain
    const chainArtifactRefs = artifactRefs.map(a => ({
      cid: a.cid,
      hash: a.hash
    }));

    const result = await this.purechain.issueCredential(
      materialId,
      credentialType,
      commitmentHash,
      validUntil.toISOString(),
      chainArtifactRefs,
      signature
    );

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to issue credential: ${result.error}`);
    }

    const credentialId = (result.result as { credentialId?: string })?.credentialId ||
      `cred:${uuidv4()}`;

    return {
      credentialId,
      materialId,
      credentialType,
      commitmentHash,
      artifactRefs,
      txId: result.txId,
      issuedAt: fullPayload.issuedAt as string
    };
  }

  /**
   * Issue an IDENTITY credential
   */
  async issueIdentityCredential(
    materialId: string,
    identityMethod: string,
    identityHash: string,
    options: {
      referenceDatabase?: string;
      matchScore?: number;
      matchThreshold?: number;
      artifactPaths?: string[];
      validityDays?: number;
    } = {}
  ): Promise<IssuanceResult> {
    const payload: CredentialPayload = {
      credentialType: 'IDENTITY',
      materialId,
      identityMethod,
      identityHash,
      referenceDatabase: options.referenceDatabase,
      matchScore: options.matchScore,
      matchThreshold: options.matchThreshold
    };

    return this.issueCredential(
      materialId,
      'IDENTITY',
      payload,
      options.artifactPaths || [],
      options.validityDays || 365
    );
  }

  /**
   * Issue a QC_MYCO credential
   */
  async issueMycoCredential(
    materialId: string,
    result: 'NEGATIVE' | 'POSITIVE' | 'INCONCLUSIVE',
    testMethod: string,
    testDate: string,
    laboratory: string,
    options: {
      labAccreditation?: string;
      sampleId?: string;
      passageNumber?: number;
      reportPath?: string;
      validityDays?: number;
    } = {}
  ): Promise<IssuanceResult> {
    const payload: CredentialPayload = {
      credentialType: 'QC_MYCO',
      materialId,
      result,
      testMethod,
      testDate,
      laboratory,
      labAccreditation: options.labAccreditation,
      sampleId: options.sampleId,
      passageNumber: options.passageNumber
    };

    const artifactPaths = options.reportPath ? [options.reportPath] : [];

    return this.issueCredential(
      materialId,
      'QC_MYCO',
      payload,
      artifactPaths,
      options.validityDays || 90
    );
  }

  /**
   * Issue a TRANSFER credential
   */
  async issueTransferCredential(
    materialId: string,
    fromOrg: string,
    toOrg: string,
    shipmentMethod: string,
    options: {
      carrier?: string;
      trackingNumber?: string;
      quantity?: { vials?: number; cellCount?: string; volume?: string };
      passageNumber?: number;
      shipmentFormPath?: string;
      mtaReference?: string;
    } = {}
  ): Promise<IssuanceResult> {
    const payload: CredentialPayload = {
      credentialType: 'TRANSFER',
      materialId,
      fromOrg,
      toOrg,
      transferDate: new Date().toISOString(),
      shipmentMethod,
      carrier: options.carrier,
      trackingNumber: options.trackingNumber,
      quantity: options.quantity,
      passageNumber: options.passageNumber,
      mtaReference: options.mtaReference
    };

    const artifactPaths = options.shipmentFormPath ? [options.shipmentFormPath] : [];

    return this.issueCredential(
      materialId,
      'TRANSFER',
      payload,
      artifactPaths,
      365 // Transfers don't expire in the same way
    );
  }

  /**
   * Issue a USAGE_RIGHTS credential
   */
  async issueUsageRightsCredential(
    materialId: string,
    grantedTo: string,
    permissions: {
      research: boolean;
      commercial: boolean;
      distribution: boolean;
      modification?: boolean;
      publication?: boolean;
    },
    options: {
      expirationDate?: string;
      restrictions?: string[];
      mtaDocumentPath?: string;
      mtaReference?: string;
    } = {}
  ): Promise<IssuanceResult> {
    const payload: CredentialPayload = {
      credentialType: 'USAGE_RIGHTS',
      materialId,
      grantedTo,
      grantedBy: this.config.orgId,
      effectiveDate: new Date().toISOString(),
      expirationDate: options.expirationDate,
      permissions,
      restrictions: options.restrictions,
      mtaReference: options.mtaReference
    };

    const artifactPaths = options.mtaDocumentPath ? [options.mtaDocumentPath] : [];
    const validityDays = options.expirationDate 
      ? Math.ceil((new Date(options.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : 365 * 5; // 5 years default

    return this.issueCredential(
      materialId,
      'USAGE_RIGHTS',
      payload,
      artifactPaths,
      validityDays
    );
  }

  /**
   * Transfer material to another organization
   */
  async transferMaterial(
    materialId: string,
    toOrg: string,
    shipmentFormPath?: string
  ): Promise<{ transferId: string; txId: string }> {
    let shipmentHash = '';
    
    if (shipmentFormPath) {
      const { sha256File } = await import('./crypto');
      shipmentHash = await sha256File(shipmentFormPath);
    }

    const result = await this.purechain.transferMaterial(materialId, toOrg, shipmentHash);

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to transfer material: ${result.error}`);
    }

    const transferId = (result.result as { transferId?: string })?.transferId ||
      `xfer:${uuidv4()}`;

    return {
      transferId,
      txId: result.txId
    };
  }

  /**
   * Set material status (QUARANTINE/REVOKE)
   */
  async setMaterialStatus(
    materialId: string,
    status: 'QUARANTINED' | 'REVOKED' | 'ACTIVE',
    reason: string
  ): Promise<{ txId: string }> {
    const reasonHash = sha256(reason);
    const result = await this.purechain.setStatus(materialId, status, reasonHash);

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to set status: ${result.error}`);
    }

    return { txId: result.txId };
  }

  /**
   * Revoke a credential
   */
  async revokeCredential(
    credentialId: string,
    reason: string
  ): Promise<{ txId: string }> {
    const result = await this.purechain.revokeCredential(credentialId, reason);

    if (result.status !== 'SUCCESS') {
      throw new Error(`Failed to revoke credential: ${result.error}`);
    }

    return { txId: result.txId };
  }
}

/**
 * Create issuer instance from config
 */
export function createIssuer(config: Partial<IssuerConfig> = {}): CredentialIssuer {
  const fullConfig: IssuerConfig = {
    orgId: config.orgId || process.env.ISSUER_ORG_ID || 'DefaultOrg',
    privateKeyPath: config.privateKeyPath || process.env.ISSUER_PRIVATE_KEY || '',
    purechainEndpoint: config.purechainEndpoint || process.env.PURECHAIN_ENDPOINT || 'localhost:7051',
    storageEndpoint: config.storageEndpoint || process.env.STORAGE_ENDPOINT || 'localhost:9000',
    storageBucket: config.storageBucket || process.env.STORAGE_BUCKET || 'biopassport'
  };

  // For demo/testing, generate key from org ID if no key path provided
  const privateKey = fullConfig.privateKeyPath 
    ? require('./crypto').loadPrivateKey(fullConfig.privateKeyPath)
    : keyFromSeed(fullConfig.orgId);

  const storage = createStorage({
    endpoint: fullConfig.storageEndpoint,
    bucket: fullConfig.storageBucket
  });

  const purechain = createPureChainClient({
    endpoint: fullConfig.purechainEndpoint,
    orgId: fullConfig.orgId
  });

  return new CredentialIssuer(fullConfig, privateKey, storage, purechain);
}
