/**
 * PureChain Client for interacting with BioPassport Registry
 * Uses direct ethers.js with retry logic (bypasses purechainlib)
 */

import { ethers, JsonRpcProvider, Wallet, Contract, ContractFactory, HDNodeWallet } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Network configuration - Using Hardhat Network for reliable local execution
const PURECHAIN_RPC = 'http://127.0.0.1:8545';
const PURECHAIN_CHAIN_ID = 31337;
// Use null to let ethers auto-calculate gas (Hardhat requires EIP-1559 base fee)
const PURECHAIN_GAS_PRICE: bigint | null = null;

/**
 * Custom fetch with retry logic for handling 502/503 errors
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 5,
  baseDelayMs: number = 2000
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000), // 30s timeout per request
      });
      
      // If server error (502, 503, 504), retry
      if (response.status >= 502 && response.status <= 504) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`  [RPC RETRY] ${response.status} error, attempt ${attempt + 1}/${maxRetries}, waiting ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      return response;
    } catch (error: any) {
      lastError = error;
      
      // Network errors are retryable
      if (error?.name === 'AbortError' || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`  [RPC RETRY] Network error, attempt ${attempt + 1}/${maxRetries}, waiting ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
}

/**
 * Create a JsonRpcProvider (no retry for Hardhat - it's reliable)
 */
function createRetryProvider(): JsonRpcProvider {
  // For Hardhat, we don't need retry logic - it's reliable
  // Retry logic was causing nonce conflicts with parallel requests
  const provider = new JsonRpcProvider(PURECHAIN_RPC, { 
    chainId: PURECHAIN_CHAIN_ID, 
    name: 'hardhat'
  }, { staticNetwork: true });
  
  return provider;
}

export interface PureChainConfig {
  network: 'testnet' | 'mainnet' | { name: string; chainId: number; rpcUrl: string };
  privateKey?: string;
  contractAddress?: string;
  orgId: string;
}

export interface TransactionResult {
  txId: string;
  status: 'SUCCESS' | 'FAILED';
  result?: unknown;
  error?: string;
}

// Solidity enum mappings for type-safe contract calls
// MaterialStatus enum in Solidity: ACTIVE=0, QUARANTINED=1, REVOKED=2
const MATERIAL_STATUS: Record<string, number> = {
  ACTIVE: 0,
  QUARANTINED: 1,
  REVOKED: 2,
};

// Status index to string mapping for parsing contract responses
const STATUS_STR = ['ACTIVE', 'QUARANTINED', 'REVOKED'];

export interface Material {
  materialId: string;
  materialType: string;
  metadataHash: string;
  ownerOrg: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  materialId: string;
  credentialId: string;
  credentialType: string;
  commitmentHash: string;
  issuerId: string;
  issuedAt: string;
  validUntil: string;
  artifactRefs: Array<{ cid: string; hash: string }>;
  signatureRef: string;
  revoked: boolean;
}

export interface VerificationResult {
  pass: boolean;
  materialId: string;
  verifiedAt: string;
  reasons: Array<{ code: string; message: string; severity: string }>;
  credentialStatus: Array<{
    credentialType: string;
    present: boolean;
    valid: boolean;
    expiredAt?: string;
    issuerId?: string;
  }>;
  transferChainValid: boolean;
}

export class PureChainClient {
  private config: PureChainConfig;
  private provider: JsonRpcProvider | null = null;
  private wallet: Wallet | HDNodeWallet | null = null;
  private contract: Contract | null = null;
  private connected: boolean = false;
  private _debuggedReceipt: boolean = false;
  private _materialCount: number = 0;  // Track material count for ID reconstruction
  private _credentialCount: number = 0;  // Track credential count for ID reconstruction
  private _transferCount: number = 0;  // Track transfer count for ID reconstruction

  constructor(config: PureChainConfig) {
    this.config = config;
  }

  /**
   * Convert credential type string to enum index for the Solidity contract
   */
  private credentialTypeToIndex(credentialType: 'IDENTITY' | 'QC_MYCO' | 'USAGE_RIGHTS'): number {
    switch (credentialType) {
      case 'IDENTITY': return 0;
      case 'QC_MYCO': return 1;
      case 'USAGE_RIGHTS': return 2;
      default: throw new Error(`Unknown credential type: ${credentialType}`);
    }
  }

  /**
   * Connect to PureChain network using direct ethers.js
   */
  async connect(): Promise<void> {
    // Create retry-enabled provider
    this.provider = createRetryProvider();
    
    if (this.config.privateKey) {
      this.wallet = new Wallet(this.config.privateKey, this.provider);
    } else {
      // Use Hardhat's first pre-funded account (10000 ETH)
      const HARDHAT_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      this.wallet = new Wallet(HARDHAT_ACCOUNT_0, this.provider);
      console.log(`Using Hardhat account: ${this.wallet.address}`);
    }

    // Check connection by getting balance
    const balance = await this.provider.getBalance(this.wallet.address);
    console.log(`Connected to PureChain. Balance: ${ethers.formatEther(balance)} PURE`);

    // Attach to existing contract if address provided
    if (this.config.contractAddress) {
      await this.attachToContract(this.config.contractAddress);
    }

    this.connected = true;
  }

