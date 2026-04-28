import * as fs from 'node:fs';
import * as path from 'node:path';
import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { createPureChainClient } from '../issuer-service/src/purechain-client';

export const DEFAULT_REGISTRY = '0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC';
export const DEFAULT_CHAIN_ID = 900520900520;
export const DEFAULT_RPC_URL = 'https://purechainnode.com:8547';

export interface EvalEnv {
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  registryAddress: string;
  orgId: string;
}

export function loadEnvFile(envPath = path.resolve(__dirname, '../issuer-service/.env')) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

export function getEvalEnv(overrides: Partial<EvalEnv> = {}): EvalEnv {
  loadEnvFile();
  const privateKey = overrides.privateKey || process.env.OPERATOR_PRIVATE_KEY || process.env.PURECHAIN_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Missing OPERATOR_PRIVATE_KEY or PURECHAIN_PRIVATE_KEY');
  }
  return {
    rpcUrl: overrides.rpcUrl || process.env.PURECHAIN_RPC || process.env.RPC_URL || DEFAULT_RPC_URL,
    chainId: overrides.chainId || Number(process.env.CHAIN_ID || DEFAULT_CHAIN_ID),
    privateKey: privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`,
    registryAddress:
      overrides.registryAddress ||
      process.env.REGISTRY_ADDRESS ||
      process.env.BIOPASSPORT_CONTRACT_ADDRESS ||
      process.env.CONTRACT_ADDRESS ||
      DEFAULT_REGISTRY,
    orgId: overrides.orgId || process.env.PURECHAIN_ORG_ID || process.env.ISSUER_ORG_ID || 'Org1MSP',
  };
}

export function createEvalClient(overrides: Partial<EvalEnv> = {}) {
  const env = getEvalEnv(overrides);
  return createPureChainClient({
    network: { name: 'purechain', chainId: env.chainId, rpcUrl: env.rpcUrl },
    privateKey: env.privateKey,
    contractAddress: env.registryAddress,
    orgId: env.orgId,
  });
}

export function createProvider(env = getEvalEnv()) {
  return new JsonRpcProvider(env.rpcUrl, { name: 'purechain', chainId: env.chainId });
}

export function createWallet(env = getEvalEnv()) {
  return new Wallet(env.privateKey, createProvider(env));
}

export function loadRegistryArtifact(): { abi: any[]; bytecode: string } {
  const artifactPath = path.resolve(__dirname, '../contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error('BioPassportRegistry artifact not found. Run `npm exec hardhat compile` in contracts first.');
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

export function createRegistryContract(address = getEvalEnv().registryAddress) {
  const { abi } = loadRegistryArtifact();
  return new Contract(address, abi, createWallet());
}

export function bytes32FromLabel(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

export function resultMaterialId(result: any): string {
  const id = result?.materialId || result?.result?.materialId;
  if (!id) throw new Error(`registerMaterial did not return materialId: ${JSON.stringify(result)}`);
  return id;
}

export function reasonCodes(result: any): string[] {
  const reasons = result?.reasons || [];
  return reasons.map((r: any) => (typeof r === 'string' ? r : r.code || r.message || String(r)));
}

export async function enrollEphemeralDevice(prefix: string) {
  const registry = createRegistryContract();
  const device = ethers.Wallet.createRandom();
  const deviceId = ethers.keccak256(ethers.toUtf8Bytes(`${prefix}:${Date.now()}:${Math.random()}`));
  const tx = await registry.enrollDevice(deviceId, device.address, 'MICROSCOPE', { gasPrice: 0 });
  await tx.wait();
  return { device, deviceId };
}

export async function signAttestationForContract(args: {
  device: ethers.Wallet | ethers.HDNodeWallet;
  deviceId: string;
  materialId: string;
  credType: number;
  commitmentHash: string;
  artifactHash: string;
  captureTs: number;
}) {
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'string', 'uint8', 'bytes32', 'bytes32', 'uint256'],
    [args.deviceId, args.materialId, args.credType, args.commitmentHash, args.artifactHash, args.captureTs]
  );
  const digest = ethers.keccak256(payload);
  return args.device.signMessage(ethers.getBytes(digest));
}
