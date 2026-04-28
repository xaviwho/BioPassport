import { ec as EC } from 'elliptic';
import { canonicalizeJson, computeCommitmentHash } from '../../../issuer-service/src/crypto';

const ec = new EC('secp256k1');

function issuerPrivateKeyHex(): string {
  return (process.env.ISSUER_PRIV ?? `0x${'cd'.repeat(32)}`).replace(/^0x/, '');
}

export function canonicalizePayload(payload: unknown): string {
  return canonicalizeJson(payload);
}

export function computeCommitmentBuffer(payload: unknown): Buffer {
  return Buffer.from(computeCommitmentHash(payload), 'hex');
}

export function signCanonical(payload: unknown): {
  canonical: string;
  commitment: Buffer;
  signature: Buffer;
  publicKey: string;
} {
  const canonical = canonicalizePayload(payload);
  const commitment = computeCommitmentBuffer(payload);
  const keyPair = ec.keyFromPrivate(issuerPrivateKeyHex());
  const signature = Buffer.from(keyPair.sign(commitment).toDER());

  return {
    canonical,
    commitment,
    signature,
    publicKey: keyPair.getPublic('hex'),
  };
}

export function verifyCanonical(payload: unknown, signature: Buffer, publicKey: string): boolean {
  const canonical = canonicalizePayload(payload);
  const commitment = Buffer.from(computeCommitmentHash(JSON.parse(canonical)), 'hex');
  const keyPair = ec.keyFromPublic(publicKey, 'hex');
  return keyPair.verify(commitment, signature);
}
