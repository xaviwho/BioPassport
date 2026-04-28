import { ethers } from 'ethers';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { AttestationPayload, CredentialType, SignedAttestation, Signer } from './types.js';

const require = createRequire(import.meta.url);
const canonicalize = require('canonicalize') as (input: unknown) => string | undefined;

const CRED_TYPE_INDEX: Record<CredentialType, number> = {
  IDENTITY: 0,
  QC_MYCO: 1,
  USAGE_RIGHTS: 2,
};

export async function sha256File(filePath: string): Promise<string> {
  const fs = await import('node:fs');
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve('0x' + h.digest('hex')));
    s.on('error', reject);
  });
}

export function buildAttestationHash(
  p: AttestationPayload,
  artifactHashBytes32: string,
  commitmentHashBytes32: string
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ['bytes32', 'string', 'uint8', 'bytes32', 'bytes32', 'uint256'],
    [
      p.deviceId,
      p.materialId,
      CRED_TYPE_INDEX[p.credentialType],
      commitmentHashBytes32,
      artifactHashBytes32,
      p.captureTs,
    ]
  );
  return ethers.keccak256(encoded);
}

export function commitmentHashForPayload(payload: AttestationPayload): string {
  const payloadCanonical = canonicalize(payload)!;
  return ethers.sha256(ethers.toUtf8Bytes(payloadCanonical));
}

export async function signAttestation(
  signer: Signer,
  payload: AttestationPayload,
  artifactHashBytes32: string,
  commitmentHashBytes32: string
): Promise<SignedAttestation> {
  const payloadCanonical = canonicalize(payload)!;
  const rawDigest = buildAttestationHash(payload, artifactHashBytes32, commitmentHashBytes32);
  const prefixed = ethers.solidityPackedKeccak256(
    ['string', 'bytes32'],
    ['\x19Ethereum Signed Message:\n32', rawDigest]
  );

  const signature = await signer.signDigest(ethers.getBytes(prefixed));
  const signerAddress = await signer.getDeviceAddress();

  return {
    payload,
    payloadCanonical,
    attestationHash: rawDigest,
    signature,
    signerAddress,
  };
}
