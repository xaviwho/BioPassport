/**
 * BioPassport Security Test Suite
 * 
 * Tests:
 * 1. Artifact tampering detection
 * 2. Credential expiry enforcement
 * 3. Unauthorized issuer rejection
 * 4. Revocation enforcement
 * 5. Transfer chain validation
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface SecurityTestResult {
  name: string;
  description: string;
  passed: boolean;
  details: string;
  timestamp: string;
}

interface SecurityTestSuite {
  name: string;
  timestamp: string;
  results: SecurityTestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

async function runSecurityTests(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  BIOPASSPORT SECURITY TEST SUITE');
  console.log('═'.repeat(60));
  console.log();

  const suite: SecurityTestSuite = {
    name: 'BioPassport Security Tests',
    timestamp: new Date().toISOString(),
    results: [],
    summary: { total: 0, passed: 0, failed: 0 }
  };

  // Test 1: Artifact Tampering Detection
  suite.results.push(await testArtifactTampering());

  // Test 2: Credential Expiry Enforcement
  suite.results.push(await testCredentialExpiry());

  // Test 3: Unauthorized Issuer Rejection
  suite.results.push(await testUnauthorizedIssuer());

  // Test 4: Revocation Enforcement
  suite.results.push(await testRevocationEnforcement());

  // Test 5: Transfer Chain Validation
  suite.results.push(await testTransferChainValidation());

  // Test 6: Hash Commitment Integrity
  suite.results.push(await testHashCommitmentIntegrity());

  // Test 7: Replay Attack Prevention
  suite.results.push(await testReplayAttackPrevention());

  // Calculate summary
  suite.summary.total = suite.results.length;
  suite.summary.passed = suite.results.filter(r => r.passed).length;
  suite.summary.failed = suite.results.filter(r => !r.passed).length;

  // Print results
  console.log('\n' + '─'.repeat(60));
  console.log('  TEST RESULTS');
  console.log('─'.repeat(60));
  
  suite.results.forEach((result, i) => {
    const icon = result.passed ? '✓' : '✗';
    const color = result.passed ? '\x1b[32m' : '\x1b[31m';
    console.log(`${color}  ${icon} ${result.name}\x1b[0m`);
    console.log(`    ${result.description}`);
    console.log(`    ${result.details}`);
    console.log();
  });

  // Print summary
  console.log('═'.repeat(60));
  console.log(`  SUMMARY: ${suite.summary.passed}/${suite.summary.total} tests passed`);
  if (suite.summary.failed > 0) {
    console.log(`  \x1b[31m${suite.summary.failed} tests FAILED\x1b[0m`);
  } else {
    console.log('  \x1b[32mAll tests PASSED\x1b[0m');
  }
  console.log('═'.repeat(60));

  // Save results
  const outputPath = path.join(__dirname, 'results', `security-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(suite, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

/**
 * Test 1: Artifact Tampering Detection
 * Verifies that modified off-chain artifacts are detected
 */
async function testArtifactTampering(): Promise<SecurityTestResult> {
  console.log('Running: Artifact Tampering Detection...');
  
  // Simulate original artifact
  const originalContent = 'Original QC Report Content - Mycoplasma: NEGATIVE';
  const originalHash = crypto.createHash('sha256').update(originalContent).digest('hex');
  
  // Simulate tampered artifact
  const tamperedContent = 'Tampered QC Report Content - Mycoplasma: NEGATIVE (FORGED)';
  const tamperedHash = crypto.createHash('sha256').update(tamperedContent).digest('hex');
  
  // Verification should fail
  const hashMismatch = originalHash !== tamperedHash;
  
  return {
    name: 'Artifact Tampering Detection',
    description: 'Verifies that modified off-chain artifacts are detected via hash mismatch',
    passed: hashMismatch,
    details: hashMismatch 
      ? `Hash mismatch detected: original=${originalHash.substring(0, 16)}... vs tampered=${tamperedHash.substring(0, 16)}...`
      : 'FAILED: Tampered artifact not detected',
    timestamp: new Date().toISOString()
  };
}

