import { performance } from 'node:perf_hooks';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3100';

interface QuantileWithCI {
  point: number;
  ciLow: number;
  ciHigh: number;
}

interface LatencyReport {
  op: string;
  n: number;
  mean: number;
  std: number;
  p50: QuantileWithCI;
  p95: QuantileWithCI;
  p99: QuantileWithCI;
}

interface ThroughputClientStats {
  client: number;
  successes: number;
  failures: number;
  failureReasons: Record<string, number>;
  p50Ms: number;
  p99Ms: number;
  meanMs: number;
  stdMs: number;
}

interface ThroughputRun {
  concurrency: number;
  opsPerClient: number;
  totalOps: number;
  successfulOps: number;
  failedOps: number;
  wallClockSeconds: number;
  opsPerSecond: number;
  perAccount: ThroughputClientStats[];
  failureReasons: Record<string, number>;
}

function argVal(name: string, fallback: number): number {
  const eq = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return Number(eq.split('=')[1]);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? Number(process.argv[idx + 1]) : fallback;
}

function argString(name: string, fallback: string): string {
  const eq = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? String(process.argv[idx + 1]) : fallback;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function bootstrapQuantileCI(samples: number[], p: number, iters: number, alpha = 0.05): QuantileWithCI {
  if (samples.length === 0) {
    return { point: 0, ciLow: 0, ciHigh: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const point = quantile(sorted, p);
  const estimates: number[] = [];
  for (let i = 0; i < iters; i++) {
    const resample = Array.from({ length: samples.length }, () => samples[Math.floor(Math.random() * samples.length)]);
    resample.sort((a, b) => a - b);
    estimates.push(quantile(resample, p));
  }
  estimates.sort((a, b) => a - b);

  return {
    point,
    ciLow: estimates[Math.floor((alpha / 2) * iters)],
    ciHigh: estimates[Math.floor((1 - alpha / 2) * iters)],
  };
}

function summarizeLatency(op: string, samples: number[], bootstrapIters: number): LatencyReport {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((acc, value) => acc + value, 0) / samples.length;
  const variance = samples.reduce((acc, value) => acc + (value - mean) ** 2, 0) / samples.length;

  return {
    op,
    n: samples.length,
    mean,
    std: Math.sqrt(variance),
    p50: bootstrapQuantileCI(sorted, 0.5, bootstrapIters),
    p95: bootstrapQuantileCI(sorted, 0.95, bootstrapIters),
    p99: bootstrapQuantileCI(sorted, 0.99, bootstrapIters),
  };
}

function summarizeClient(client: number, samples: number[], failures: number, failureReasons: Record<string, number>): ThroughputClientStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.length ? samples.reduce((acc, value) => acc + value, 0) / samples.length : 0;
  const variance = samples.length ? samples.reduce((acc, value) => acc + (value - mean) ** 2, 0) / samples.length : 0;
  return {
    client,
    successes: samples.length,
    failures,
    failureReasons,
    p50Ms: quantile(sorted, 0.5),
    p99Ms: quantile(sorted, 0.99),
    meanMs: mean,
    stdMs: Math.sqrt(variance),
  };
}

function resultsDir(): string {
  return path.resolve(__dirname, '..', '..', 'results', 'postgres-baseline');
}

function randomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function futureIso(days = 30): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function postJson<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${SERVICE_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function getJson<T>(route: string): Promise<T> {
  const response = await fetch(`${SERVICE_URL}${route}`);
  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function createMaterial(ownerOrg = 'OrgA'): Promise<string> {
  const result = await postJson<{ materialId: string }>('/materials', {
    materialType: 'CELL_LINE',
    metadataHashHex: randomHex(),
    ownerOrg,
  });
  return result.materialId;
}

async function issueIdentity(materialId: string): Promise<string> {
  const result = await postJson<{ credentialId: string }>('/credentials', {
    materialId,
    credType: 'IDENTITY',
    payload: { kind: 'identity', materialId, ts: Date.now() },
    validUntil: null,
    artifactCid: 's3://baseline/identity.json',
    artifactHashHex: randomHex(),
    issuerId: 'OrgID',
  });
  return result.credentialId;
}

async function issueQc(materialId: string, suffix: string): Promise<string> {
  const result = await postJson<{ credentialId: string }>('/credentials', {
    materialId,
    credType: 'QC_MYCO',
    payload: { kind: 'qc', materialId, suffix, ts: Date.now(), score: Math.random() },
    validUntil: futureIso(30),
    artifactCid: `s3://baseline/qc/${suffix}.json`,
    artifactHashHex: randomHex(),
    issuerId: 'OrgQC',
  });
  return result.credentialId;
}

async function ensureHealthy(): Promise<void> {
  const response = await getJson<{ ok: boolean }>('/health');
  if (!response.ok) {
    throw new Error('service health check failed');
  }
}

async function runLatencyBench(reads: number, writes: number, bootstrap: number): Promise<void> {
  console.log(`Preparing ${writes} issueCredential targets and ${reads} verify targets...`);
  const issueTargets: string[] = [];
  for (let i = 0; i < writes; i++) {
    issueTargets.push(await createMaterial('OrgIssue'));
  }

  const verifyTargets: string[] = [];
  for (let i = 0; i < reads; i++) {
    const materialId = await createMaterial('OrgVerify');
    await issueIdentity(materialId);
    await issueQc(materialId, `verify-${i}`);
    verifyTargets.push(materialId);
  }

  const registerSamples: number[] = [];
  const issueSamples: number[] = [];
  const verifySamples: number[] = [];

  console.log(`Sampling registerMaterial x${writes}...`);
  for (let i = 0; i < writes; i++) {
    const t0 = performance.now();
    await createMaterial('OrgBench');
    registerSamples.push(performance.now() - t0);
  }

  console.log(`Sampling issueCredential x${writes}...`);
  for (let i = 0; i < writes; i++) {
    const t0 = performance.now();
    await issueQc(issueTargets[i], `issue-${i}`);
    issueSamples.push(performance.now() - t0);
  }

  console.log(`Sampling verifyMaterial x${reads}...`);
  for (let i = 0; i < reads; i++) {
    const t0 = performance.now();
    await getJson<{ pass: boolean; reasons: string[] }>(`/verify/${verifyTargets[i]}`);
    verifySamples.push(performance.now() - t0);
  }

  const report = {
    args: { reads, writes, bootstrap },
    report: {
      registerMaterial: summarizeLatency('registerMaterial', registerSamples, bootstrap),
      issueCredential: summarizeLatency('issueCredential', issueSamples, bootstrap),
      verifyMaterial: summarizeLatency('verifyMaterial', verifySamples, bootstrap),
    },
    samples: {
      registerMaterial: registerSamples,
      issueCredential: issueSamples,
      verifyMaterial: verifySamples,
    },
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  const outPath = path.join(resultsDir(), `postgres-latency-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(report.report, null, 2));
}

async function runThroughputBench(concurrencyLevels: number[], opsPerClient: number): Promise<void> {
  const runs: ThroughputRun[] = [];

  for (const concurrency of concurrencyLevels) {
    console.log(`Preparing throughput targets for K=${concurrency}...`);
    const totalOps = concurrency * opsPerClient;
    const materials: string[] = [];
    for (let i = 0; i < totalOps; i++) {
      materials.push(await createMaterial(`OrgThroughput${i % concurrency}`));
    }

    const perClient = Array.from({ length: concurrency }, (_unused, client) =>
      materials.slice(client * opsPerClient, (client + 1) * opsPerClient)
    );

    console.log(`Running throughput bench for K=${concurrency}...`);
    const start = performance.now();
    const clientStats = await Promise.all(
      perClient.map(async (clientMaterials, client) => {
        const latencies: number[] = [];
        const failureReasons: Record<string, number> = {};
        let failures = 0;

        for (let i = 0; i < clientMaterials.length; i++) {
          const t0 = performance.now();
          try {
            await issueQc(clientMaterials[i], `k${concurrency}-c${client}-op${i}`);
            latencies.push(performance.now() - t0);
          } catch (error) {
            failures += 1;
            const reason = error instanceof Error ? error.message : String(error);
            failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          }
        }

        return summarizeClient(client, latencies, failures, failureReasons);
      })
    );
    const wallClockSeconds = (performance.now() - start) / 1000;

    const failureReasons: Record<string, number> = {};
    let successfulOps = 0;
    let failedOps = 0;
    for (const stats of clientStats) {
      successfulOps += stats.successes;
      failedOps += stats.failures;
      for (const [reason, count] of Object.entries(stats.failureReasons)) {
        failureReasons[reason] = (failureReasons[reason] ?? 0) + count;
      }
    }

    runs.push({
      concurrency,
      opsPerClient,
      totalOps,
      successfulOps,
      failedOps,
      wallClockSeconds,
      opsPerSecond: successfulOps / wallClockSeconds,
      perAccount: clientStats,
      failureReasons,
    });
  }

  const report = {
    args: { concurrencyLevels, opsPerClient },
    runs,
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  const outPath = path.join(resultsDir(), `postgres-throughput-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(runs, null, 2));
}

async function main() {
  await ensureHealthy();

  const mode = argString('mode', 'latency');
  if (mode === 'latency') {
    await runLatencyBench(argVal('reads', 1000), argVal('writes', 1000), argVal('bootstrap', 2000));
    return;
  }

  if (mode === 'throughput') {
    const levels = argString('concurrency-levels', '1,2,5,10,20')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    await runThroughputBench(levels, argVal('ops-per-client', 20));
    return;
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
