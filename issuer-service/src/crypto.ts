/**
 * Cryptographic utilities for credential signing and hashing
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { ec as EC } from 'elliptic';
import canonicalize from 'canonicalize';

const ec = new EC('secp256k1');

/**
 * Compute SHA-256 hash of data
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-256 hash of a file
 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Canonicalize JSON for consistent hashing
 * - Sorts keys alphabetically
 * - Removes whitespace
 * - Ensures deterministic output
 */
export function canonicalizeJson(obj: unknown): string {
  const canonical = canonicalize(obj);
  if (!canonical) {
    throw new Error('Failed to canonicalize JSON');
  }
  return canonical;
}

/**
 * Compute commitment hash for a credential payload
 */
export function computeCommitmentHash(payload: unknown): string {
  const canonical = canonicalizeJson(payload);
  return sha256(canonical);
}

/**
 * Calculate Shannon entropy of a hex string
 * Returns value between 0 (no entropy) and 4 (maximum entropy for hex)
 */
function calculateEntropy(hexString: string): number {
  const freq: Record<string, number> = {};
  for (const char of hexString) {
    freq[char] = (freq[char] || 0) + 1;
  }

  let entropy = 0;
  const len = hexString.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Load private key from PEM file with entropy validation
 */
export function loadPrivateKey(keyPath: string): EC.KeyPair {
  const keyPem = fs.readFileSync(keyPath, 'utf-8');
  // Extract the key from PEM format
  const keyMatch = keyPem.match(/-----BEGIN.*PRIVATE KEY-----\n([\s\S]*?)\n-----END.*PRIVATE KEY-----/);
  if (!keyMatch) {
    throw new Error('Invalid private key PEM format');
  }
  const keyBase64 = keyMatch[1].replace(/\n/g, '');
  const keyBuffer = Buffer.from(keyBase64, 'base64');

  // For EC keys, extract the private key bytes
  // This is simplified - in production use proper ASN.1 parsing
  const keyHex = keyBuffer.slice(-32).toString('hex');

  // SECURITY: Validate key entropy to prevent weak/predictable keys
  const entropy = calculateEntropy(keyHex);
  const MIN_ENTROPY = 4.0;  // Hex string should have ~4.0 bits of entropy (well-distributed)

  if (entropy < MIN_ENTROPY) {
    throw new Error(
      `❌ SECURITY ERROR: Private key has low entropy (${entropy.toFixed(2)} < ${MIN_ENTROPY}).\n\n` +
      `This indicates a weak or predictable key that could be compromised.\n` +
      `Generate a new secure key using the key generation tool:\n` +
      `  npm run generate-keypair -- OrgName ./keys\n\n` +
      `Never use keys derived from passwords or predictable values.`
    );
  }

  return ec.keyFromPrivate(keyHex);
}

/**
 * Generate a new key pair
 */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const keyPair = ec.genKeyPair();
  return {
    privateKey: keyPair.getPrivate('hex'),
    publicKey: keyPair.getPublic('hex')
  };
}

/**
 * Sign data with private key
 */
export function sign(data: string, privateKey: EC.KeyPair): string {
  const hash = sha256(data);
  const signature = privateKey.sign(hash);
  return signature.toDER('hex');
}

/**
 * Sign a credential payload
 */
export function signCredential(payload: unknown, privateKey: EC.KeyPair): string {
  const canonical = canonicalizeJson(payload);
  return sign(canonical, privateKey);
}

/**
 * Verify signature
 */
export function verify(data: string, signature: string, publicKey: string): boolean {
  const hash = sha256(data);
  const key = ec.keyFromPublic(publicKey, 'hex');
  return key.verify(hash, signature);
}

/**
 * Verify credential signature
 */
export function verifyCredential(payload: unknown, signature: string, publicKey: string): boolean {
  const canonical = canonicalizeJson(payload);
  return verify(canonical, signature, publicKey);
}

/**
 * @deprecated SECURITY WARNING: This function generates PREDICTABLE keys and should
 * NEVER be used in production. Keys generated from predictable seeds (like organization
 * names) can be easily computed by attackers, allowing them to forge credentials.
 *
 * Use generateKeyPair() instead for secure key generation.
 *
 * This function will be REMOVED in v3.0.0.
 *
 * @param seed - DO NOT USE IN PRODUCTION
 * @returns KeyPair - INSECURE, PREDICTABLE
 */
export function keyFromSeed(seed: string): EC.KeyPair {
  console.error('');
  console.error('⚠️  SECURITY WARNING: keyFromSeed() is deprecated and INSECURE!');
  console.error('⚠️  This function generates PREDICTABLE keys that can be computed by attackers.');
  console.error('⚠️  Use generateKeyPair() instead for secure key generation.');
  console.error('⚠️  This function will be removed in v3.0.0.');
  console.error('');

  // Check if being called in production
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '❌ SECURITY ERROR: keyFromSeed() is FORBIDDEN in production!\n\n' +
      'This function generates predictable keys that compromise security.\n' +
      'Generate secure keys using: npm run generate-keypair'
    );
  }

  const seedHash = sha256(seed);
  return ec.keyFromPrivate(seedHash);
}