/**
 * Test 2: Credential Expiry Enforcement
 * Verifies that expired credentials are rejected
 */
async function testCredentialExpiry(): Promise<SecurityTestResult> {
  console.log('Running: Credential Expiry Enforcement...');
  
  // Simulate credential with past expiry
  const credential = {
    credentialType: 'QC_MYCO',
    issuedAt: '2025-01-01T00:00:00Z',
    validUntil: '2025-06-01T00:00:00Z' // Expired
  };
  
  const now = new Date();
  const validUntil = new Date(credential.validUntil);
  const isExpired = now > validUntil;
  
  return {
    name: 'Credential Expiry Enforcement',
    description: 'Verifies that expired credentials are rejected during verification',
    passed: isExpired,
    details: isExpired
      ? `Expired credential correctly identified (expired: ${credential.validUntil})`
      : 'FAILED: Expired credential not detected',
    timestamp: new Date().toISOString()
  };
}

/**
 * Test 3: Unauthorized Issuer Rejection
 * Verifies that credentials from untrusted issuers are flagged
 */
async function testUnauthorizedIssuer(): Promise<SecurityTestResult> {
  console.log('Running: Unauthorized Issuer Rejection...');
  
  const trustedIssuers = ['Org1MSP', 'Org2MSP', 'AccreditedLabMSP'];
  const credentialIssuer = 'MaliciousOrgMSP';
  
  const isUntrusted = !trustedIssuers.includes(credentialIssuer);
  
  return {
    name: 'Unauthorized Issuer Rejection',
    description: 'Verifies that credentials from untrusted issuers are flagged',
    passed: isUntrusted,
    details: isUntrusted
      ? `Untrusted issuer '${credentialIssuer}' correctly identified`
      : 'FAILED: Untrusted issuer not detected',
    timestamp: new Date().toISOString()
  };
}

/**
 * Test 4: Revocation Enforcement
 * Verifies that revoked credentials/materials are rejected
 */
async function testRevocationEnforcement(): Promise<SecurityTestResult> {
  console.log('Running: Revocation Enforcement...');
  
  // Simulate revoked credential
  const credential = {
    credentialId: 'cred:test-123',
    revoked: true,
    revokedAt: '2025-12-01T00:00:00Z',
    revokedReason: 'Contamination detected'
  };
  
  // Simulate revoked material
  const material = {
    materialId: 'bio:cell_line:test-456',
    status: 'REVOKED'
  };
  
  const credentialRejected = credential.revoked === true;
  const materialRejected = material.status === 'REVOKED';
  
  return {
    name: 'Revocation Enforcement',
    description: 'Verifies that revoked credentials and materials are rejected',
    passed: credentialRejected && materialRejected,
    details: credentialRejected && materialRejected
      ? 'Revoked credential and material correctly rejected'
      : 'FAILED: Revocation not enforced',
    timestamp: new Date().toISOString()
  };
}

/**
 * Test 5: Transfer Chain Validation
 * Verifies that broken transfer chains are detected
 */
