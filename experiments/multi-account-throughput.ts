/**
 * Measure live PureChain write throughput with K concurrent issuer accounts.
 *
 * Run:
 *   npm exec ts-node -- multi-account-throughput.ts --accounts 20 --ops-per-account 20
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Contract, Wallet } from 'ethers';
import { bytes32FromLabel, createProvider, getEvalEnv, loadRegistryArtifact } from './eval-utils';

interface WalletFileAccount {
  index: number;
  address: string;
  privateKey: string;
  authorized: boolean;
  materials: { materialId: string; txHash: string }[];
}

interface TxSample {
  accountIndex: number;
  account: string;
  opIndex: number;
  materialId: string;
  success: boolean;
  latencyMs: number;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

function argVal(k: string, def: number): number {
  const eq = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarizeLatencies(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {
    n: xs.length,
    p50: quantile(sorted, 0.5),
    p99: quantile(sorted, 0.99),
    mean,
  };
}

function reasonKey(error: string): string {
  if (/NONCE_EXPIRED|nonce too low|nonce has already been used/i.test(error)) return 'NONCE_ERROR';
  if (/timeout|ETIMEDOUT|ECONNRESET|502|503|504/i.test(error)) return 'RPC_OR_TIMEOUT';
  if (/revert|execution reverted/i.test(error)) return 'REVERT';
  return 'OTHER';
}

async function sendIssueCredentialTx(args: {
  wallet: Wallet;
  contract: Contract;
  nonceRef: { next: number };
  materialId: string;
  accountIndex: number;
  opIndex: number;
}): Promise<TxSample> {
  const started = performance.now();
  const { wallet, contract, nonceRef, materialId, accountIndex, opIndex } = args;
  const account = await wallet.getAddress();

  try {
    const pending = await wallet.provider!.getTransactionCount(account, 'pending');
    nonceRef.next = Math.max(nonceRef.next, pending);

    let lastError: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = nonceRef.next;
      try {
        const tx = await wallet.sendTransaction({
          to: await contract.getAddress(),
          data: contract.interface.encodeFunctionData('issueCredential', [
            materialId,
            1,
            bytes32FromLabel(`multi-account-issue:${accountIndex}:${opIndex}:${Date.now()}`),
            0,
            `s3://multi-account/${accountIndex}/${opIndex}`,
            bytes32FromLabel(`multi-account-art:${accountIndex}:${opIndex}`),
            `Org1MSP-${accountIndex}`,
          ]),
          gasPrice: 0n,
          gasLimit: 500000n,
          nonce,
        });
        const receipt = await tx.wait();
        nonceRef.next = Math.max(nonceRef.next + 1, nonce + 1);
        return {
          accountIndex,
          account,
          opIndex,
          materialId,
          success: true,
          latencyMs: performance.now() - started,
          txHash: tx.hash,
          blockNumber: receipt?.blockNumber,
        };
      } catch (e: any) {
        lastError = e;
        const msg = e?.message || '';
        if (e?.receipt || e?.transactionHash || e?.hash) {
          // Reverted transactions still consume the nonce.
          nonceRef.next = Math.max(nonceRef.next + 1, nonce + 1);
        }
        if (
          attempt === 0 &&
          (e?.code === 'NONCE_EXPIRED' ||
            msg.includes('nonce too low') ||
            msg.includes('nonce has already been used'))
        ) {
          nonceRef.next = await wallet.provider!.getTransactionCount(account, 'pending');
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  } catch (e: any) {
    return {
      accountIndex,
      account,
      opIndex,
      materialId,
      success: false,
      latencyMs: performance.now() - started,
      error: e?.message || String(e),
    };
  }
}

async function main() {
  const requestedAccounts = argVal('accounts', 1);
  const opsPerAccount = argVal('ops-per-account', 20);
  const walletPath = path.resolve(__dirname, 'multi-account-wallets.json');
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Missing ${walletPath}. Run multi-account-setup.ts first.`);
  }

  const env = getEvalEnv();
  const provider = createProvider(env);
  const { abi } = loadRegistryArtifact();
  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  const accounts = (walletData.accounts as WalletFileAccount[]).slice(0, requestedAccounts);

  if (accounts.length < requestedAccounts) {
    throw new Error(`Requested ${requestedAccounts} accounts but wallet file only has ${accounts.length}.`);
  }
  for (const account of accounts) {
    if (!account.authorized) throw new Error(`Account ${account.index} is not marked authorized.`);
    if ((account.materials || []).length < opsPerAccount) {
      throw new Error(`Account ${account.index} has ${account.materials?.length || 0} materials, need ${opsPerAccount}.`);
    }
    const invalidMaterial = account.materials.slice(0, opsPerAccount).find((m) => typeof m.materialId !== 'string' || !m.materialId.startsWith('bio:'));
    if (invalidMaterial) {
      throw new Error(`Account ${account.index} has invalid material target: ${JSON.stringify(invalidMaterial)}`);
    }
  }

  const latestBefore = await provider.getBlock('latest');
  const wallStart = performance.now();

  const nested = await Promise.all(
    accounts.map(async (account) => {
      const wallet = new Wallet(account.privateKey, provider);
      const contract = new Contract(env.registryAddress, abi, wallet);
      const nonceRef = { next: await provider.getTransactionCount(account.address, 'pending') };
      const samples: TxSample[] = [];

      for (let i = 0; i < opsPerAccount; i++) {
        const materialId = account.materials[i].materialId;
        const sample = await sendIssueCredentialTx({
          wallet,
          contract,
          nonceRef,
          materialId,
          accountIndex: account.index,
          opIndex: i,
        });
        samples.push(sample);
      }

      return samples;
    })
  );

  const wallClockS = (performance.now() - wallStart) / 1000;
  const latestAfter = await provider.getBlock('latest');
  const samples = nested.flat();
  const successes = samples.filter((s) => s.success);
  const failures = samples.filter((s) => !s.success);
  const failureReasons = failures.reduce<Record<string, number>>((acc, f) => {
    const key = reasonKey(f.error || '');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const perAccount = accounts.map((account) => {
    const own = samples.filter((s) => s.accountIndex === account.index);
    const ownSuccess = own.filter((s) => s.success);
    return {
      accountIndex: account.index,
      address: account.address,
      submitted: own.length,
      successful: ownSuccess.length,
      failed: own.length - ownSuccess.length,
      latencyMs: summarizeLatencies(ownSuccess.map((s) => s.latencyMs)),
    };
  });

  const summary = {
    registryAddress: env.registryAddress,
    chainId: env.chainId,
    accounts: accounts.length,
    opsPerAccount,
    submitted: samples.length,
    successful: successes.length,
    failed: failures.length,
    failureReasons,
    wallClockS,
    aggregateOpsPerSec: successes.length / wallClockS,
    latencyMs: summarizeLatencies(successes.map((s) => s.latencyMs)),
    blockWindow: {
      before: latestBefore
        ? { number: latestBefore.number, timestamp: latestBefore.timestamp }
        : null,
      after: latestAfter
        ? { number: latestAfter.number, timestamp: latestAfter.timestamp }
        : null,
      blockCount:
        latestBefore && latestAfter
          ? Number(latestAfter.number) - Number(latestBefore.number)
          : null,
      seconds:
        latestBefore && latestAfter
          ? Number(latestAfter.timestamp) - Number(latestBefore.timestamp)
          : null,
    },
    perAccount,
  };

  const outDir = path.resolve(__dirname, 'results', 'multi-account');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `multi-account-throughput-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, samples }, null, 2));

  console.log('\n=== Multi-account throughput ===');
  console.log(`json=${out}`);
  console.log(`accounts=${summary.accounts}`);
  console.log(`opsPerAccount=${opsPerAccount}`);
  console.log(`submitted=${summary.submitted}`);
  console.log(`successful=${summary.successful}`);
  console.log(`failed=${summary.failed}`);
  console.log(`wallClockS=${summary.wallClockS.toFixed(3)}`);
  console.log(`aggregateOpsPerSec=${summary.aggregateOpsPerSec.toFixed(4)}`);
  console.log(`latencyP50Ms=${summary.latencyMs.p50.toFixed(1)}`);
  console.log(`latencyP99Ms=${summary.latencyMs.p99.toFixed(1)}`);
  console.log(`failureReasons=${JSON.stringify(summary.failureReasons)}`);
  console.log(`blockWindow=${JSON.stringify(summary.blockWindow)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
