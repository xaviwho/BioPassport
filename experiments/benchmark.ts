/**
 * BioPassport Performance Benchmarking Script
 * 
 * Measures:
 * - Transaction latency for register/issue/transfer/verify
 * - Throughput with varying credential counts
 * - Storage growth on-chain vs off-chain
 */

import { createIssuer } from '../issuer-service/src/issuer';
import { createVerifier } from '../verifier-cli/src/verifier';
import * as fs from 'fs';
import * as path from 'path';

interface BenchmarkResult {
  operation: string;
  count: number;
  totalTimeMs: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  throughputPerSec: number;
  errors: number;
}

interface BenchmarkSuite {
  name: string;
  timestamp: string;
  results: BenchmarkResult[];
  summary: {
    totalOperations: number;
    totalTimeMs: number;
    overallThroughput: number;
  };
}

async function runBenchmark(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  BIOPASSPORT PERFORMANCE BENCHMARK');
  console.log('═'.repeat(60));
  console.log();

  const suite: BenchmarkSuite = {
    name: 'BioPassport Performance Benchmark',
    timestamp: new Date().toISOString(),
    results: [],
    summary: {
      totalOperations: 0,
      totalTimeMs: 0,
      overallThroughput: 0
    }
  };

  // Initialize services
  const issuer = createIssuer({ orgId: 'BenchmarkOrg' });
  await issuer.init();

  // Benchmark configurations
  const credentialCounts = [10, 50, 100, 500, 1000];

  // 1. Material Registration Benchmark
  console.log('─ Material Registration Benchmark ─');
  for (const count of [10, 50, 100]) {
    const result = await benchmarkOperation(
      'RegisterMaterial',
      count,
      async (index) => {
        await issuer.registerMaterial('CELL_LINE', {
          name: `Benchmark Cell Line ${index}`,
          description: 'Benchmark test material',
          species: 'Human'
        });
      }
    );
    suite.results.push(result);
    printResult(result);
  }

  // 2. Credential Issuance Benchmark
  console.log('\n─ Credential Issuance Benchmark ─');
  const testMaterialId = 'bio:cell_line:benchmark-test';
  
  for (const count of credentialCounts) {
    const result = await benchmarkOperation(
      'IssueCredential',
      count,
      async (_index) => {
        await issuer.issueMycoCredential(
          testMaterialId,
          'NEGATIVE',
          'PCR',
          new Date().toISOString().split('T')[0],
          'BenchmarkLab',
          { validityDays: 90 }
        );
      }
    );
    suite.results.push(result);
    printResult(result);
  }

  // 3. Verification Benchmark
  console.log('\n─ Verification Benchmark ─');
  const verifier = createVerifier();
  
  for (const count of [10, 50, 100]) {
    const result = await benchmarkOperation(
      'VerifyMaterial',
      count,
      async () => {
        await verifier.quickVerify(testMaterialId);
      }
    );
    suite.results.push(result);
    printResult(result);
  }

  // 4. Full Verification (with artifacts) Benchmark
  console.log('\n─ Full Verification Benchmark ─');
  for (const count of [10, 50]) {
    const result = await benchmarkOperation(
      'FullVerify',
      count,
      async () => {
        await verifier.verify(testMaterialId, {
          verifyArtifacts: true,
          verifySignatures: true
        });
      }
    );
    suite.results.push(result);
    printResult(result);
  }

  // Calculate summary
  suite.summary.totalOperations = suite.results.reduce((sum, r) => sum + r.count, 0);
  suite.summary.totalTimeMs = suite.results.reduce((sum, r) => sum + r.totalTimeMs, 0);
  suite.summary.overallThroughput = (suite.summary.totalOperations / suite.summary.totalTimeMs) * 1000;

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('  BENCHMARK SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total Operations: ${suite.summary.totalOperations}`);
  console.log(`  Total Time: ${(suite.summary.totalTimeMs / 1000).toFixed(2)}s`);
  console.log(`  Overall Throughput: ${suite.summary.overallThroughput.toFixed(2)} ops/sec`);
  console.log('═'.repeat(60));

  // Save results
  const outputPath = path.join(__dirname, 'results', `benchmark-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(suite, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  await issuer.close();
}

async function benchmarkOperation(
  operation: string,
  count: number,
  fn: (index: number) => Promise<void>
): Promise<BenchmarkResult> {
  const latencies: number[] = [];
  let errors = 0;

  const startTime = Date.now();

  for (let i = 0; i < count; i++) {
    const opStart = Date.now();
    try {
      await fn(i);
      latencies.push(Date.now() - opStart);
    } catch (error) {
      errors++;
      latencies.push(Date.now() - opStart);
    }
  }

  const totalTimeMs = Date.now() - startTime;

  return {
    operation,
    count,
    totalTimeMs,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    minLatencyMs: Math.min(...latencies),
    maxLatencyMs: Math.max(...latencies),
    throughputPerSec: (count / totalTimeMs) * 1000,
    errors
  };
}

function printResult(result: BenchmarkResult): void {
  console.log(`  ${result.operation} (n=${result.count}):`);
  console.log(`    Avg Latency: ${result.avgLatencyMs.toFixed(2)}ms`);
  console.log(`    Min/Max: ${result.minLatencyMs}ms / ${result.maxLatencyMs}ms`);
  console.log(`    Throughput: ${result.throughputPerSec.toFixed(2)} ops/sec`);
  if (result.errors > 0) {
    console.log(`    Errors: ${result.errors}`);
  }
}

// Run benchmark
runBenchmark().catch(console.error);
