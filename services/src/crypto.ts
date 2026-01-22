/**
 * BioPassport V2 Cryptographic Utilities
 * Hashing functions for credentials and evidence
 */

import * as crypto from 'crypto';
import { ethers } from 'ethers';

/**
 * Canonical JSON stringification (deterministic key ordering)
 */
export function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(key => `${JSON.stringify(key)}:${canonicalize(obj[key])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute credential hash from payload
 * Hash the canonicalized JSON using keccak256
 */
export function computeCredentialHash(payload: any): string {
  const canonical = canonicalize(payload);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

/**
 * Compute evidence root from list of file hashes
 * Sort hashes, concatenate, then keccak256
 */
export function computeEvidenceRoot(fileHashes: string[]): string {
  if (fileHashes.length === 0) {
    return ethers.ZeroHash;
  }
  
  // Normalize: remove 0x prefix if present, lowercase
  const normalized = fileHashes
    .map(h => h.replace(/^0x/i, '').toLowerCase())
    .sort();
  
  // Concatenate sorted hashes
  const concatenated = normalized.join('');
  
  // Hash the concatenation
  return ethers.keccak256('0x' + concatenated);
}

/**
 * Compute SHA-256 hash of a buffer
 */
export function sha256(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data;
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compute SHA-256 hash of a file
 */
export async function sha256File(filePath: string): Promise<string> {
  const fs = await import('fs');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data: Buffer) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Verify a credential hash matches its payload
 */
export function verifyCredentialHash(payload: any, expectedHash: string): boolean {
  const computed = computeCredentialHash(payload);
  return computed.toLowerCase() === expectedHash.toLowerCase();
}

/**
 * Verify evidence root matches file hashes
 */
export function verifyEvidenceRoot(fileHashes: string[], expectedRoot: string): boolean {
  const computed = computeEvidenceRoot(fileHashes);
  return computed.toLowerCase() === expectedRoot.toLowerCase();
}

/**
 * Generate a random bytes32 hash (for testing)
 */
export function randomHash(): string {
  return '0x' + crypto.randomBytes(32).toString('hex');
}

/**
 * Hash an asset ID to bytes32
 */
export function hashAssetId(assetId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(assetId));
}
