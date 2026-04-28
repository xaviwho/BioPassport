/**
 * Measure verification latency as registry state grows.
 *
 * Use a dedicated registry address:
 *   $env:PURECHAIN_SCALING_REGISTRY="0x..."
 *   npm exec ts-node -- scaling-state-growth.ts --max 31623 --batch 100
 */
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bytes32FromLabel, createEvalClient, createRegistryContract, getEvalEnv, resultMaterialId } from './eval-utils';

const DEFAULT_CHECKPOINTS = [100, 316, 1000, 3162, 10000, 31623, 100000];

function argVal(k: string, def: number): number {
  const eq = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function q(xs: number[], p: number): number {
  return xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
}

async function must<T extends { status?: string; error?: string }>(result: T): Promise<T> {
  if (result.status === 'FAILED') {
    throw new Error(result.error || 'operation failed');
  }
  return result;
}

async function createProbeMaterial(client: ReturnType<typeof createEvalClient>): Promise<string> {
  const registered = await must(await client.registerMaterial('CELL_LINE', bytes32FromLabel(`scale-probe:${Date.now()}`)));
  const materialId = resultMaterialId(registered);
  await must(
    await client.issueCredential(
      materialId,
      'IDENTITY',
      bytes32FromLabel(`${materialId}:identity`),
      0,
      's3://scale/probe/identity',
      bytes32FromLabel(`${materialId}:identity:artifact`),
      'Org1MSP'
    )
  );
  await must(
    await client.issueCredential(
      materialId,
      'QC_MYCO',
      bytes32FromLabel(`${materialId}:qc`),
      Math.floor(Date.now() / 1000) + 86400 * 30,
      's3://scale/probe/qc',
      bytes32FromLabel(`${materialId}:qc:artifact`),
      'Org1MSP'
    )
  );
  return materialId;
}

async function main() {
  const max = argVal('max', 10000);
  const batchSize = Math.min(argVal('batch', 100), 100);
  const verifySamples = argVal('verify-samples', 200);
  const historySamples = argVal('history-samples', 50);
  const scalingRegistry = process.env.PURECHAIN_SCALING_REGISTRY;
  if (!scalingRegistry) {
    throw new Error('Missing PURECHAIN_SCALING_REGISTRY. Refusing to fall back to REGISTRY_ADDRESS for the state-growth experiment.');
  }
  const env = getEvalEnv({ registryAddress: scalingRegistry });

  if (env.registryAddress === '0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC') {
    throw new Error('Refusing to run state-growth against the production/live demo registry. Set PURECHAIN_SCALING_REGISTRY to a dedicated deployment.');
  }

  const registry = createRegistryContract(env.registryAddress);
  const client = createEvalClient({ registryAddress: env.registryAddress });
  await client.connect();
  const checkpoints = DEFAULT_CHECKPOINTS.filter((c) => c <= max);
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `scaling-state-growth-${Date.now()}.json`);

  const probeId = await createProbeMaterial(client);
  let materialCount = Number(await registry.materialCount());
  const results: any[] = [];
  console.log(`Using scaling registry ${env.registryAddress}`);
  console.log(`Probe material: ${probeId}`);

  for (const checkpoint of checkpoints) {
    console.log(`\n=== checkpoint ${checkpoint} ===`);
    while (materialCount < checkpoint) {
      const n = Math.min(batchSize, checkpoint - materialCount);
      const types = Array.from({ length: n }, () => 'CELL_LINE');
      const hashes = Array.from({ length: n }, (_, i) => {
        const x = materialCount + i + 1;
        return `0x${x.toString(16).padStart(64, '0')}`;
      });
      const orgs = Array.from({ length: n }, () => 'ScaleOrg');
      const tx = await registry.batchRegisterMaterials(types, hashes, orgs, { gasPrice: 0 });
      await tx.wait();
      materialCount += n;
      if (materialCount % 1000 === 0 || materialCount === checkpoint) {
        console.log(`  registered ${materialCount}/${checkpoint}`);
      }
    }

    const verifyLats: number[] = [];
    for (let i = 0; i < verifySamples; i++) {
      const t0 = performance.now();
      await registry.verifyMaterial(probeId);
      verifyLats.push(performance.now() - t0);
    }
    verifyLats.sort((a, b) => a - b);

    const historyLats: number[] = [];
    for (let i = 0; i < historySamples; i++) {
      const t0 = performance.now();
      const count = await registry.getHistoryCount(probeId);
      await registry.getHistorySlice(probeId, 0, Number(count));
      historyLats.push(performance.now() - t0);
    }
    historyLats.sort((a, b) => a - b);

    const row = {
      registry: env.registryAddress,
      probeMaterialId: probeId,
      registrySize: checkpoint,
      verifyOnChain: { p50: q(verifyLats, 0.5), p99: q(verifyLats, 0.99), n: verifyLats.length },
      getHistory: { p50: q(historyLats, 0.5), p99: q(historyLats, 0.99), n: historyLats.length },
      probeHistoryCount: Number(await registry.getHistoryCount(probeId)),
    };
    results.push(row);
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`size=${checkpoint} verify p50=${row.verifyOnChain.p50.toFixed(1)}ms p99=${row.verifyOnChain.p99.toFixed(1)}ms`);
  }

  console.log(`\nWrote ${out}`);
  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