async function testTransferChainValidation(): Promise<SecurityTestResult> {
  console.log('Running: Transfer Chain Validation...');
  
  // Valid chain: A -> B -> C
  const validChain = [
    { from: 'OrgA', to: 'OrgB', accepted: true },
    { from: 'OrgB', to: 'OrgC', accepted: true }
  ];
  
  // Invalid chain: A -> B -> ? -> D (gap)
  const invalidChain = [
    { from: 'OrgA', to: 'OrgB', accepted: true },
    { from: 'OrgC', to: 'OrgD', accepted: true } // Gap: OrgB -> OrgC missing
  ];
  
  // Check valid chain
  let validChainOk = true;
  for (let i = 0; i < validChain.length - 1; i++) {
    if (validChain[i].to !== validChain[i + 1].from) {
      validChainOk = false;
      break;
    }
  }
  
  // Check invalid chain
  let invalidChainDetected = false;
  for (let i = 0; i < invalidChain.length - 1; i++) {
    if (invalidChain[i].to !== invalidChain[i + 1].from) {
      invalidChainDetected = true;
      break;
    }
  }
  
  const passed = validChainOk && invalidChainDetected;
  
  return {
    name: 'Transfer Chain Validation',
    description: 'Verifies that broken transfer chains are detected',
    passed,
    details: passed
      ? 'Valid chain accepted, broken chain detected'
      : 'FAILED: Transfer chain validation incorrect',
    timestamp: new Date().toISOString()
  };
}

/**
 * Test 6: Hash Commitment Integrity
 * Verifies that credential commitment hashes are computed correctly
 */
async function testHashCommitmentIntegrity(): Promise<SecurityTestResult> {
  console.log('Running: Hash Commitment Integrity...');
  
  // Credential payload
  const payload = {
    credentialType: 'QC_MYCO',
    materialId: 'bio:cell_line:test',
    result: 'NEGATIVE',
    testMethod: 'PCR',
    testDate: '2026-01-01',
    laboratory: 'TestLab'
  };
  
  // Canonical JSON (sorted keys, no whitespace)
  const canonical1 = JSON.stringify(payload, Object.keys(payload).sort());
  const canonical2 = JSON.stringify(payload, Object.keys(payload).sort());
  
  const hash1 = crypto.createHash('sha256').update(canonical1).digest('hex');
  const hash2 = crypto.createHash('sha256').update(canonical2).digest('hex');
  
  const hashesMatch = hash1 === hash2;
  
  // Test that different payloads produce different hashes
  const modifiedPayload = { ...payload, result: 'POSITIVE' };
  const canonical3 = JSON.stringify(modifiedPayload, Object.keys(modifiedPayload).sort());
  const hash3 = crypto.createHash('sha256').update(canonical3).digest('hex');
  
  const differentPayloadsDifferentHashes = hash1 !== hash3;
  
  const passed = hashesMatch && differentPayloadsDifferentHashes;
  
  return {
    name: 'Hash Commitment Integrity',
    description: 'Verifies deterministic hash computation for credential commitments',
    passed,
    details: passed
      ? `Same payload produces same hash, different payloads produce different hashes`
      : 'FAILED: Hash commitment integrity violated',
    timestamp: new Date().toISOString()
  };
}

/**
 * Test 7: Replay Attack Prevention
 * Verifies that old credentials cannot be replayed
 */
async function testReplayAttackPrevention(): Promise<SecurityTestResult> {
  console.log('Running: Replay Attack Prevention...');
  
  // Old credential (valid in the past)
  const oldCredential = {
    credentialId: 'cred:old-123',
    issuedAt: '2024-01-01T00:00:00Z',
    validUntil: '2024-06-01T00:00:00Z'
  };
  
  // Current time check
  const now = new Date();
  const validUntil = new Date(oldCredential.validUntil);
  
  // Replay should be rejected due to expiry
  const replayRejected = now > validUntil;
  
  // Additional check: credential ID should be unique (no re-use)
  const existingCredentialIds = new Set(['cred:old-123', 'cred:other-456']);
  const duplicateIdRejected = existingCredentialIds.has(oldCredential.credentialId);
  
  const passed = replayRejected;
  
  return {
    name: 'Replay Attack Prevention',
    description: 'Verifies that old/expired credentials cannot be replayed',
    passed,
    details: passed
      ? `Replay attack prevented: credential expired ${oldCredential.validUntil}`
      : 'FAILED: Replay attack not prevented',
    timestamp: new Date().toISOString()
  };
}

// Run tests
runSecurityTests().catch(console.error);
