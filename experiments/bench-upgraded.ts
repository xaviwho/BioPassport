/**
 * Upgraded live PureChain benchmark with bootstrap confidence intervals.
 *
 * Run:
 *   npm run bench:upgraded -- --reads 1000 --writes 200 --warmup 20 --bootstrap 2000
 */
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ethers } from 'ethers';
import {
  bytes32FromLabel,
  createEvalClient,
  enrollEphemeralDevice,
  reasonCodes,
  resultMaterialId,
  signAttestationForContract,
} from './eval-utils';

interface Sample {
  op: string;
  latencyMs: number;
  cold: boolean;
  ts: number;
}

interface QuantileWithCI {
  point: number;
  ciLow: number;
  ciHigh: number;
}

interface Report {
  op: string;
  n: number;
  mean: number;
  std: number;
  p50: QuantileWithCI;
  p95: QuantileWithCI;
  p99: QuantileWithCI;
  coldOnly: { n: number; meanMs: number };
  warmOnly: { n: number; meanMs: number };
}

function argVal(k: string, def: number): number {
  const eq = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function bootstrapQuantileCI(samples: number[], p: number, iters: number, alpha = 0.05): QuantileWithCI {
  if (samples.length === 0) return { point: 0, ciLow: 0, ciHigh: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const point = quantile(sorted, p);
  const ests: number[] = [];
  for (let i = 0; i < iters; i++) {
    const resample = Array.from({ length: samples.length }, () => samples[Math.floor(Math.random() * samples.length)]);
    resample.sort((a, b) => a - b);
    ests.push(quantile(resample, p));
  }
  ests.sort((a, b) => a - b);
  return {
    point,
    ciLow: ests[Math.floor((alpha / 2) * iters)],
    ciHigh: ests[Math.floor((1 - alpha / 2) * iters)],
  };
}

function summarize(op: string, samples: Sample[], bootstrapIters: number, warmupCount: number): Report {
  const all = samples.map((s) => s.latencyMs);
  const cold = samples.slice(0, warmupCount).map((s) => s.latencyMs);
  const warm = samples.slice(warmupCount).map((s) => s.latencyMs);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const std = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length);
  return {
    op,
    n: samples.length,
    mean,
    std,
    p50: bootstrapQuantileCI(warm, 0.5, bootstrapIters),
    p95: bootstrapQuantileCI(warm, 0.95, bootstrapIters),
    p99: bootstrapQuantileCI(warm, 0.99, bootstrapIters),
    coldOnly: { n: cold.length, meanMs: cold.length ? cold.reduce((a, b) => a + b, 0) / cold.length : 0 },
    warmOnly: { n: warm.length, meanMs: warm.length ? warm.reduce((a, b) => a + b, 0) / warm.length : 0 },
  };
}

async function must<T extends { status?: string; error?: string }>(result: T): Promise<T> {
  if (result.status === 'FAILED') throw new Error(result.error || 'operation failed');
  return result;
}

async function prepareVerifiableMaterial(client: ReturnType<typeof createEvalClient>): Promise<string> {
  const reg = await must(await client.registerMaterial('CELL_LINE', bytes32FromLabel(`bench-read-${Date.now()}`)));
  const materialId = resultMaterialId(reg);
  await must(await client.issueCredential(materialId, 'IDENTITY', bytes32FromLabel(`${materialId}:id`), 0, 's3://bench/id', bytes32FromLabel('id-art'), 'Org1MSP'));
  await must(await client.issueCredential(materialId, 'QC_MYCO', bytes32FromLabel(`${materialId}:qc`), 0, 's3://bench/qc', bytes32FromLabel('qc-art'), 'Org1MSP'));
  return materialId;
}

async function main() {
  const READS = argVal('reads', 1000);
  const WRITES = argVal('writes', 200);
  const WARMUP = argVal('warmup', 20);
  const BOOTSTRAP = argVal('bootstrap', 2000);

  const client = createEvalClient();
  await client.connect();

  const samples: Record<string, Sample[]> = {
    registerMaterial: [],
    issueCredential: [],
    issueCredentialWithAttestation: [],
    verifyOnChain: [],
    verifyOnChainWithCredentials: [],
    // Stub for the real end-to-end path. The implementation belongs in
    // experiments/e2e-latency/ where MinIO RTT and artifact size are varied.
    verifyFullE2E: [],
  };

  const readTargetId = await prepareVerifiableMaterial(client);

  console.log(`Sampling verifyOnChain x${READS}...`);
  for (let i = 0; i < READS; i++) {
    const t0 = performance.now();
    await client.verifyMaterial(readTargetId);
    samples.verifyOnChain.push({ op: 'verifyOnChain', latencyMs: performance.now() - t0, cold: i < WARMUP, ts: Date.now() });
  }

  // NOTE: This measures two on-chain round-trips (verifyMaterial + credential lookup).
  // It does NOT include off-chain MinIO artifact fetch or SHA-256 recomputation.
  // True end-to-end verifyFull is measured separately in experiments/e2e-latency/.
  console.log(`Sampling verifyOnChainWithCredentials x${READS}...`);
  for (let i = 0; i < READS; i++) {
    const t0 = performance.now();
    await client.verifyMaterial(readTargetId);
    await client.getCredentialsForMaterial(readTargetId);
    samples.verifyOnChainWithCredentials.push({ op: 'verifyOnChainWithCredentials', latencyMs: performance.now() - t0, cold: i < WARMUP, ts: Date.now() });
  }

  console.log(`Sampling registerMaterial x${WRITES}...`);
  for (let i = 0; i < WRITES; i++) {
    const t0 = performance.now();
    await must(await client.registerMaterial('CELL_LINE', bytes32FromLabel(`bench-reg-${Date.now()}-${i}`)));
    samples.registerMaterial.push({ op: 'registerMaterial', latencyMs: performance.now() - t0, cold: i < WARMUP, ts: Date.now() });
  }

  console.log(`Sampling issueCredential x${WRITES}...`);
  for (let i = 0; i < WRITES; i++) {
    const reg = await must(await client.registerMaterial('CELL_LINE', bytes32FromLabel(`bench-issue-${Date.now()}-${i}`)));
    const materialId = resultMaterialId(reg);
    const t0 = performance.now();
    await must(await client.issueCredential(materialId, 'QC_MYCO', bytes32FromLabel(`issue-${i}`), 0, 's3://bench/qc', bytes32FromLabel(`issue-art-${i}`), 'Org1MSP'));
    samples.issueCredential.push({ op: 'issueCredential', latencyMs: performance.now() - t0, cold: i < WARMUP, ts: Date.now() });
  }

  console.log(`Sampling issueCredentialWithAttestation x${WRITES}...`);
  const { device, deviceId } = await enrollEphemeralDevice('device:bench-upgraded');
  await client.resyncNonce('bench-upgraded:device-enrolled');
  const baseCaptureTs = Math.floor(Date.now() / 1000) - WRITES - 600;
  for (let i = 0; i < WRITES; i++) {
    const reg = await must(await client.registerMaterial('CELL_LINE', bytes32FromLabel(`bench-iea-${Date.now()}-${i}`)));
    const materialId = resultMaterialId(reg);
    const commitmentHash = bytes32FromLabel(`iea-${i}`);
    const artifactHash = bytes32FromLabel(`iea-art-${i}`);
    const captureTs = baseCaptureTs + i + 1;
    const deviceSig = await signAttestationForContract({
      device,
      deviceId,
      materialId,
      credType: 1,
      commitmentHash,
      artifactHash,
      captureTs,
    });
    const t0 = performance.now();
    await client.issueCredentialWithAttestation({
      materialId,
      credType: 'QC_MYCO',
      commitmentHash,
      validUntil: 0,
      artifactCid: 's3://bench/qc-iea',
      artifactHash,
      issuerId: 'Org1MSP',
      deviceId,
      captureTs,
      deviceSig,
    });
    samples.issueCredentialWithAttestation.push({ op: 'issueCredentialWithAttestation', latencyMs: performance.now() - t0, cold: i < WARMUP, ts: Date.now() });
  }

  const report: Record<string, Report> = {};
  for (const [op, opSamples] of Object.entries(samples)) {
    if (opSamples.length > WARMUP) report[op] = summarize(op, opSamples, BOOTSTRAP, WARMUP);
  }

  const outDir = path.join(__dirname, 'results', 'upgraded');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `bench-upgraded-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ args: { READS, WRITES, WARMUP, BOOTSTRAP }, report, samples }, null, 2));

  console.log('\n=== Latency report (warm only, bootstrap 95% CI) ===');
  for (const r of Object.values(report)) {
    console.log(
      `${r.op.padEnd(34)} n=${r.n} p50=${r.p50.point.toFixed(1)} (${r.p50.ciLow.toFixed(1)}, ${r.p50.ciHigh.toFixed(1)}) ` +
      `p95=${r.p95.point.toFixed(1)} (${r.p95.ciLow.toFixed(1)}, ${r.p95.ciHigh.toFixed(1)}) ` +
      `p99=${r.p99.point.toFixed(1)} (${r.p99.ciLow.toFixed(1)}, ${r.p99.ciHigh.toFixed(1)})`
    );
  }
  console.log(`\nWrote ${out}`);
  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
