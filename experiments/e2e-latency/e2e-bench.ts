import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createStorage } from '../../issuer-service/src/storage';
import {
  createEvalClient,
  createRegistryContract,
  getEvalEnv,
  loadEnvFile,
  resultMaterialId,
} from '../eval-utils';

const RTT_VALUES_MS = [0, 1, 50, 100];
const ARTIFACT_SIZES = [1024, 1024 * 1024, 10 * 1024 * 1024];
const ITERATIONS = 50;
const APPLY_DELAY_MS = 2000;
const RESULTS_DIR = path.resolve(__dirname, '..', 'results', 'e2e-latency');
const SCRIPT_DIR = __dirname;
const MINIO_ENDPOINT = 'localhost';
const MINIO_PORT = 9010;
const MINIO_CONSOLE_PORT = 9011;
const MINIO_BUCKET = 'artifacts';

interface PhaseStats {
  onChain: number;
  minioFetch: number;
  sha256: number;
  hashCheck: number;
  total: number;
}

interface Sample extends PhaseStats {
  iteration: number;
  verifiedPass: boolean;
}

interface ScenarioResult {
  rttMs: number;
  artifactBytes: number;
  materialId: string;
  credentialId: string;
  artifactCid: string;
  artifactHash: string;
  samples: Sample[];
  p50: PhaseStats;
  p95: PhaseStats;
  p99: PhaseStats;
  failures: Array<{ iteration: number; error: string }>;
}

interface StagedArtifact {
  size: number;
  materialId: string;
  credentialId: string;
  artifactCid: string;
  artifactHash: string;
  presignedUrl: string;
}

