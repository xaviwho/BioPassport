/**
 * Issuer Service Type Definitions
 */

export interface IssuerConfig {
  orgId: string;
  privateKeyPath: string;
  purechainEndpoint: string;
  storageEndpoint: string;
  storageBucket: string;
  storageAccessKey?: string;
  storageSecretKey?: string;
}

export interface MaterialMetadata {
  name: string;
  description?: string;
  source?: string;
  species?: string;
  tissueType?: string;
  cellType?: string;
  diseaseModel?: string;
  geneticModifications?: string[];
  biosafety?: string;
  cultureConditions?: {
    medium?: string;
    supplements?: string[];
    temperature?: number;
    co2Percentage?: number;
  };
  customFields?: Record<string, unknown>;
}

export interface CredentialPayload {
  credentialType: string;
  materialId: string;
  [key: string]: unknown;
}

export interface ArtifactUploadResult {
  cid: string;
  hash: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface SignedCredential {
  payload: CredentialPayload;
  commitmentHash: string;
  signature: string;
  issuerId: string;
  issuedAt: string;
}

export interface IssuanceResult {
  credentialId: string;
  materialId: string;
  credentialType: string;
  commitmentHash: string;
  artifactRefs: ArtifactUploadResult[];
  txId: string;
  issuedAt: string;
}

export interface RegistrationResult {
  materialId: string;
  materialType: string;
  metadataHash: string;
  txId: string;
  createdAt: string;
}
