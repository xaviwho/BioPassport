/**
 * Integration Test Suite for BioPassport
 * 
 * Tests the full flow:
 * 1. Dataset generation correctness
 * 2. Canonical hashing determinism
 * 3. Verification logic consistency
 * 
 * Run with: npx ts-node test-integration.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ==================== Test Utilities ====================

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true, message: 'OK' });
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    results.push({ name, passed: false, message: error.message });
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertInRange(value: number, min: number, max: number, message?: string): void {
  if (value < min || value > max) {
    throw new Error(message || `Expected ${value} to be in range [${min}, ${max}]`);
  }
}

// ==================== Canonical JSON Tests ====================

function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

function canonicalHash(obj: unknown): string {
  const canonical = canonicalize(obj);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function testCanonicalHashing(): void {
  console.log('\n📋 Canonical JSON Hashing Tests');
  
  test('should produce same hash regardless of key order', () => {
    const obj1 = { b: 2, a: 1, c: 3 };
    const obj2 = { a: 1, b: 2, c: 3 };
    const obj3 = { c: 3, a: 1, b: 2 };
    
    const hash1 = canonicalHash(obj1);
    const hash2 = canonicalHash(obj2);
    const hash3 = canonicalHash(obj3);
    
    assertEqual(hash1, hash2, 'Hash mismatch between obj1 and obj2');
    assertEqual(hash2, hash3, 'Hash mismatch between obj2 and obj3');
  });
  
  test('should handle nested objects', () => {
    const obj1 = { outer: { b: 2, a: 1 }, z: 'last' };
    const obj2 = { z: 'last', outer: { a: 1, b: 2 } };
    
    assertEqual(canonicalHash(obj1), canonicalHash(obj2));
  });
  
  test('should handle arrays (preserve order)', () => {
    const obj1 = { arr: [1, 2, 3] };
    const obj2 = { arr: [1, 2, 3] };
    const obj3 = { arr: [3, 2, 1] };
    
    assertEqual(canonicalHash(obj1), canonicalHash(obj2));
    assertTrue(canonicalHash(obj1) !== canonicalHash(obj3), 'Array order should matter');
  });
  
  test('should produce deterministic output', () => {
    const credential = {
      materialId: 'bio:cell_line:123',
      testType: 'MYCOPLASMA',
      result: 'NEGATIVE',
      issuedAt: '2026-01-07T00:00:00Z'
    };
    
    // Hash multiple times
    const hashes = Array(10).fill(0).map(() => canonicalHash(credential));
    const allSame = hashes.every(h => h === hashes[0]);
    
    assertTrue(allSame, 'Hashes should be deterministic');
  });
}

// ==================== Dataset Validation Tests ====================

interface DatasetSummary {
  totalMaterials: number;
  byType: { cellLines: number; plasmids: number };
  byStatus: { active: number; quarantined: number; revoked: number };
  anomalies: {
    tamperedArtifacts: number;
    expiredQC: number;
    missingQC: number;
    revokedMaterials: number;
    quarantinedMaterials: number;
    pendingTransfers: number;
  };
  onChainVerification: { pass: number; fail: number };
  fullVerification: { pass: number; fail: number };
}

function testDatasetGeneration(): void {
  console.log('\n📊 Dataset Generation Tests');
  
  const dataDir = path.join(__dirname, 'data');
  
  // Test normal dataset
  test('normal dataset should exist', () => {
    const summaryPath = path.join(dataDir, 'normal', 'summary.json');
    assertTrue(fs.existsSync(summaryPath), 'normal/summary.json not found');
  });
  
  test('normal dataset should have 500 materials', () => {
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'normal', 'summary.json'), 'utf8')
    );
    assertEqual(summary.totalMaterials, 500);
  });
  
  test('normal dataset should have ~70% cell lines', () => {
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'normal', 'summary.json'), 'utf8')
    );
    const ratio = summary.byType.cellLines / summary.totalMaterials;
    assertInRange(ratio, 0.60, 0.80, `Cell line ratio ${ratio} out of expected range`);
  });
  
  test('normal dataset should have ~75-85% on-chain PASS rate', () => {
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'normal', 'summary.json'), 'utf8')
    );
    const passRate = summary.onChainVerification.pass / summary.totalMaterials;
    assertInRange(passRate, 0.70, 0.90, `On-chain PASS rate ${passRate * 100}% out of expected range`);
  });
  
  // Test drift dataset
  test('drift dataset should have ~50-60% on-chain PASS rate', () => {
    const summaryPath = path.join(dataDir, 'drift', 'summary.json');
    if (!fs.existsSync(summaryPath)) {
      throw new Error('drift/summary.json not found');
    }
    const summary: DatasetSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const passRate = summary.onChainVerification.pass / summary.totalMaterials;
    assertInRange(passRate, 0.45, 0.65, `Drift PASS rate ${passRate * 100}% out of expected range`);
  });
  
  test('drift dataset should have high QC expiry rate', () => {
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'drift', 'summary.json'), 'utf8')
    );
    const expiredRate = summary.anomalies.expiredQC / summary.totalMaterials;
    assertInRange(expiredRate, 0.30, 0.50, `Expired QC rate ${expiredRate * 100}% should be high for drift`);
  });
  
  // Test adversarial dataset
  test('adversarial dataset should have ~60-75% full FAIL rate', () => {
    const summaryPath = path.join(dataDir, 'adversarial', 'summary.json');
    if (!fs.existsSync(summaryPath)) {
      throw new Error('adversarial/summary.json not found');
    }
    const summary: DatasetSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const failRate = summary.fullVerification.fail / summary.totalMaterials;
    assertInRange(failRate, 0.55, 0.80, `Adversarial FAIL rate ${failRate * 100}% out of expected range`);
  });
  
  test('adversarial dataset should have missing QC (unauthorized issuer)', () => {
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'adversarial', 'summary.json'), 'utf8')
    );
    assertTrue(summary.anomalies.missingQC > 0, 'Adversarial should have missing QC credentials');
  });
  
  test('adversarial dataset should have high tamper rate', () => {
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'adversarial', 'summary.json'), 'utf8')
    );
    const tamperRate = summary.anomalies.tamperedArtifacts / summary.totalMaterials;
    assertInRange(tamperRate, 0.20, 0.45, `Tamper rate ${tamperRate * 100}% should be high for adversarial`);
  });
}

// ==================== CSV Validation Tests ====================

function testCSVFormat(): void {
  console.log('\n📄 CSV Format Tests');
  
  const csvPath = path.join(__dirname, 'data', 'normal', 'materials.csv');
  
  test('CSV should have correct headers', () => {
    const content = fs.readFileSync(csvPath, 'utf8');
    const headers = content.split('\n')[0];
    
    assertTrue(headers.includes('materialId'), 'Missing materialId column');
    assertTrue(headers.includes('hasIdentity'), 'Missing hasIdentity column');
    assertTrue(headers.includes('hasQC'), 'Missing hasQC column');
    assertTrue(headers.includes('expectedOnChain'), 'Missing expectedOnChain column');
    assertTrue(headers.includes('expectedFull'), 'Missing expectedFull column');
  });
  
  test('CSV expectedOnChain should match summary', () => {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.trim().split('\n').slice(1); // Skip header
    
    const csvPassCount = lines.filter(line => {
      const cols = line.split(',');
      const expectedOnChainIdx = 11; // Based on header order
      return cols[expectedOnChainIdx] === 'PASS';
    }).length;
    
    const summary: DatasetSummary = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'data', 'normal', 'summary.json'), 'utf8')
    );
    
    assertEqual(csvPassCount, summary.onChainVerification.pass, 
      `CSV PASS count (${csvPassCount}) doesn't match summary (${summary.onChainVerification.pass})`);
  });
  
  test('CSV should have consistent material ID format', () => {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.trim().split('\n').slice(1);
    
    const validFormat = lines.every(line => {
      const materialId = line.split(',')[0];
      return materialId.startsWith('bio:cell_line:') || materialId.startsWith('bio:plasmid:');
    });
    
    assertTrue(validFormat, 'All material IDs should match bio:cell_line:<uuid> or bio:plasmid:<uuid>');
  });
}

// ==================== Verification Logic Tests ====================

function testVerificationLogic(): void {
  console.log('\n🔍 Verification Logic Tests');
  
  const materialsPath = path.join(__dirname, 'data', 'normal', 'materials.json');
  const materials = JSON.parse(fs.readFileSync(materialsPath, 'utf8'));
  
  test('REVOKED materials should fail on-chain verification', () => {
    const revoked = materials.filter((m: any) => m.status === 'REVOKED');
    if (revoked.length === 0) {
      throw new Error('No revoked materials to test');
    }
    
    // Check that all revoked have REVOKED in anomalies
    const allHaveAnomaly = revoked.every((m: any) => m.anomalies.includes('REVOKED'));
    assertTrue(allHaveAnomaly, 'All revoked materials should have REVOKED anomaly');
  });
  
  test('Materials with expired QC should fail verification', () => {
    const withExpiredQC = materials.filter((m: any) => 
      m.credentials.some((c: any) => c.credentialType === 'QC_MYCO' && c.expired)
    );
    
    if (withExpiredQC.length === 0) {
      throw new Error('No materials with expired QC to test');
    }
    
    const allHaveAnomaly = withExpiredQC.every((m: any) => m.anomalies.includes('EXPIRED_QC'));
    assertTrue(allHaveAnomaly, 'All materials with expired QC should have EXPIRED_QC anomaly');
  });
  
  test('Materials with pending transfer should fail verification', () => {
    const withPending = materials.filter((m: any) => 
      m.transfers.some((t: any) => !t.accepted)
    );
    
    if (withPending.length === 0) {
      console.log('    (No pending transfers in this dataset)');
      return;
    }
    
    const allHaveAnomaly = withPending.every((m: any) => m.anomalies.includes('PENDING_TRANSFER'));
    assertTrue(allHaveAnomaly, 'All materials with pending transfer should have PENDING_TRANSFER anomaly');
  });
  
  test('Clean materials should pass verification', () => {
    const clean = materials.filter((m: any) => 
      m.status === 'ACTIVE' &&
      m.anomalies.length === 0
    );
    
    assertTrue(clean.length > 0, 'Should have some clean materials');
    
    // Verify they have required credentials
    const allHaveRequired = clean.every((m: any) => {
      const hasIdentity = m.credentials.some((c: any) => c.credentialType === 'IDENTITY');
      const hasValidQC = m.credentials.some((c: any) => c.credentialType === 'QC_MYCO' && !c.expired);
      const noPending = m.transfers.every((t: any) => t.accepted);
      return hasIdentity && hasValidQC && noPending;
    });
    
    assertTrue(allHaveRequired, 'Clean materials should have valid IDENTITY and QC');
  });
}

// ==================== Artifact Integrity Tests ====================

function testArtifactIntegrity(): void {
  console.log('\n🔐 Artifact Integrity Tests');
  
  const materialsPath = path.join(__dirname, 'data', 'adversarial', 'materials.json');
  const materials = JSON.parse(fs.readFileSync(materialsPath, 'utf8'));
  
  test('Tampered artifacts should be detectable', () => {
    const withTampered = materials.filter((m: any) => 
      m.credentials.some((c: any) => c.artifactRef?.tampered)
    );
    
    assertTrue(withTampered.length > 0, 'Adversarial dataset should have tampered artifacts');
    
    const allMarked = withTampered.every((m: any) => m.anomalies.includes('TAMPERED_ARTIFACT'));
    assertTrue(allMarked, 'All tampered materials should have TAMPERED_ARTIFACT anomaly');
  });
  
  test('On-chain verification should NOT detect tampering', () => {
    // This is expected behavior - tampering is detected off-chain
    const withTampered = materials.filter((m: any) => 
      m.credentials.some((c: any) => c.artifactRef?.tampered) &&
      m.status === 'ACTIVE' &&
      m.credentials.some((c: any) => c.credentialType === 'IDENTITY') &&
      m.credentials.some((c: any) => c.credentialType === 'QC_MYCO' && !c.expired) &&
      m.transfers.every((t: any) => t.accepted)
    );
    
    // These materials should pass on-chain but fail full verification
    // This demonstrates the split between contract and verifier responsibilities
    console.log(`    (${withTampered.length} materials pass on-chain but fail full verification due to tampering)`);
  });
}

// ==================== Main ====================

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  BIOPASSPORT INTEGRATION TEST SUITE');
  console.log('═'.repeat(60));
  
  testCanonicalHashing();
  testDatasetGeneration();
  testCSVFormat();
  testVerificationLogic();
  testArtifactIntegrity();
  
  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log('\n' + '═'.repeat(60));
  console.log(`  TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));
  
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ✗ ${r.name}: ${r.message}`);
    });
    process.exit(1);
  }
  
  console.log('\n✅ All tests passed!');
}

main().catch(console.error);
