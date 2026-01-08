/**
 * BioPassport Type Definitions
 */

export enum MaterialType {
  CELL_LINE = 'CELL_LINE',
  PLASMID = 'PLASMID',
  TISSUE = 'TISSUE',
  ORGANISM = 'ORGANISM'
}

export enum MaterialStatus {
  ACTIVE = 'ACTIVE',
  QUARANTINED = 'QUARANTINED',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED'
}

export enum CredentialType {
  IDENTITY = 'IDENTITY',
  QC_MYCO = 'QC_MYCO',
  QC_STR = 'QC_STR',
  TRANSFER = 'TRANSFER',
  USAGE_RIGHTS = 'USAGE_RIGHTS',
  PASSAGE = 'PASSAGE'
}

export interface ArtifactRef {
  cid: string;
  hash: string;
  filename?: string;
  contentType?: string;
}

export interface Material {
  materialId: string;
  materialType: MaterialType;
  metadataHash: string;
  ownerOrg: string;
  status: MaterialStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  materialId: string;
  credentialId: string;
  credentialType: CredentialType;
  commitmentHash: string;
  issuerId: string;
  issuedAt: string;
  validUntil: string;
  artifactRefs: ArtifactRef[];
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

export interface PolicyRule {
  policyId: string;
  materialType: MaterialType;
  requiredCredentials: CredentialType[];
  qcExpiryDays: number;
  requireContinuousTransferChain: boolean;
  customRules?: Record<string, unknown>;
}

export interface VerificationResult {
  pass: boolean;
  materialId: string;
  verifiedAt: string;
  reasons: VerificationReason[];
  credentialStatus: CredentialStatus[];
  transferChainValid: boolean;
}

export interface VerificationReason {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
}

export interface CredentialStatus {
  credentialType: CredentialType;
  present: boolean;
  valid: boolean;
  expiredAt?: string;
  issuerId?: string;
}

export interface MaterialHistory {
  materialId: string;
  events: HistoryEvent[];
}

export interface HistoryEvent {
  eventType: 'REGISTERED' | 'CREDENTIAL_ISSUED' | 'TRANSFERRED' | 'STATUS_CHANGED' | 'CREDENTIAL_REVOKED';
  timestamp: string;
  actor: string;
  details: Record<string, unknown>;
  txId: string;
}