function bashExecutable(): string {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

function runInjectRtt(delayMs: number): void {
  const scriptPath = path.join(SCRIPT_DIR, 'inject-rtt.sh');
  const res = spawnSync(bashExecutable(), [scriptPath, String(delayMs)], {
    cwd: SCRIPT_DIR,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (res.stdout?.trim()) process.stdout.write(res.stdout);
  if (res.stderr?.trim()) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(`inject-rtt.sh ${delayMs} failed with exit ${res.status}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeHash(hash: string): string {
  return hash.replace(/^0x/i, '').toLowerCase();
}

function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

function summarizeSamples(samples: Sample[], p: number): PhaseStats {
  return {
    onChain: quantile(samples.map((s) => s.onChain), p),
    minioFetch: quantile(samples.map((s) => s.minioFetch), p),
    sha256: quantile(samples.map((s) => s.sha256), p),
    hashCheck: quantile(samples.map((s) => s.hashCheck), p),
    total: quantile(samples.map((s) => s.total), p),
  };
}

async function stageArtifacts(): Promise<StagedArtifact[]> {
  loadEnvFile();
  const storage = createStorage({
    endpoint: MINIO_ENDPOINT,
    port: MINIO_PORT,
    useSSL: false,
    accessKey: 'minio',
    secretKey: 'minio12345',
    bucket: MINIO_BUCKET,
  });
  await storage.init();

  const client = createEvalClient();
  const registry = createRegistryContract();
  await client.connect();

  const staged: StagedArtifact[] = [];
  const validUntil = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  try {
    for (const size of ARTIFACT_SIZES) {
      const bytes = crypto.randomBytes(size);
      const reg = await client.registerMaterial(
        'CELL_LINE',
        `0x${sha256Hex(Buffer.from(`e2e-metadata:${size}:${Date.now()}`))}`
      );
      if (reg.status !== 'SUCCESS') {
        throw new Error(`registerMaterial failed for ${size}: ${reg.error}`);
      }
      const materialId = resultMaterialId(reg);

      const identity = await client.issueCredential(
        materialId,
        'IDENTITY',
        `0x${sha256Hex(Buffer.from(`identity:${size}:${Date.now()}`))}`,
        validUntil,
        `identity://${materialId}`,
        sha256Hex(Buffer.from(`identity-artifact:${size}`)),
        'e2e-identity'
      );
      if (identity.status !== 'SUCCESS') {
        throw new Error(`issueCredential(IDENTITY) failed for ${materialId}: ${identity.error}`);
      }

      const upload = await storage.uploadArtifactBuffer(bytes, `test-${size}.bin`, materialId, 'QC_MYCO');
      const qc = await client.issueCredential(
        materialId,
        'QC_MYCO',
        `0x${sha256Hex(Buffer.from(`qc:${size}:${Date.now()}`))}`,
        validUntil,
        upload.cid,
        upload.hash,
        'e2e-qc'
      );
      if (qc.status !== 'SUCCESS') {
        throw new Error(`issueCredential(QC_MYCO) failed for ${materialId}: ${qc.error}`);
      }

      const credentialId = (qc.result as { credentialId?: string })?.credentialId;
      if (!credentialId) {
        throw new Error(`Missing credentialId for staged QC credential on ${materialId}`);
      }

      const onChain = await registry.getCredential(credentialId);
      const onChainCid = String(onChain.artifactCid ?? onChain[7] ?? '');
      const onChainHash = String(onChain.artifactHash ?? onChain[8] ?? '');
      if (!onChainCid || normalizeHash(onChainHash) !== normalizeHash(upload.hash)) {
        throw new Error(`On-chain artifact mismatch for ${credentialId}`);
      }

      const presignedUrl = await storage.getPresignedUrl(onChainCid, 3600);
      staged.push({
        size,
        materialId,
        credentialId,
        artifactCid: onChainCid,
        artifactHash: onChainHash,
        presignedUrl,
      });
    }
  } finally {
    await client.disconnect();
  }

  return staged;
}

async function fetchArtifact(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MinIO fetch failed with HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function runScenario(
  client: ReturnType<typeof createEvalClient>,
  staged: StagedArtifact,
  rttMs: number
): Promise<ScenarioResult> {
  console.log(`\n=== RTT=${rttMs}ms size=${staged.size}B material=${staged.materialId} ===`);
  runInjectRtt(rttMs);
  await sleep(APPLY_DELAY_MS);

  const samples: Sample[] = [];
  const failures: Array<{ iteration: number; error: string }> = [];

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    try {
      const t0 = performance.now();
      const verification = await client.verifyMaterial(staged.materialId);
      const t1 = performance.now();
      const bytes = await fetchArtifact(staged.presignedUrl);
      const t2 = performance.now();
      const digest = sha256Hex(bytes);
      const t3 = performance.now();
      const digestMatches = normalizeHash(digest) === normalizeHash(staged.artifactHash);
      const t4 = performance.now();

      if (!verification.pass) {
        throw new Error(`verifyMaterial returned pass=false (${verification.reasons.map((r) => r.code).join(',')})`);
      }
      if (!digestMatches) {
        throw new Error('artifact SHA-256 did not match on-chain artifactHash');
      }

      samples.push({
        iteration,
        verifiedPass: verification.pass,
        onChain: t1 - t0,
        minioFetch: t2 - t1,
        sha256: t3 - t2,
        hashCheck: t4 - t3,
        total: t4 - t0,
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      failures.push({ iteration, error: message });
      console.error(`  [scenario failure] RTT=${rttMs} size=${staged.size} iter=${iteration}: ${message}`);
    }
  }

  return {
    rttMs,
    artifactBytes: staged.size,
    materialId: staged.materialId,
    credentialId: staged.credentialId,
    artifactCid: staged.artifactCid,
    artifactHash: staged.artifactHash,
    samples,
    p50: summarizeSamples(samples, 0.5),
    p95: summarizeSamples(samples, 0.95),
    p99: summarizeSamples(samples, 0.99),
    failures,
  };
}

async function main() {
  loadEnvFile();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const env = getEvalEnv();
  const client = createEvalClient();
  await client.connect();

  let stagedArtifacts: StagedArtifact[] = [];
  const scenarios: ScenarioResult[] = [];
  try {
    stagedArtifacts = await stageArtifacts();
    console.log('\nStaged materials:');
    for (const item of stagedArtifacts) {
      console.log(
        `  size=${item.size} material=${item.materialId} credential=${item.credentialId} cid=${item.artifactCid}`
      );
    }

    for (const rttMs of RTT_VALUES_MS) {
      for (const staged of stagedArtifacts) {
        scenarios.push(await runScenario(client, staged, rttMs));
      }
    }
  } finally {
    try {
      runInjectRtt(0);
    } catch {
      // Ignore cleanup failures here; caller still gets benchmark results if present.
    }
    await client.disconnect();
  }

  const timestamp = Date.now();
  const outPath = path.join(RESULTS_DIR, `e2e-latency-${timestamp}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        scenarios,
        stagedArtifacts,
        purechain: {
          registryAddress: env.registryAddress,
          rpcUrl: env.rpcUrl,
        },
        minio: {
          endpoint: `${MINIO_ENDPOINT}:${MINIO_PORT}`,
          console: `${MINIO_ENDPOINT}:${MINIO_CONSOLE_PORT}`,
          bucket: MINIO_BUCKET,
        },
      },
      null,
      2
    )
  );

  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
