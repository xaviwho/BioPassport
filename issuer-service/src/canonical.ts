/**
 * Canonical JSON Hashing
 * 
 * Ensures deterministic hashing across different machines by:
 * 1. Sorting object keys alphabetically (recursive)
 * 2. Using consistent encoding (UTF-8)
 * 3. No whitespace dependence
 * 4. Consistent number formatting
 */

import * as crypto from 'crypto';

/**
 * Canonicalize a JSON object for deterministic hashing
 * Rules:
 * - Object keys sorted alphabetically
 * - No whitespace between tokens
 * - Numbers: no leading zeros, no trailing zeros after decimal
 * - Strings: UTF-8 encoded with minimal escaping
 * - Arrays: preserve order
 * - null, true, false: lowercase literals
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

/**
 * Recursively sort object keys
 */
function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return null;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    
    for (const key of keys) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    
    return sorted;
  }
  
  // Primitives (string, number, boolean)
  return obj;
}

/**
 * Compute SHA-256 hash of canonical JSON
 */
export function canonicalHash(obj: unknown): string {
  const canonical = canonicalize(obj);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify that a hash matches the canonical form of an object
 */
export function verifyCanonicalHash(obj: unknown, expectedHash: string): boolean {
  const actualHash = canonicalHash(obj);
  return actualHash === expectedHash;
}

/**
 * Create a commitment for a credential
 * Returns both the canonical JSON and its hash
 */
export function createCommitment(credential: Record<string, unknown>): {
  canonical: string;
  commitmentHash: string;
} {
  const canonical = canonicalize(credential);
  const commitmentHash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  
  return { canonical, commitmentHash };
}

/**
 * Verify a credential against its commitment hash
 */
export function verifyCommitment(
  credential: Record<string, unknown>,
  commitmentHash: string
): { valid: boolean; computedHash: string } {
  const computedHash = canonicalHash(credential);
  return {
    valid: computedHash === commitmentHash,
    computedHash
  };
}
