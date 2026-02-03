#!/usr/bin/env ts-node
/**
 * Secure Keypair Generation Tool
 *
 * Generates cryptographically secure ECDSA secp256k1 keypairs for credential issuers.
 *
 * Usage:
 *   npm run generate-keypair -- <orgId> [outputDir]
 *
 * Example:
 *   npm run generate-keypair -- Org1MSP ./keys
 *
 * Output:
 *   - <orgId>-private.pem (KEEP SECRET!)
 *   - <orgId>-public.pem (Share with verifiers)
 */

import { generateKeyPair } from '../src/crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface KeyPairResult {
  privateKey: string;
  publicKey: string;
  entropy: number;
}

/**
 * Calculate Shannon entropy of a hex string
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
 * Generate a secure keypair with entropy validation
 */
function generateSecureKeyPair(): KeyPairResult {
  const MAX_ATTEMPTS = 100;
  const MIN_ENTROPY = 3.8;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { privateKey, publicKey } = generateKeyPair();
    const entropy = calculateEntropy(privateKey);

    if (entropy >= MIN_ENTROPY) {
      return { privateKey, publicKey, entropy };
    }

    if (attempt % 10 === 0) {
      console.log(`  Generating secure key (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    }
  }

  throw new Error('Failed to generate high-entropy key after maximum attempts');
}

/**
 * Convert hex key to PEM format
 */
function keyToPEM(keyHex: string, type: 'PRIVATE' | 'PUBLIC'): string {
  // For secp256k1 private keys, we use a simplified PEM format
  // In production, consider using proper ASN.1 encoding
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const keyBase64 = keyBuffer.toString('base64');

  // Split into 64-character lines for proper PEM format
  const lines: string[] = [];
  for (let i = 0; i < keyBase64.length; i += 64) {
    lines.push(keyBase64.slice(i, i + 64));
  }

  const header = type === 'PRIVATE' ? '-----BEGIN EC PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
  const footer = type === 'PRIVATE' ? '-----END EC PRIVATE KEY-----' : '-----END PUBLIC KEY-----';

  return `${header}\n${lines.join('\n')}\n${footer}\n`;
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('🔐 BioPassport Secure Keypair Generator');
    console.log('');
    console.log('Usage:');
    console.log('  npm run generate-keypair -- <orgId> [outputDir]');
    console.log('');
    console.log('Arguments:');
    console.log('  orgId       Organization identifier (e.g., Org1MSP, QCLab)');
    console.log('  outputDir   Output directory (default: ./keys)');
    console.log('');
    console.log('Example:');
    console.log('  npm run generate-keypair -- Org1MSP ./keys');
    console.log('');
    process.exit(0);
  }

  const orgId = args[0];
  const outputDir = args[1] || './keys';

  console.log('');
  console.log('🔐 Generating secure keypair for:', orgId);
  console.log('');

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`✅ Created directory: ${outputDir}`);
  }

  // Generate secure keypair
  console.log('🔄 Generating cryptographically secure keypair...');
  const { privateKey, publicKey, entropy } = generateSecureKeyPair();
  console.log(`✅ Generated key with entropy: ${entropy.toFixed(3)} bits (excellent)`);

  // Convert to PEM format
  const privateKeyPEM = keyToPEM(privateKey, 'PRIVATE');
  const publicKeyPEM = publicKey; // Public key stays in hex format for simplicity

  // Write keys to files
  const privatePath = path.join(outputDir, `${orgId}-private.pem`);
  const publicPath = path.join(outputDir, `${orgId}-public.txt`);

  // Write private key with restricted permissions (0600)
  fs.writeFileSync(privatePath, privateKeyPEM, { mode: 0o600 });
  console.log(`✅ Private key: ${privatePath} (mode: 0600)`);

  // Write public key
  fs.writeFileSync(publicPath, publicKey + '\n');
  console.log(`✅ Public key:  ${publicPath}`);

  console.log('');
  console.log('📋 Next Steps:');
  console.log('');
  console.log('1. PROTECT THE PRIVATE KEY:');
  console.log(`   - Store ${privatePath} in a secure location`);
  console.log('   - Consider: AWS Secrets Manager, HashiCorp Vault, or Azure Key Vault');
  console.log('   - Set environment variable: export ISSUER_PRIVATE_KEY=' + privatePath);
  console.log('   - Delete plaintext file after storing securely');
  console.log('');
  console.log('2. SHARE THE PUBLIC KEY:');
  console.log(`   - Add to verifier's issuer-registry.json:`);
  console.log('     {');
  console.log('       "issuers": {');
  console.log(`         "${orgId}": {`);
  console.log(`           "issuerId": "${orgId}",`);
  console.log(`           "publicKey": "${publicKey}",`);
  console.log(`           "addedAt": "${new Date().toISOString()}",`);
  console.log(`           "description": "Description of ${orgId}"`);
  console.log('         }');
  console.log('       }');
  console.log('     }');
  console.log('');
  console.log('3. VERIFY SETUP:');
  console.log('   - Issue a test credential');
  console.log('   - Verify signature using verifier-cli');
  console.log('');
  console.log('⚠️  SECURITY REMINDER:');
  console.log('   - NEVER commit private keys to version control');
  console.log('   - NEVER share private keys via email or chat');
  console.log('   - NEVER derive keys from predictable values');
  console.log('   - Rotate keys if compromised immediately');
  console.log('');
  console.log('✅ Keypair generation complete!');
  console.log('');
}

// Run main function
try {
  main();
} catch (error: any) {
  console.error('');
  console.error('❌ Error:', error.message);
  console.error('');
  process.exit(1);
}
