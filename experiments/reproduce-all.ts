/**
 * BioPassport One-Command Reproducibility Script
 * 
 * Reproduces all experiments from the IEEE ICBC paper:
 * 1. Generate datasets (normal, drift, adversarial)
 * 2. Run integration tests
 * 3. Run benchmark suite
 * 4. Generate tables and figures
 * 
 * Usage: npx ts-node reproduce-all.ts [--seed <number>] [--quick]
 * 
 * Options:
 *   --seed <number>  Fixed seed for reproducible random generation (default: 42)
 *   --quick          Run quick benchmarks (fewer iterations)
 *   --full           Run full benchmarks (more iterations, longer)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';

// ==================== Configuration ====================

interface Config {
  seed: number;
  quick: boolean;
  full: boolean;
  outputDir: string;
  dataDir: string;
  resultsDir: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  
  let seed = 42;
  let quick = false;
  let full = false;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed' && args[i + 1]) {
      seed = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--quick') {
      quick = true;
    } else if (args[i] === '--full') {
      full = true;
    }
  }
  
  return {
    seed,
    quick,
    full,
    outputDir: path.join(__dirname),
    dataDir: path.join(__dirname, 'data'),
    resultsDir: path.join(__dirname, 'results'),
  };
}

// ==================== Utilities ====================

function log(message: string): void {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`[${timestamp}] ${message}`);
}

function runCommand(command: string, cwd: string): boolean {
  log(`Running: ${command}`);
  try {
    execSync(command, { cwd, stdio: 'inherit' });
    return true;
  } catch (error) {
    log(`Command failed: ${command}`);
    return false;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ==================== Steps ====================

function step1_generateDatasets(config: Config): boolean {
  console.log('\n' + '═'.repeat(60));
  console.log('  STEP 1: Generate Datasets');
  console.log('═'.repeat(60));
  
  log(`Using seed: ${config.seed}`);
  
  // Set seed for reproducibility
  process.env.BIOPASSPORT_SEED = config.seed.toString();
  
  return runCommand('npx ts-node generate-dataset.ts', config.outputDir);
}

function step2_runIntegrationTests(config: Config): boolean {
  console.log('\n' + '═'.repeat(60));
  console.log('  STEP 2: Run Integration Tests');
  console.log('═'.repeat(60));
  
  return runCommand('npx ts-node test-integration.ts', config.outputDir);
}

function step3_runBenchmarks(config: Config): boolean {
  console.log('\n' + '═'.repeat(60));
  console.log('  STEP 3: Run Benchmark Suite');
  console.log('═'.repeat(60));
  
  const mode = config.full ? '--full' : (config.quick ? '' : '');
  return runCommand(`npx ts-node benchmark-suite.ts ${mode}`, config.outputDir);
}

function step4_generateSummary(config: Config): void {
  console.log('\n' + '═'.repeat(60));
  console.log('  STEP 4: Generate Summary Report');
  console.log('═'.repeat(60));
  
  ensureDir(config.resultsDir);
  
  // Load all results
  const summaries: Record<string, any> = {};
  
  for (const dataset of ['normal', 'drift', 'adversarial']) {
    const summaryPath = path.join(config.dataDir, dataset, 'summary.json');
    if (fs.existsSync(summaryPath)) {
      summaries[dataset] = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    }
  }
  
  // Load benchmark report
  const benchmarkPath = path.join(config.resultsDir, 'benchmark-report.json');
  let benchmarkReport: any = null;
  if (fs.existsSync(benchmarkPath)) {
    benchmarkReport = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
  }
  
  // Generate summary
  const summary = {
    timestamp: new Date().toISOString(),
    seed: config.seed,
    datasets: {
      normal: summaries.normal ? {
        materials: summaries.normal.totalMaterials,
        onChainPassRate: (summaries.normal.onChainVerification.pass / summaries.normal.totalMaterials * 100).toFixed(1) + '%',
        fullPassRate: (summaries.normal.fullVerification.pass / summaries.normal.totalMaterials * 100).toFixed(1) + '%',
      } : null,
      drift: summaries.drift ? {
        materials: summaries.drift.totalMaterials,
        onChainPassRate: (summaries.drift.onChainVerification.pass / summaries.drift.totalMaterials * 100).toFixed(1) + '%',
        fullPassRate: (summaries.drift.fullVerification.pass / summaries.drift.totalMaterials * 100).toFixed(1) + '%',
      } : null,
      adversarial: summaries.adversarial ? {
        materials: summaries.adversarial.totalMaterials,
        onChainPassRate: (summaries.adversarial.onChainVerification.pass / summaries.adversarial.totalMaterials * 100).toFixed(1) + '%',
        fullPassRate: (summaries.adversarial.fullVerification.pass / summaries.adversarial.totalMaterials * 100).toFixed(1) + '%',
      } : null,
    },
    benchmarks: benchmarkReport ? {
      latency: {
        verifyOnChain_p50: benchmarkReport.latency.verifyMaterialOnChain.p50.toFixed(1) + 'ms',
        verifyOnChain_p99: benchmarkReport.latency.verifyMaterialOnChain.p99.toFixed(1) + 'ms',
        verifyFull_p50: benchmarkReport.latency.verifyMaterialFull.p50.toFixed(1) + 'ms',
        verifyFull_p99: benchmarkReport.latency.verifyMaterialFull.p99.toFixed(1) + 'ms',
      },
      throughput: benchmarkReport.throughput.map((t: any) => ({
        concurrency: t.concurrency,
        opsPerSec: t.opsPerSecond,
      })),
      storage: {
        bytesPerMaterial: benchmarkReport.storage.bytesPerMaterial,
        totalKB: (benchmarkReport.storage.totalStorageBytes / 1024).toFixed(2),
      },
    } : null,
  };
  
  const summaryPath = path.join(config.resultsDir, 'experiment-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  log(`Saved: ${summaryPath}`);
  
  // Print summary
  console.log('\n' + '─'.repeat(60));
  console.log('  EXPERIMENT SUMMARY');
  console.log('─'.repeat(60));
  
  if (summary.datasets.normal) {
    console.log(`\n  Normal Dataset (${summary.datasets.normal.materials} materials):`);
    console.log(`    On-chain PASS: ${summary.datasets.normal.onChainPassRate}`);
    console.log(`    Full PASS:     ${summary.datasets.normal.fullPassRate}`);
  }
  
  if (summary.datasets.drift) {
    console.log(`\n  Drift Dataset (${summary.datasets.drift.materials} materials):`);
    console.log(`    On-chain PASS: ${summary.datasets.drift.onChainPassRate}`);
    console.log(`    Full PASS:     ${summary.datasets.drift.fullPassRate}`);
  }
  
  if (summary.datasets.adversarial) {
    console.log(`\n  Adversarial Dataset (${summary.datasets.adversarial.materials} materials):`);
    console.log(`    On-chain PASS: ${summary.datasets.adversarial.onChainPassRate}`);
    console.log(`    Full PASS:     ${summary.datasets.adversarial.fullPassRate}`);
  }
  
  if (summary.benchmarks) {
    console.log('\n  Performance:');
    console.log(`    Verify (on-chain): p50=${summary.benchmarks.latency.verifyOnChain_p50}, p99=${summary.benchmarks.latency.verifyOnChain_p99}`);
    console.log(`    Verify (full):     p50=${summary.benchmarks.latency.verifyFull_p50}, p99=${summary.benchmarks.latency.verifyFull_p99}`);
    console.log(`    Storage:           ${summary.benchmarks.storage.bytesPerMaterial} bytes/material`);
  }
}

// ==================== Main ====================

async function main(): Promise<void> {
  const config = parseArgs();
  
  console.log('═'.repeat(60));
  console.log('  BIOPASSPORT REPRODUCIBILITY SCRIPT');
  console.log('  IEEE ICBC Paper Experiments');
  console.log('═'.repeat(60));
  console.log(`\nConfiguration:`);
  console.log(`  Seed:   ${config.seed}`);
  console.log(`  Mode:   ${config.full ? 'FULL' : (config.quick ? 'QUICK' : 'STANDARD')}`);
  console.log(`  Output: ${config.resultsDir}`);
  
  const startTime = Date.now();
  
  // Run all steps
  const step1 = step1_generateDatasets(config);
  if (!step1) {
    console.error('\n❌ Step 1 failed. Aborting.');
    process.exit(1);
  }
  
  const step2 = step2_runIntegrationTests(config);
  if (!step2) {
    console.error('\n❌ Step 2 failed. Aborting.');
    process.exit(1);
  }
  
  const step3 = step3_runBenchmarks(config);
  if (!step3) {
    console.error('\n❌ Step 3 failed. Aborting.');
    process.exit(1);
  }
  
  step4_generateSummary(config);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n' + '═'.repeat(60));
  console.log('  REPRODUCTION COMPLETE');
  console.log('═'.repeat(60));
  console.log(`\nTotal time: ${elapsed}s`);
  console.log('\nOutputs:');
  console.log('  data/normal/          - Normal dataset');
  console.log('  data/drift/           - Drift dataset');
  console.log('  data/adversarial/     - Adversarial dataset');
  console.log('  results/benchmark-report.json');
  console.log('  results/tables.tex    - LaTeX tables for paper');
  console.log('  results/scaling.csv   - Scaling data for plots');
  console.log('  results/experiment-summary.json');
  console.log('\nTo regenerate with same results, use:');
  console.log(`  npx ts-node reproduce-all.ts --seed ${config.seed}`);
  console.log('═'.repeat(60));
}

main().catch(console.error);
