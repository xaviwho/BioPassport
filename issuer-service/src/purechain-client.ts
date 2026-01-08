/**
 * PureChain Client for interacting with BioPassport Registry
 * Uses purechainlib SDK for real blockchain interaction
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PureChain = require('purechainlib');

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
  private purechain: any;
  private contract: any = null;
  private connected: boolean = false;
  private _debuggedReceipt: boolean = false;

  constructor(config: PureChainConfig) {
    this.config = config;
    this.purechain = new PureChain(config.network);
  }

  /**
   * Connect to PureChain network
   */
  async connect(): Promise<void> {
    if (this.config.privateKey) {
      this.purechain.connect(this.config.privateKey);
    } else {
      // Generate new account if no private key provided
      const account = this.purechain.account();
      this.purechain.connect(account.privateKey);
      console.log(`Generated new account: ${account.address}`);
    }

    // Check connection by getting balance
    const balance = await this.purechain.balance();
    console.log(`Connected to PureChain. Balance: ${balance} PURE`);

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
    const registrySource = this.getBioPassportRegistrySource();
    const factory = await this.purechain.contract(registrySource);
    this.contract = await factory.deploy();
    const address = await this.contract.getAddress();
    console.log(`BioPassport Registry deployed at: ${address}`);
    return address;
  }

  /**
   * Attach to existing deployed contract
   */
  async attachToContract(address: string): Promise<void> {
    const registrySource = this.getBioPassportRegistrySource();
    const factory = await this.purechain.contract(registrySource);
    this.contract = factory.attach(address);
    console.log(`Attached to BioPassport Registry at: ${address}`);
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
      const { receipt, metrics } = await this.purechain.executeWithMetrics(
        this.contract,
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

      // Parse event to get materialId
      const materialId = this.parseEventFromReceipt(receipt, 'MaterialRegistered', 'materialId');

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { materialId, txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
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
   * Issue a credential for a material
   * 
   * Solidity signature:
   *   issueCredential(string materialId, string credentialType, string commitmentHash,
   *                   uint256 validUntil, string artifactRefs, string signatureRef)
   * 
   * @param credentialType - Must be 'IDENTITY', 'QC_MYCO', or 'USAGE_RIGHTS' (string, not enum)
   * @param validUntilUnixSec - Unix timestamp in seconds (uint256 in Solidity)
   * @param artifactCid - CID for artifact storage
   * @param artifactHash - Hash of artifact content
   * @param signatureRef - Reference to signature (or empty string)
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
      const { receipt, metrics } = await this.purechain.executeWithMetrics(
        this.contract,
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

      const credentialId = this.parseEventFromReceipt(receipt, 'CredentialIssued', 'credentialId');

      return {
        txId: receipt.hash,
        status: 'SUCCESS',
        result: { credentialId, txHash: receipt.hash, latencyMs: metrics.duration, blockNumber: receipt.blockNumber }
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
   * Transfer material to another organization
   */
  async transferMaterial(
    materialId: string,
    toOrg: string,
    shipmentHash: string
  ): Promise<TransactionResult> {
    this.ensureConnected();
    
    try {
      const { receipt, metrics } = await this.purechain.executeWithMetrics(
        this.contract,
        'transferMaterial',
        materialId,
        toOrg,
        shipmentHash
      );

      // Finality assertion
      this.assertFinality(receipt);

      const transferId = this.parseEventFromReceipt(receipt, 'MaterialTransferred', 'transferId');

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
   * Accept a pending transfer
   */
  async acceptTransfer(transferId: string): Promise<TransactionResult> {
    this.ensureConnected();
    
    try {
      const { receipt, metrics } = await this.purechain.executeWithMetrics(
        this.contract,
        'acceptTransfer',
        transferId
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
      const { receipt, metrics } = await this.purechain.executeWithMetrics(
        this.contract,
        'setStatus',             // Correct function name (not setStatusByAuthority)
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
      const { receipt, metrics } = await this.purechain.executeWithMetrics(
        this.contract,
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
      const result = await this.purechain.call(this.contract, 'verifyMaterial', materialId);
      
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
      const result = await this.purechain.call(this.contract, 'getMaterial', materialId);
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
      const result = await this.purechain.call(this.contract, 'getCredential', credentialId);
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
      const result = await this.purechain.call(this.contract, 'getCredentialsForMaterial', materialId);
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
      return await this.purechain.call(this.contract, 'getHistory', materialId);
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
      const result = await this.purechain.call(this.contract, 'getMaterialsByOrg', orgId);
      return (result || []).map((m: any) => this.parseMaterial(m));
    } catch {
      return [];
    }
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): any {
    return this.purechain.getPerformanceStats();
  }

  /**
   * Get performance report
   */
  getPerformanceReport(detailed: boolean = false): string {
    return this.purechain.getPerformanceReport(detailed);
  }

  /**
   * Get network status
   */
  async getNetworkStatus(): Promise<any> {
    return this.purechain.status();
  }

  /**
   * Get the underlying PureChain instance
   */
  getPureChain(): any {
    return this.purechain;
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
    
    // 3. Check for data field that might contain the return value
    if (receipt.data && typeof receipt.data === 'string' && receipt.data.length > 0) {
      return receipt.data;
    }
    
    // 4. Parse event logs - standard format
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
      }
    }
    
    // 5. Check events array (alternative format)
    if (receipt.events && Array.isArray(receipt.events)) {
      for (const ev of receipt.events) {
        if (ev.event === eventName && ev.args) {
          if (ev.args[fieldName]) return ev.args[fieldName].toString();
          if (Array.isArray(ev.args) && ev.args[0]) return ev.args[0].toString();
        }
      }
    }
    
    // 6. Fallback: generate ID (this means event parsing failed)
    console.warn(`[WARN] Could not parse ${eventName}.${fieldName} from receipt, using fallback ID`);
    return `${eventName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
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
