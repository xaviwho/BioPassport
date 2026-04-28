/**
 * Provision issuer accounts for live PureChain concurrent throughput testing.
 *
 * Run:
 *   npm exec ts-node -- multi-account-setup.ts --accounts 20
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Contract, Wallet, ethers } from 'ethers';
import { bytes32FromLabel, createProvider, createWallet, getEvalEnv, loadRegistryArtifact } from './eval-utils';

interface MaterialTarget {
  materialId: string;
  txHash: string;
}

interface ProvisionedAccount {
  index: number;
  address: string;
  privateKey: string;
  fundingStatus: string;
  fundingTxHash?: string;
  authorized: boolean;
  authorizationTxHash?: string;
  permission?: {
    isApproved: boolean;
    canIssueIdentity: boolean;
    canIssueQC: boolean;
    canIssueUsageRights: boolean;
  };
  materials: MaterialTarget[];
}

function argVal(k: string, def: number): number {
  const eq = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (eq) return Number(eq.split('=')[1]);
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function hasFlag(k: string): boolean {
  return process.argv.includes(`--${k}`);
}

function outputPath(): string {
  return path.resolve(__dirname, 'multi-account-wallets.json');
}

async function sendContractTx(
  wallet: Wallet,
  contract: Contract,
  nonceRef: { next: number },
  method: string,
  args: unknown[],
  gasLimit = 500000n
): Promise<any> {
  const address = await wallet.getAddress();
  const pending = await wallet.provider!.getTransactionCount(address, 'pending');
  nonceRef.next = Math.max(nonceRef.next, pending);

  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = nonceRef.next;
    const txReq = {
      to: await contract.getAddress(),
      data: contract.interface.encodeFunctionData(method, args),
      gasPrice: 0n,
      gasLimit,
      nonce,
    };

    try {
      const tx = await wallet.sendTransaction(txReq);
      const receipt = await tx.wait();
      nonceRef.next = Math.max(nonceRef.next + 1, nonce + 1);
      return receipt;
    } catch (e: any) {
      const msg = e?.message || '';
      if (
        attempt === 0 &&
        (e?.code === 'NONCE_EXPIRED' ||
          msg.includes('nonce too low') ||
          msg.includes('nonce has already been used'))
      ) {
        nonceRef.next = await wallet.provider!.getTransactionCount(address, 'pending');
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  const accountCount = argVal('accounts', 20);
  const materialsPerAccount = argVal('materials-per-account', 20);
  const fundWei = BigInt(argVal('fund-wei', 0));
  const overwrite = hasFlag('force');

  const out = outputPath();
  if (fs.existsSync(out) && !overwrite) {
    throw new Error(`${out} already exists. Pass --force to overwrite or move it aside.`);
  }

  const env = getEvalEnv();
  const provider = createProvider(env);
  const admin = createWallet(env);
  const { abi } = loadRegistryArtifact();
  const adminContract = new Contract(env.registryAddress, abi, admin);
  const adminNonce = { next: await provider.getTransactionCount(admin.address, 'pending') };

  const adminBalance = await provider.getBalance(admin.address);
  if (fundWei > 0n && adminBalance < fundWei * BigInt(accountCount)) {
    throw new Error(`Admin balance ${adminBalance} wei is insufficient to fund ${accountCount} accounts with ${fundWei} wei each.`);
  }

  const setupStarted = performance.now();
  const accounts: ProvisionedAccount[] = Array.from({ length: accountCount }, (_, index) => {
    const wallet = ethers.Wallet.createRandom();
    return {
      index,
      address: wallet.address,
      privateKey: wallet.privateKey,
      fundingStatus: fundWei > 0n ? 'pending' : 'skipped_zero_gas_admin_balance_0',
      authorized: false,
      materials: [],
    };
  });

  const fundingStarted = performance.now();
  if (fundWei > 0n) {
    for (const account of accounts) {
      const nonce = adminNonce.next;
      const tx = await admin.sendTransaction({
        to: account.address,
        value: fundWei,
        gasPrice: 0n,
        gasLimit: 21000n,
        nonce,
      });
      await tx.wait();
      adminNonce.next = nonce + 1;
      account.fundingStatus = 'funded';
      account.fundingTxHash = tx.hash;
      console.log(`[fund] ${account.index} ${account.address} ${tx.hash}`);
    }
  }
  const fundingMs = performance.now() - fundingStarted;

  const authStarted = performance.now();
  for (const account of accounts) {
    const receipt = await sendContractTx(
      admin,
      adminContract,
      adminNonce,
      'authorizeIssuer',
      [account.address, true, true, true],
      250000n
    );
    account.authorized = true;
    account.authorizationTxHash = receipt.hash;
    const perm = await adminContract.issuerPermissions(account.address);
    account.permission = {
      isApproved: Boolean(perm.isApproved ?? perm[0]),
      canIssueIdentity: Boolean(perm.canIssueIdentity ?? perm[1]),
      canIssueQC: Boolean(perm.canIssueQC ?? perm[2]),
      canIssueUsageRights: Boolean(perm.canIssueUsageRights ?? perm[3]),
    };
    console.log(`[auth] ${account.index} ${account.address} ${receipt.hash}`);
  }
  const authorizationMs = performance.now() - authStarted;

  const materialStarted = performance.now();
  const materialStartCount = Number(await adminContract.materialCount());
  const materialReceipts: Array<{
    accountIndex: number;
    localIndex: number;
    txHash: string;
    blockNumber: number;
    transactionIndex: number;
  }> = [];

  await Promise.all(
    accounts.map(async (account) => {
      const wallet = new Wallet(account.privateKey, provider);
      const contract = new Contract(env.registryAddress, abi, wallet);
      const nonceRef = { next: await provider.getTransactionCount(account.address, 'pending') };

      for (let i = 0; i < materialsPerAccount; i++) {
        const receipt = await sendContractTx(
          wallet,
          contract,
          nonceRef,
          'registerMaterial',
          ['CELL_LINE', bytes32FromLabel(`multi-account:${account.index}:${i}:${Date.now()}`), 'Org1MSP'],
          300000n
        );
        materialReceipts.push({
          accountIndex: account.index,
          localIndex: i,
          txHash: receipt.hash,
          blockNumber: Number(receipt.blockNumber),
          transactionIndex: Number(receipt.index ?? receipt.transactionIndex ?? 0),
        });
      }
    })
  );

  materialReceipts.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex);
  materialReceipts.forEach((receipt, rank) => {
    const account = accounts[receipt.accountIndex];
    account.materials[receipt.localIndex] = {
      materialId: `bio:cell_line:${materialStartCount + rank + 1}`,
      txHash: receipt.txHash,
    };
  });

  for (const account of accounts) {
    console.log(`[materials] ${account.index} ${account.address} count=${account.materials.length}`);
  }
  const materialsMs = performance.now() - materialStarted;

  const payload = {
    generatedAt: new Date().toISOString(),
    registryAddress: env.registryAddress,
    chainId: env.chainId,
    admin: admin.address,
    accountCount,
    materialsPerAccount,
    funding: {
      fundWei: fundWei.toString(),
      adminBalanceWei: adminBalance.toString(),
      note:
        fundWei === 0n
          ? 'Positive funding skipped because PureChain uses zero-gas transactions and the admin balance is 0 wei.'
          : 'Accounts funded with the requested native-token amount.',
    },
    timingsMs: {
      funding: fundingMs,
      authorization: authorizationMs,
      materialRegistration: materialsMs,
      total: performance.now() - setupStarted,
    },
    accounts,
  };

  fs.writeFileSync(out, JSON.stringify(payload, null, 2));

  const authorized = accounts.filter((a) => a.permission?.isApproved).length;
  const materialCount = accounts.reduce((sum, a) => sum + a.materials.length, 0);
  console.log('\n=== Multi-account setup complete ===');
  console.log(`walletFile=${out}`);
  console.log(`accounts=${accounts.length}`);
  console.log(`authorized=${authorized}`);
  console.log(`materials=${materialCount}`);
  console.log(`fundingMs=${fundingMs.toFixed(1)}`);
  console.log(`authorizationMs=${authorizationMs.toFixed(1)}`);
  console.log(`materialRegistrationMs=${materialsMs.toFixed(1)}`);
  console.log(`totalMs=${payload.timingsMs.total.toFixed(1)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
