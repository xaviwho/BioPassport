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
 * Load private key from PEM file
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
 * Generate a deterministic key from a seed (for testing)
 */
export function keyFromSeed(seed: string): EC.KeyPair {
  const seedHash = sha256(seed);
  return ec.keyFromPrivate(seedHash);
}
