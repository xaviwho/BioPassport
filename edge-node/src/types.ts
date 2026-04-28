export type CredentialType = 'IDENTITY' | 'QC_MYCO' | 'USAGE_RIGHTS';

export interface AttestationPayload {
  deviceId: string;
  instrumentId: string;
  materialId: string;
  materialType: 'CELL_LINE' | 'PLASMID';
  credentialType: CredentialType;
  rawArtifactHash: string;
  captureTs: number;
  freshnessBeacon?: string;
}

export interface SignedAttestation {
  payload: AttestationPayload;
  payloadCanonical: string;
  attestationHash: string;
  signature: string;
  signerAddress: string;
}

export interface Signer {
  getDeviceId(): Promise<string>;
  getDeviceAddress(): Promise<string>;
  signDigest(digest: Uint8Array): Promise<string>;
}
