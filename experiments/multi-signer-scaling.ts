/**
 * Besu Clique multi-signer throughput driver.
 *
 * Assumes a local Besu cluster is already running and BESU_REGISTRY points to a
 * freshly deployed BioPassportRegistry.
 *
 * Run:
 *   npm exec ts-node -- multi-signer-scaling.ts --signers 3 --concurrency-levels 1,5,10,20 --ops-per-client 30
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';

interface TxSample {
  signers: number;
  concurrency: number;
  clientIndex: number;
  opIndex: number;
  success: boolean;
  latencyMs: number;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

function argStr(k: string, def: string): string {
  const eq = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function argNum(k: string, def: number): number {
  return Number(argStr(k, String(def)));
}

function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(xs: number[]) {
  return {
    n: xs.length,
    p50: quantile(xs, 0.5),
    p99: quantile(xs, 0.99),
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
  };
}

function reasonKey(error: string): string {
  if (/nonce/i.test(error)) return 'NONCE_ERROR';
  if (/timeout|ECONNRESET|ETIMEDOUT|502|503|504/i.test(error)) return 'RPC_OR_TIMEOUT';
  if (/revert|execution reverted/i.test(error)) return 'REVERT';
  return 'OTHER';
}

function loadRegistryAbi(): any[] {
  const artifactPath = path.resolve(__dirname, '../contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  return artifact.abi;
}

function loadBenchmarkAccounts(): Array<{ privateKey: string; address: string }> {
  const validatorPath = path.resolve(__dirname, 'besu-cluster/validators.json');
  const data = JSON.parse(fs.readFileSync(validatorPath, 'utf8'));
  return data.benchmarkAccounts;
}

async function sendRegisterMaterial(args: {
  provider: JsonRpcProvider;
  wallet: Wallet;
  contract: Contract;
  nonceRef: { next: number };
  signers: number;
  concurrency: number;
  clientIndex: number;
  opIndex: number;
}): Promise<TxSample> {
  const started = performance.now();
  const { provider, wallet, contract, nonceRef, signers, concurrency, clientIndex, opIndex } = args;
  const address = await wallet.getAddress();

  try {
    const pending = await provider.getTransactionCount(address, 'pending');
    nonceRef.next = Math.max(nonceRef.next, pending);

    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = nonceRef.next;
      try {
        const tx = await wallet.sendTransaction({
          to: await contract.getAddress(),
          data: contract.interface.encodeFunctionData('registerMaterial', [
            'CELL_LINE',
            ethers.keccak256(ethers.toUtf8Bytes(`besu:${signers}:${concurrency}:${clientIndex}:${opIndex}:${Date.now()}`)),
            `BesuOrg${clientIndex}`,
          ]),
          gasPrice: 0n,
          gasLimit: 500000n,
          nonce,
        });
        const receipt = await tx.wait();
        nonceRef.next = Math.max(nonceRef.next + 1, nonce + 1);
        return {
          signers,
          concurrency,
          clientIndex,
          opIndex,
          success: true,
          latencyMs: performance.now() - started,
          txHash: tx.hash,
          blockNumber: Number(receipt?.blockNumber),
        };
      } catch (e: any) {
        const msg = e?.message || '';
        if (
          attempt === 0 &&
          (e?.code === 'NONCE_EXPIRED' ||
            msg.includes('nonce too low') ||
            msg.includes('nonce has already been used'))
        ) {
          nonceRef.next = await provider.getTransactionCount(address, 'pending');
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw e;
      }
    }
    throw new Error('sendRegisterMaterial exhausted retry loop');
  } catch (e: any) {
    return {
      signers,
      concurrency,
      clientIndex,
      opIndex,
      success: false,
      latencyMs: performance.now() - started,
      error: e?.message || String(e),
    };
  }
}

async function minerStats(provider: JsonRpcProvider, fromBlock: number, toBlock: number) {
  const miners: Record<string, number> = {};
  const timestamps: number[] = [];
  for (let n = fromBlock; n <= toBlock; n++) {
    const hex = '0x' + n.toString(16);
    const block = await provider.send('eth_getBlockByNumber', [hex, false]);
    if (!block) continue;
    const miner = String(block.miner || block.author || 'unknown').toLowerCase();
    miners[miner] = (miners[miner] || 0) + 1;
    timestamps.push(Number.parseInt(block.timestamp, 16));
  }
  const intervals = timestamps.slice(1).map((t, i) => t - timestamps[i]).filter((x) => x >= 0);
  return {
    miners,
    averageBlockSeconds: intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0,
    sampledBlocks: timestamps.length,
  };
}

async function runLevel(args: {
  provider: JsonRpcProvider;
  abi: any[];
  registry: string;
  signers: number;
  concurrency: number;
  opsPerClient: number;
  accounts: Array<{ privateKey: string; address: string }>;
}) {
  const { provider, abi, registry, signers, concurrency, opsPerClient, accounts } = args;
  const latestBefore = await provider.getBlockNumber();
  const wallStart = performance.now();

  const nested = await Promise.all(
    accounts.slice(0, concurrency).map(async (account, clientIndex) => {
      const wallet = new Wallet(account.privateKey, provider);
      const contract = new Contract(registry, abi, wallet);
      const nonceRef = { next: await provider.getTransactionCount(account.address, 'pending') };
      const samples: TxSample[] = [];
      for (let opIndex = 0; opIndex < opsPerClient; opIndex++) {
        samples.push(await sendRegisterMaterial({ provider, wallet, contract, nonceRef, signers, concurrency, clientIndex, opIndex }));
      }
      return samples;
    })
  );

  const wallClockS = (performance.now() - wallStart) / 1000;
  const latestAfter = await provider.getBlockNumber();
  const samples = nested.flat();
  const successes = samples.filter((s) => s.success);
  const failures = samples.filter((s) => !s.success);
  const failureReasons = failures.reduce<Record<string, number>>((acc, f) => {
    const key = reasonKey(f.error || '');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const miners = await minerStats(provider, latestBefore, latestAfter);

  return {
    summary: {
      signers,
      concurrency,
      opsPerClient,
      totalOps: samples.length,
      successfulOps: successes.length,
      failedOps: failures.length,
      failureReasons,
      wallClockS,
      opsPerSec: successes.length / wallClockS,
      latencyMs: summarize(successes.map((s) => s.latencyMs)),
      blockWindow: { from: latestBefore, to: latestAfter, blocks: latestAfter - latestBefore },
      minerStats: miners,
    },
    samples,
  };
}

async function main() {
  const signers = argNum('signers', 1);
  const concurrencyLevels = argStr('concurrency-levels', '1,5,10,20').split(',').map((x) => Number(x.trim())).filter(Boolean);
  const opsPerClient = argNum('ops-per-client', 30);
  const rpcUrl = argStr('rpc-url', process.env.BESU_RPC || 'http://localhost:8545');
  const registry = argStr('registry', process.env.BESU_REGISTRY || '');
  if (!registry) throw new Error('Missing BESU_REGISTRY or --registry');

  const provider = new JsonRpcProvider(rpcUrl, { name: 'besu-clique', chainId: 2026 }, { staticNetwork: true });
  const abi = loadRegistryAbi();
  const accounts = loadBenchmarkAccounts();
  if (accounts.length < Math.max(...concurrencyLevels)) {
    throw new Error(`Need ${Math.max(...concurrencyLevels)} benchmark accounts, have ${accounts.length}`);
  }

  const results: any[] = [];
  const allSamples: TxSample[] = [];
  for (const concurrency of concurrencyLevels) {
    console.log(`=== signers=${signers} concurrency=${concurrency} opsPerClient=${opsPerClient} ===`);
    const level = await runLevel({ provider, abi, registry, signers, concurrency, opsPerClient, accounts });
    results.push(level.summary);
    allSamples.push(...level.samples);
    console.log(
      `ops/s=${level.summary.opsPerSec.toFixed(3)} p50=${level.summary.latencyMs.p50.toFixed(1)}ms ` +
      `p99=${level.summary.latencyMs.p99.toFixed(1)}ms failures=${level.summary.failedOps}`
    );
  }

  const outDir = path.resolve(__dirname, 'results', 'multi-signer');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `multi-signer-scaling-s${signers}-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ signers, registry, rpcUrl, results, samples: allSamples }, null, 2));
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
