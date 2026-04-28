import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { SoftwareSigner } from '../src/signer.js';
import { commitmentHashForPayload, sha256File, signAttestation } from '../src/attestation.js';

const require = createRequire(import.meta.url);
const canonicalize = require('canonicalize') as (input: unknown) => string | undefined;

const ITER = Number(process.argv.find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? 1000);

function quantiles(xs: number[]): { p50: number; p95: number; p99: number; mean: number; std: number } {
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), mean, std };
}

async function main() {
  const tmp = path.join(os.tmpdir(), `bp-bench-${Date.now()}.bin`);
  fs.writeFileSync(tmp, crypto.randomBytes(1024 * 1024));

  const signer = new SoftwareSigner('0x' + 'ab'.repeat(32), 'device:bench:SN-0001');

  const hashTimes: number[] = [];
  const canonTimes: number[] = [];
  const signTimes: number[] = [];
  const e2eTimes: number[] = [];

  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    const h = await sha256File(tmp);
    const t1 = performance.now();

    const payload = {
      deviceId: await signer.getDeviceId(),
      instrumentId: 'bench',
      materialId: 'bio:cell_line:bench',
      materialType: 'CELL_LINE' as const,
      credentialType: 'QC_MYCO' as const,
      rawArtifactHash: h,
      captureTs: Math.floor(Date.now() / 1000),
    };
    const canon = canonicalize(payload);
    const t2 = performance.now();

    const commitment = commitmentHashForPayload(payload);
    await signAttestation(signer, payload, h, commitment);
    const t3 = performance.now();

    hashTimes.push(t1 - t0);
    canonTimes.push(t2 - t1);
    signTimes.push(t3 - t2);
    e2eTimes.push(t3 - t0);
  }

  const report = {
    iterations: ITER,
    platform: {
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      hostname: os.hostname(),
      nodeVersion: process.version,
      signerType: process.env.SIGNER_TYPE ?? 'software',
      os: `${os.platform()} ${os.release()}`,
    },
    sha256_1MB_ms: quantiles(hashTimes),
    canonicalize_ms: quantiles(canonTimes),
    ecdsa_sign_ms: quantiles(signTimes),
    end_to_end_ms: quantiles(e2eTimes),
  };
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join('./', `edge-overhead-${os.hostname()}-${Date.now()}.json`),
    JSON.stringify(report, null, 2)
  );
  fs.unlinkSync(tmp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