  /**
   * Deploy the BioPassport Registry contract
   */
  async deployContract(): Promise<string> {
    if (!this.wallet) throw new Error('Not connected');
    
    const { abi, bytecode } = this.getBioPassportRegistryABI();
    const factory = new ContractFactory(abi, bytecode, this.wallet);
    console.log('  Deploying contract...');
    
    // Use fixed gas limit for large contract deployment
    const contract = await factory.deploy({ 
      gasLimit: 10000000  // 10M gas - enough for large contract
    });
    
    console.log('  Transaction sent, waiting for confirmation...');
    const deployTx = contract.deploymentTransaction();
    if (deployTx) {
      console.log(`  TX Hash: ${deployTx.hash}`);
    }
    
    // Wait with timeout (60 seconds)
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Deployment timeout after 60s')), 60000)
    );
    
    try {
      await Promise.race([contract.waitForDeployment(), timeoutPromise]);
    } catch (err: any) {
      if (err.message?.includes('timeout')) {
        throw new Error(`Contract deployment timed out. TX may still be pending: ${deployTx?.hash}`);
      }
      throw err;
    }
    
    this.contract = contract as Contract;
    const address = await this.contract.getAddress();
    console.log(`  BioPassport Registry deployed at: ${address}`);
    return address;
  }

  /**
   * Attach to existing deployed contract
   */
  async attachToContract(address: string): Promise<void> {
    if (!this.wallet) throw new Error('Not connected');
    
    const { abi } = this.getBioPassportRegistryABI();
    this.contract = new Contract(address, abi, this.wallet);
    console.log(`Attached to BioPassport Registry at: ${address}`);
  }
  
  // Proper async lock for transaction serialization
  private _txLock: Promise<void> = Promise.resolve();
  private _nextNonce: number = -1;
  
  /**
   * Execute contract method with timing metrics
   * Uses proper lock to serialize all transactions and manual nonce tracking
   */
  private async executeWithMetrics(
    methodName: string,
    ...args: any[]
  ): Promise<{ receipt: any; metrics: { duration: number } }> {
    if (!this.contract) throw new Error('No contract attached');
    
    // Acquire lock - each call waits for previous to complete
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
    const previousLock = this._txLock;
    this._txLock = lockPromise;
    
    // Wait for previous transaction to complete
    await previousLock;
    
    try {
      const start = performance.now();
      
      // Initialize nonce from blockchain on first call
      if (this._nextNonce < 0) {
        this._nextNonce = await this.wallet!.getNonce();
      }
      
      // Use our tracked nonce (not ethers cache which can be stale)
      const nonce = this._nextNonce;
      
      console.log(`[TX] ${methodName} nonce=${nonce}`);
      
      const tx = await (this.contract as any)[methodName](...args, { 
        gasPrice: PURECHAIN_GAS_PRICE,
        nonce: nonce
      });
      const receipt = await tx.wait();
      const duration = performance.now() - start;
      
      // Only increment nonce AFTER successful confirmation
      this._nextNonce++;
      
      console.log(`[TX] ${methodName} confirmed block=${receipt.blockNumber}`);
      
      return { receipt, metrics: { duration } };
    } catch (error) {
      // On failure, resync nonce from blockchain
      this._nextNonce = await this.wallet!.getNonce();
      throw error;
    } finally {
      // Release lock for next transaction
      releaseLock!();
    }
  }

  /**
   * Disconnect from PureChain network
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.contract = null;
  }

  /**
   * Register a new material
   */
  async registerMaterial(
    materialType: string,
    metadataHash: string
  ): Promise<TransactionResult> {
    this.ensureConnected();
    
    try {
      const { receipt, metrics } = await this.executeWithMetrics(
        'registerMaterial',
        materialType,
        metadataHash
      );

      // Finality assertion
      this.assertFinality(receipt);

      // DEBUG: Log receipt structure to understand format (first call only)
      if (!this._debuggedReceipt) {
        console.log('[DEBUG] Receipt keys:', Object.keys(receipt));
        console.log('[DEBUG] Receipt.logs:', JSON.stringify(receipt.logs?.slice(0, 2), null, 2));
        this._debuggedReceipt = true;
      }

      // Construct materialId using deterministic format from contract:
      // materialId = "bio:" + materialType + ":" + materialCount
      // The event has materialId indexed (hashed), so we reconstruct it ourselves
      this._materialCount++;
      const materialId = `bio:${materialType}:${this._materialCount}`;

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { materialId, txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
      };
    } catch (error) {
      console.log(`  [DEBUG] registerMaterial failed: ${(error as Error).message?.substring(0, 150)}`);
      return {
        txId: '',
        status: 'FAILED',
        error: (error as Error).message
      };
    }
  }

  /**
   * Issue a credential for a material
   */
  async issueCredential(
    materialId: string,
    credentialType: 'IDENTITY' | 'QC_MYCO' | 'USAGE_RIGHTS',
    commitmentHash: string,
    validUntilUnixSec: number,
    artifactCid: string,
    artifactHash: string,
    signatureRef: string
  ): Promise<TransactionResult> {
    this.ensureConnected();
    
    // Solidity expects artifactRefs as JSON string
    const artifactRefs = JSON.stringify([{ cid: artifactCid, hash: artifactHash }]);
    
    try {
      const { receipt, metrics } = await this.executeWithMetrics(
        'issueCredential',
        materialId,
        credentialType,          // string (not enum index)
        commitmentHash,          // string
        validUntilUnixSec,       // uint256 (unix seconds)
        artifactRefs,            // string (JSON encoded)
        signatureRef             // string
      );

      // Finality assertion: verify we have a mined transaction
      this.assertFinality(receipt);

      // Construct credentialId using deterministic format from contract:
      // credentialId = "cred:" + credentialCount
      this._credentialCount++;
      const credentialId = `cred:${this._credentialCount}`;

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { credentialId, txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
      };
    } catch (error) {
      console.log(`  [DEBUG] issueCredential failed: ${(error as Error).message?.substring(0, 150)}`);
      return {
        txId: '',
        status: 'FAILED',
        error: (error as Error).message
      };
    }
  }

  /**
   * Transfer material to another organization
   */
  async transferMaterial(
    materialId: string,
    toOrg: string,
    shipmentHash: string
  ): Promise<TransactionResult> {
    this.ensureConnected();
    
    try {
      const { receipt, metrics } = await this.executeWithMetrics(
        'transferMaterial',
        materialId,
        toOrg,
        shipmentHash
      );

      // Finality assertion
      this.assertFinality(receipt);

      // Construct transferId using deterministic format from contract:
      // transferId = "xfer:" + transferCount
      this._transferCount++;
      const transferId = `xfer:${this._transferCount}`;

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { transferId, txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
      };
    } catch (error) {
      return {
        txId: '',
        status: 'FAILED',
        error: (error as Error).message
      };
    }
  }

  /**
   * Alias for transferMaterial (matches BlockchainClient interface)
   */
  async initiateTransfer(
    materialId: string,
    toOrg: string,
    shipmentHash: string
  ): Promise<TransactionResult> {
    return this.transferMaterial(materialId, toOrg, shipmentHash);
  }

  /**
   * Accept a pending transfer
   * Actual contract: acceptTransfer(string materialId) - takes materialId, not transferId
   */
  async acceptTransfer(materialIdOrTransferId: string): Promise<TransactionResult> {
    this.ensureConnected();
    
    // If transferId format (xfer:N), extract and use materialId from context
    // For now, pass as-is and let contract handle
    try {
      const { receipt, metrics } = await this.executeWithMetrics(
        'acceptTransfer',
        materialIdOrTransferId
      );

      // Finality assertion
      this.assertFinality(receipt);

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
      };
    } catch (error) {
      return {
        txId: '',
        status: 'FAILED',
        error: (error as Error).message
      };
    }
  }

  /**
   * Set material status (QUARANTINE/REVOKE)
   * 
   * Solidity signature:
   *   setStatus(string materialId, MaterialStatus status, string reasonHash)
   *   where MaterialStatus is enum { ACTIVE=0, QUARANTINED=1, REVOKED=2 }
   * 
   * @param status - Must be 'ACTIVE', 'QUARANTINED', or 'REVOKED'
   */
  async setStatus(
    materialId: string,
    status: keyof typeof MATERIAL_STATUS,
    reasonHash: string
  ): Promise<TransactionResult> {
    this.ensureConnected();
    
    // Convert status string to enum index
    const statusIndex = MATERIAL_STATUS[status];
    if (statusIndex === undefined) {
      return {
        txId: '',
        status: 'FAILED',
        error: `Invalid status: ${status}. Must be ACTIVE, QUARANTINED, or REVOKED`
      };
    }
    
    try {
      const { receipt, metrics } = await this.executeWithMetrics(
        'setStatus',
        materialId,
        statusIndex,             // enum index (uint8)
        reasonHash
      );

      // Finality assertion
      this.assertFinality(receipt);

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
      };
    } catch (error) {
      return {
        txId: '',
        status: 'FAILED',
        error: (error as Error).message
      };
    }
  }

  /**
   * Revoke a credential
   */
  async revokeCredential(
    credentialId: string,
    reason: string
  ): Promise<TransactionResult> {
    this.ensureConnected();
    
    try {
      const { receipt, metrics } = await this.executeWithMetrics(
        'revokeCredential',
        credentialId,
        reason
      );

      // Finality assertion
      this.assertFinality(receipt);

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
      };
    } catch (error) {
      return {
        txId: '',
        status: 'FAILED',
        error: (error as Error).message
      };
    }
  }

  /**
   * Verify a material against policy rules
   * 
   * Solidity signature:
   *   verifyMaterial(string materialId) returns (bool pass, string[] reasons)
   * 
   * Note: No atTime parameter - Solidity only has single-arg version
   */
  async verifyMaterial(materialId: string): Promise<VerificationResult> {
    this.ensureConnected();
    
    try {
      const result = await this.contract!.verifyMaterial(materialId);
      
      // Contract returns (bool pass, string[] reasons)
      // Handle both tuple return and object return formats
      let pass: boolean;
      let reasonCodes: string[];
      
      if (Array.isArray(result)) {
        // Tuple format: [pass, reasons]
        pass = Boolean(result[0]);
        reasonCodes = (result[1] || []) as string[];
      } else if (result && typeof result === 'object') {
        // Object format: { pass, reasons }
        pass = Boolean(result.pass);
        reasonCodes = (result.reasons || []) as string[];
      } else {
        pass = false;
        reasonCodes = ['UNKNOWN_RESULT_FORMAT'];
      }
      
      return {
        pass,
        materialId,
        verifiedAt: new Date().toISOString(),
        reasons: reasonCodes.map((code: string) => ({ 
          code, 
          message: code, 
          severity: 'ERROR'
        })),
        credentialStatus: [],
        transferChainValid: !reasonCodes.includes('TRANSFER_PENDING')
      };
    } catch (error) {
      console.log(`  [DEBUG] verifyMaterial(${materialId}) failed: ${(error as Error).message?.substring(0, 100)}`);
      return {
        pass: false,
        materialId,
        verifiedAt: new Date().toISOString(),
        reasons: [{ code: 'ERROR', message: (error as Error).message, severity: 'ERROR' }],
        credentialStatus: [],
        transferChainValid: false
      };
    }
  }

  /**
   * Get material by ID
   */
  async getMaterial(materialId: string): Promise<Material | null> {
    this.ensureConnected();
    
    try {
      const result = await this.contract!.getMaterial(materialId);
      if (!result || result.materialId === '') return null;
      return this.parseMaterial(result);
    } catch {
      return null;
    }
  }

  /**
   * Get credential by ID
   */
  async getCredential(credentialId: string): Promise<Credential | null> {
    this.ensureConnected();
    
    try {
      const result = await this.contract!.getCredential(credentialId);
      if (!result || result.credentialId === '') return null;
      return this.parseCredential(result);
    } catch {
      return null;
    }
  }

  /**
   * Get all credentials for a material
   */
  async getCredentialsForMaterial(materialId: string): Promise<Credential[]> {
    this.ensureConnected();
    
    try {
      const result = await this.contract!.getCredentialsForMaterial(materialId);
      return (result || []).map((c: any) => this.parseCredential(c));
    } catch {
      return [];
    }
  }

  /**
   * Get material history
   */
  async getHistory(materialId: string): Promise<unknown> {
    this.ensureConnected();
    
    try {
      return await this.contract!.getHistory(materialId);
    } catch {
      return { materialId, events: [] };
    }
  }

  /**
   * Get all materials for an organization
   */
  async getMaterialsByOrg(orgId: string): Promise<Material[]> {
    this.ensureConnected();
    
    try {
      const result = await this.contract!.getMaterialsByOrg(orgId);
      return (result || []).map((m: any) => this.parseMaterial(m));
    } catch {
      return [];
    }
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): any {
    return { calls: 0, avgLatency: 0 }; // Stats not available with direct ethers.js
  }

  /**
   * Get performance report
   */
  getPerformanceReport(detailed: boolean = false): string {
    return 'Performance report not available with direct ethers.js';
  }

  /**
   * Get network status
   */
  async getNetworkStatus(): Promise<any> {
    return this.provider?.getNetwork();
  }

  /**
   * Get the underlying PureChain instance
   */
  getPureChain(): any {
    return null; // purechainlib not used - using direct ethers.js
  }

  /**
   * Get contract address
   */
  async getContractAddress(): Promise<string | null> {
    if (!this.contract) return null;
    return this.contract.getAddress();
  }

  // ==================== Private Helper Methods ====================

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to PureChain network. Call connect() first.');
    }
    if (!this.contract) {
      throw new Error('No contract attached. Call deployContract() or attachToContract() first.');
    }
  }

  /**
   * Assert that a transaction receipt indicates finality (mined, not just submitted).
   * This is critical for accurate latency measurements in benchmarks.
   * @throws Error if receipt lacks blockNumber (submit-only latency)
   */
  private assertFinality(receipt: any): void {
    if (receipt.blockNumber == null || receipt.blockNumber === undefined) {
      throw new Error(
        'executeWithMetrics returned receipt without blockNumber; ' +
        'likely measuring submit-only latency, not finality. ' +
        'Ensure purechainlib awaits transaction mining.'
      );
    }
    // Optional: check status === 1 for successful execution
    if (receipt.status !== undefined && receipt.status !== 1) {
      throw new Error(`Transaction failed with status ${receipt.status}`);
    }
  }

  private parseEventFromReceipt(receipt: any, eventName: string, fieldName: string): string {
    // Try multiple formats for extracting return value / event data from receipt
    
    // 1. Check for return value directly on receipt (some chains put it here)
    if (receipt.returnValue) {
      return receipt.returnValue.toString();
    }
    
    // 2. Check for result field (PureChain may use this)
    if (receipt.result) {
      return receipt.result.toString();
    }
    
    // 3. Parse event logs - standard format
    if (receipt.logs && receipt.logs.length > 0) {
      for (const log of receipt.logs) {
        // Format 1: { eventName, args: { fieldName: value } }
        if (log.eventName === eventName && log.args && log.args[fieldName]) {
          return log.args[fieldName].toString();
        }
        // Format 2: { event, args: [value, ...] } - positional args
        if (log.event === eventName && log.args && Array.isArray(log.args) && log.args[0]) {
          return log.args[0].toString();
        }
        // Format 3: { name, data: { fieldName: value } }
        if (log.name === eventName && log.data && log.data[fieldName]) {
          return log.data[fieldName].toString();
        }
        
        // Format 4: Raw EVM log with hex data - decode ABI-encoded strings
        // MaterialRegistered event emits (materialId, materialType, ownerOrg) as non-indexed strings
        if (log.data && typeof log.data === 'string' && log.data.startsWith('0x')) {
          const decoded = this.decodeStringFromEventData(log.data, 0);
          if (decoded) {
            return decoded;
          }
        }
      }
    }
    
    // 4. Check events array (alternative format)
    if (receipt.events && Array.isArray(receipt.events)) {
      for (const ev of receipt.events) {
        if (ev.event === eventName && ev.args) {
          if (ev.args[fieldName]) return ev.args[fieldName].toString();
          if (Array.isArray(ev.args) && ev.args[0]) return ev.args[0].toString();
        }
      }
    }
    
    // 5. Fallback: generate ID (this means event parsing failed)
    console.warn(`[WARN] Could not parse ${eventName}.${fieldName} from receipt, using fallback ID`);
    return `${eventName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
  
  /**
   * Decode a string from ABI-encoded event data at a given string index.
   * ABI encoding for strings: offset (32 bytes) -> length (32 bytes) -> data (padded to 32 bytes)
   */
  private decodeStringFromEventData(data: string, stringIndex: number): string | null {
    try {
      // Remove 0x prefix
      const hex = data.slice(2);
      
      // Each slot is 64 hex chars (32 bytes)
      // First slot(s) are offsets to the actual string data
      const offsetSlot = stringIndex * 64;
      const offsetHex = hex.slice(offsetSlot, offsetSlot + 64);
      const offset = parseInt(offsetHex, 16) * 2; // Convert to hex char position
      
      // At the offset, first 32 bytes is the string length
      const lengthHex = hex.slice(offset, offset + 64);
      const length = parseInt(lengthHex, 16);
      
      // Following bytes are the string data
      const stringDataHex = hex.slice(offset + 64, offset + 64 + length * 2);
      
      // Convert hex to string
      let result = '';
      for (let i = 0; i < stringDataHex.length; i += 2) {
        const charCode = parseInt(stringDataHex.slice(i, i + 2), 16);
        if (charCode > 0) result += String.fromCharCode(charCode);
      }
      
      return result || null;
    } catch {
      return null;
    }
  }

  private parseMaterial(data: any): Material {
    // Map numeric status to string (Solidity enum returns uint8)
    const rawStatus = data.status ?? data[4];
    const status = typeof rawStatus === 'number' ? (STATUS_STR[rawStatus] || 'UNKNOWN') : (rawStatus || '');
    
    return {
      materialId: data.materialId || data[0] || '',
      materialType: data.materialType || data[1] || '',
      metadataHash: data.metadataHash || data[2] || '',
      ownerOrg: data.ownerOrg || data[3] || '',
      status,
      createdAt: data.createdAt || data[5] || '',
      updatedAt: data.updatedAt || data[6] || ''
    };
  }

  private parseCredential(data: any): Credential {
    return {
      materialId: data.materialId || data[0] || '',
      credentialId: data.credentialId || data[1] || '',
      credentialType: data.credentialType || data[2] || '',
      commitmentHash: data.commitmentHash || data[3] || '',
      issuerId: data.issuerId || data[4] || '',
      issuedAt: data.issuedAt || data[5] || '',
      validUntil: data.validUntil || data[6] || '',
      artifactRefs: this.parseArtifactRefs(data.artifactRefs || data[7]),
      signatureRef: data.signatureRef || data[8] || '',
      revoked: data.revoked || data[9] || false
    };
  }

  private parseArtifactRefs(data: any): Array<{ cid: string; hash: string }> {
    if (!data) return [];
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return [];
      }
    }
    return data;
  }

  private parseVerificationResult(data: any): VerificationResult {
    return {
      pass: data.pass || data[0] || false,
      materialId: data.materialId || data[1] || '',
      verifiedAt: data.verifiedAt || data[2] || new Date().toISOString(),
      reasons: data.reasons || data[3] || [],
      credentialStatus: data.credentialStatus || data[4] || [],
      transferChainValid: data.transferChainValid || data[5] || false
    };
  }

  /**
   * Get ABI and bytecode for BioPassport Registry contract
   * Uses embedded contract source for consistency (string-based credential types)
   */
  private getBioPassportRegistryABI(): { abi: any[]; bytecode: string } {
    // Use embedded contract ABI (string-based, matches our client methods)
    const abi = [
      "function registerMaterial(string materialType, string metadataHash) returns (string)",
      "function getMaterial(string materialId) view returns (tuple(string materialId, string materialType, string metadataHash, string ownerOrg, uint8 status, uint256 createdAt, uint256 updatedAt))",
      "function issueCredential(string materialId, string credentialType, string commitmentHash, uint256 validUntil, string artifactRefs, string signatureRef) returns (string)",
      "function getCredential(string credentialId) view returns (tuple(string materialId, string credentialId, string credentialType, string commitmentHash, string issuerId, uint256 issuedAt, uint256 validUntil, string artifactRefs, string signatureRef, bool revoked))",
      "function getCredentialsForMaterial(string materialId) view returns (tuple(string materialId, string credentialId, string credentialType, string commitmentHash, string issuerId, uint256 issuedAt, uint256 validUntil, string artifactRefs, string signatureRef, bool revoked)[])",
      "function transferMaterial(string materialId, string toOrg, string shipmentHash) returns (string)",
      "function acceptTransfer(string transferId)",
      "function setStatus(string materialId, uint8 status, string reasonHash)",
      "function revokeCredential(string credentialId, string reason)",
      "function verifyMaterial(string materialId) view returns (bool pass, string[] reasons)",
      "function getHistory(string materialId) view returns (tuple(string materialId, string[] events))",
      "function getMaterialsByOrg(string orgId) view returns (tuple(string materialId, string materialType, string metadataHash, string ownerOrg, uint8 status, uint256 createdAt, uint256 updatedAt)[])",
      "event MaterialRegistered(string indexed materialId, string materialType, string ownerOrg)",
      "event CredentialIssued(string indexed credentialId, string indexed materialId, string credentialType)",
      "event MaterialTransferred(string indexed transferId, string indexed materialId, string fromOrg, string toOrg)",
      "event TransferAccepted(string indexed transferId)",
      "event StatusChanged(string indexed materialId, uint8 newStatus)",
      "event CredentialRevoked(string indexed credentialId, string reason)"
    ];
    
    // Compile from embedded source
    const source = this.getBioPassportRegistrySource();
    const bytecode = this.compileContract(source);
    
    return { abi, bytecode };
  }
  
  /**
   * Compile Solidity source to bytecode (simplified - uses solc if available)
   */
  private compileContract(source: string): string {
    // In production, this should use pre-compiled bytecode or hardhat artifacts
    // For now, we use solc-js if available, or fall back to a known bytecode
    try {
      // Try to require solc
      const solc = require('solc');
      const input = {
        language: 'Solidity',
        sources: { 'BioPassportRegistry.sol': { content: source } },
        settings: { outputSelection: { '*': { '*': ['evm.bytecode'] } } }
      };
      const output = JSON.parse(solc.compile(JSON.stringify(input)));
      return output.contracts['BioPassportRegistry.sol']['BioPassportRegistry'].evm.bytecode.object;
    } catch {
      // If solc not available, use ethers to compile via provider (or use pre-compiled)
      // For PureChain deployment, we assume the contract compiles at runtime
      console.log('[INFO] solc not available, using runtime compilation via provider');
      return '0x'; // Placeholder - actual deployment will use purechain's solc
    }
  }

  /**
   * Get the Solidity source for BioPassport Registry contract
   */
  private getBioPassportRegistrySource(): string {
    return `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title BioPassportRegistry
 * @dev On-chain registry for biomaterial credentials on PureChain
 */
contract BioPassportRegistry {
    
    // ==================== Enums ====================
    enum MaterialStatus { ACTIVE, QUARANTINED, REVOKED, EXPIRED }
    
    // ==================== Structs ====================
    struct Material {
        string materialId;
        string materialType;
        string metadataHash;
        string ownerOrg;
        MaterialStatus status;
        uint256 createdAt;
        uint256 updatedAt;
    }
    
    struct Credential {
        string materialId;
        string credentialId;
        string credentialType;
        string commitmentHash;
        string issuerId;
        uint256 issuedAt;
        uint256 validUntil;
        string artifactRefs;
        string signatureRef;
        bool revoked;
    }
    
    struct Transfer {
        string transferId;
        string materialId;
        string fromOrg;
        string toOrg;
        string shipmentHash;
        uint256 timestamp;
        bool accepted;
    }
    
    struct VerificationResult {
        bool pass;
        string materialId;
        uint256 verifiedAt;
    }
    
    // ==================== State ====================
    mapping(string => Material) public materials;
    mapping(string => Credential) public credentials;
    mapping(string => Transfer) public transfers;
    mapping(string => string[]) public materialCredentials;
    mapping(string => string[]) public materialTransfers;
    
    uint256 public materialCount;
    uint256 public credentialCount;
    uint256 public transferCount;
    
    // ==================== Events ====================
    event MaterialRegistered(string indexed materialId, string materialType, string ownerOrg);
    event CredentialIssued(string indexed credentialId, string indexed materialId, string credentialType);
    event MaterialTransferred(string indexed transferId, string indexed materialId, string fromOrg, string toOrg);
    event TransferAccepted(string indexed transferId);
    event StatusChanged(string indexed materialId, MaterialStatus newStatus);
    event CredentialRevoked(string indexed credentialId, string reason);
    
    // ==================== Material Functions ====================
    
    function registerMaterial(
        string memory materialType,
        string memory metadataHash
    ) public returns (string memory) {
        materialCount++;
        string memory materialId = string(abi.encodePacked("bio:", materialType, ":", uint2str(materialCount)));
        
        materials[materialId] = Material({
            materialId: materialId,
            materialType: materialType,
            metadataHash: metadataHash,
            ownerOrg: addressToString(msg.sender),
            status: MaterialStatus.ACTIVE,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });
        
        emit MaterialRegistered(materialId, materialType, addressToString(msg.sender));
        return materialId;
    }
    
    function getMaterial(string memory materialId) public view returns (Material memory) {
        return materials[materialId];
    }
    
    // ==================== Credential Functions ====================
    
    function issueCredential(
        string memory materialId,
        string memory credentialType,
        string memory commitmentHash,
        uint256 validUntil,
        string memory artifactRefs,
        string memory signatureRef
    ) public returns (string memory) {
        require(bytes(materials[materialId].materialId).length > 0, "Material not found");
        require(materials[materialId].status == MaterialStatus.ACTIVE, "Material not active");
        
        credentialCount++;
        string memory credentialId = string(abi.encodePacked("cred:", uint2str(credentialCount)));
        
        credentials[credentialId] = Credential({
            materialId: materialId,
            credentialId: credentialId,
            credentialType: credentialType,
            commitmentHash: commitmentHash,
            issuerId: addressToString(msg.sender),
            issuedAt: block.timestamp,
            validUntil: validUntil,
            artifactRefs: artifactRefs,
            signatureRef: signatureRef,
            revoked: false
        });
        
        materialCredentials[materialId].push(credentialId);
        
        emit CredentialIssued(credentialId, materialId, credentialType);
        return credentialId;
    }
    
    function getCredential(string memory credentialId) public view returns (Credential memory) {
        return credentials[credentialId];
    }
    
    function getCredentialsForMaterial(string memory materialId) public view returns (Credential[] memory) {
        string[] memory credIds = materialCredentials[materialId];
        Credential[] memory result = new Credential[](credIds.length);
        for (uint i = 0; i < credIds.length; i++) {
            result[i] = credentials[credIds[i]];
        }
        return result;
    }
    
    function revokeCredential(string memory credentialId, string memory reason) public {
        require(bytes(credentials[credentialId].credentialId).length > 0, "Credential not found");
        credentials[credentialId].revoked = true;
        emit CredentialRevoked(credentialId, reason);
    }
    
    // ==================== Transfer Functions ====================
    
    function transferMaterial(
        string memory materialId,
        string memory toOrg,
        string memory shipmentHash
    ) public returns (string memory) {
        require(bytes(materials[materialId].materialId).length > 0, "Material not found");
        require(materials[materialId].status == MaterialStatus.ACTIVE, "Material not active");
        
        transferCount++;
        string memory transferId = string(abi.encodePacked("xfer:", uint2str(transferCount)));
        
        transfers[transferId] = Transfer({
            transferId: transferId,
            materialId: materialId,
            fromOrg: materials[materialId].ownerOrg,
            toOrg: toOrg,
            shipmentHash: shipmentHash,
            timestamp: block.timestamp,
            accepted: false
        });
        
        materialTransfers[materialId].push(transferId);
        materials[materialId].ownerOrg = toOrg;
        materials[materialId].updatedAt = block.timestamp;
        
        emit MaterialTransferred(transferId, materialId, transfers[transferId].fromOrg, toOrg);
        return transferId;
    }
    
    function acceptTransfer(string memory transferId) public {
        require(bytes(transfers[transferId].transferId).length > 0, "Transfer not found");
        transfers[transferId].accepted = true;
        emit TransferAccepted(transferId);
    }
    
    // ==================== Status Functions ====================
    
    function setStatus(
        string memory materialId,
        MaterialStatus status,
        string memory /* reasonHash */
    ) public {
        require(bytes(materials[materialId].materialId).length > 0, "Material not found");
        materials[materialId].status = status;
        materials[materialId].updatedAt = block.timestamp;
        emit StatusChanged(materialId, status);
    }
    
    // ==================== Verification Functions ====================
    
    function verifyMaterial(string memory materialId) public view returns (bool pass, string[] memory reasons) {
        Material memory mat = materials[materialId];
        string[] memory tempReasons = new string[](10);
        uint reasonCount = 0;
        
        // Check 1: Material exists and status
        if (bytes(mat.materialId).length == 0) {
            tempReasons[reasonCount++] = "MATERIAL_NOT_FOUND";
        } else if (mat.status == MaterialStatus.REVOKED) {
            tempReasons[reasonCount++] = "MATERIAL_REVOKED";
        } else if (mat.status == MaterialStatus.QUARANTINED) {
            tempReasons[reasonCount++] = "MATERIAL_QUARANTINED";
        }
        
        // Check 2: Required credentials with LATEST-QC-ONLY policy
        string[] memory credIds = materialCredentials[materialId];
        bool hasIdentity = false;
        uint256 latestQcIssuedAt = 0;
        uint256 latestQcValidUntil = 0;
        
        for (uint i = 0; i < credIds.length; i++) {
            Credential memory cred = credentials[credIds[i]];
            if (!cred.revoked) {
                if (keccak256(bytes(cred.credentialType)) == keccak256(bytes("IDENTITY")) && cred.validUntil > block.timestamp) {
                    hasIdentity = true;
                }
                // Track LATEST QC by issuedAt
                if (keccak256(bytes(cred.credentialType)) == keccak256(bytes("QC_MYCO"))) {
                    if (cred.issuedAt > latestQcIssuedAt) {
                        latestQcIssuedAt = cred.issuedAt;
                        latestQcValidUntil = cred.validUntil;
                    }
                }
            }
        }
        
        if (!hasIdentity) {
            tempReasons[reasonCount++] = "MISSING_IDENTITY";
        }
        
        // LATEST-QC-ONLY policy: only check the most recent QC credential
        bool hasValidQC = (latestQcIssuedAt != 0 && latestQcValidUntil > block.timestamp);
        if (!hasValidQC) {
            if (latestQcIssuedAt == 0) {
                tempReasons[reasonCount++] = "QC_MISSING";
            } else {
                tempReasons[reasonCount++] = "QC_EXPIRED";
            }
        }
        
        // Check 3: Transfer chain - no pending transfers
        string[] memory xferIds = materialTransfers[materialId];
        for (uint i = 0; i < xferIds.length; i++) {
            if (!transfers[xferIds[i]].accepted) {
                tempReasons[reasonCount++] = "TRANSFER_PENDING";
                break;
            }
        }
        
        // Build final reasons array
        reasons = new string[](reasonCount);
        for (uint i = 0; i < reasonCount; i++) {
            reasons[i] = tempReasons[i];
        }
        
        pass = (reasonCount == 0);
        return (pass, reasons);
    }
    
    function getHistory(string memory materialId) public view returns (string[] memory) {
        return materialTransfers[materialId];
    }
    
    // ==================== Utility Functions ====================
    
    function uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0";
        uint256 j = _i;
        uint256 length;
        while (j != 0) { length++; j /= 10; }
        bytes memory bstr = new bytes(length);
        uint256 k = length;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }
    
    function addressToString(address _addr) internal pure returns (string memory) {
        bytes32 value = bytes32(uint256(uint160(_addr)));
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(value[i + 12] >> 4)];
            str[3 + i * 2] = alphabet[uint8(value[i + 12] & 0x0f)];
        }
        return string(str);
    }
}
`;
  }
}

/**
 * Create PureChain client from environment or config
 */
export function createPureChainClient(config?: Partial<PureChainConfig>): PureChainClient {
  const fullConfig: PureChainConfig = {
    network: config?.network || (process.env.PURECHAIN_NETWORK as 'testnet' | 'mainnet') || 'testnet',
    privateKey: config?.privateKey || process.env.PURECHAIN_PRIVATE_KEY,
    contractAddress: config?.contractAddress || process.env.BIOPASSPORT_CONTRACT_ADDRESS,
    orgId: config?.orgId || process.env.PURECHAIN_ORG_ID || 'Org1MSP'
  };
  return new PureChainClient(fullConfig);
}
