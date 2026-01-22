/**
 * BioPassport V2 Indexer Service
 * Listens to blockchain events and populates PostgreSQL database
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ==================== Configuration ====================

interface IndexerConfig {
  rpcUrl: string;
  contractAddress: string;
  dbConnectionString: string;
  chainId?: number;
  startBlock?: number;
  pollIntervalMs?: number;
}

const DEFAULT_CONFIG: IndexerConfig = {
  rpcUrl: process.env.RPC_URL || 'https://purechainnode.com:8547',
  contractAddress: process.env.CONTRACT_ADDRESS || '',
  dbConnectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/biopassport',
  chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 900520900520,
  startBlock: parseInt(process.env.START_BLOCK || '0'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '2000'),
};

// ==================== Contract ABI (events only) ====================

const CONTRACT_ABI = [
  'event AssetRegistered(bytes32 indexed assetIdHash, string pointer, address indexed registrar, uint64 timestamp)',
  'event CredentialIssued(bytes32 indexed assetIdHash, bytes32 indexed credentialHash, bytes32 prevHash, bytes32 evidenceRoot, string pointer, address indexed issuer, uint64 timestamp)',
  'event ExceptionOpened(uint256 indexed exceptionId, bytes32 indexed assetIdHash, bytes32 relatedCredentialHash, uint8 reasonCode, string detailsPointer, address indexed openedBy, uint64 timestamp)',
  'event ExceptionClosed(uint256 indexed exceptionId, string resolutionPointer, address indexed closedBy, uint64 timestamp)',
];

// ==================== Indexer Class ====================

export class BioPassportIndexer {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private db: Pool;
  private config: IndexerConfig;
  private isRunning: boolean = false;

  constructor(config: Partial<IndexerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    this.provider = new ethers.JsonRpcProvider(
      this.config.rpcUrl,
      this.config.chainId ? { chainId: this.config.chainId, name: 'purechain' } : undefined
    );
    this.contract = new ethers.Contract(
      this.config.contractAddress,
      CONTRACT_ABI,
      this.provider
    );
    
    this.db = new Pool({
      connectionString: this.config.dbConnectionString,
    });
  }

  // ==================== Lifecycle ====================

  async start(): Promise<void> {
    console.log('🚀 Starting BioPassport Indexer...');
    console.log(`   Contract: ${this.config.contractAddress}`);
    console.log(`   RPC: ${this.config.rpcUrl}`);
    
    // Test database connection
    await this.db.query('SELECT 1');
    console.log('   Database: connected');
    
    // Get last synced block
    const lastBlock = await this.getLastSyncedBlock();
    const startBlock = Math.max(lastBlock + 1, this.config.startBlock || 0);
    console.log(`   Starting from block: ${startBlock}`);
    
    this.isRunning = true;
    
    // Start polling loop (handles all event processing)
    // Note: Real-time listeners disabled for PureChain compatibility
    // (filter subscriptions expire and cause "filter not found" errors)
    this.pollLoop(startBlock);
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping indexer...');
    this.isRunning = false;
    this.contract.removeAllListeners();
    await this.db.end();
  }

  // ==================== Polling ====================

  private async pollLoop(fromBlock: number): Promise<void> {
    let currentBlock = fromBlock;
    
    while (this.isRunning) {
      try {
        const latestBlock = await this.provider.getBlockNumber();
        
        if (currentBlock <= latestBlock) {
          const toBlock = Math.min(currentBlock + 1000, latestBlock);
          await this.processBlockRange(currentBlock, toBlock);
          currentBlock = toBlock + 1;
        }
        
        await this.sleep(this.config.pollIntervalMs || 2000);
      } catch (error) {
        console.error('Poll loop error:', error);
        await this.sleep(5000);
      }
    }
  }

  private async processBlockRange(fromBlock: number, toBlock: number): Promise<void> {
    console.log(`📦 Processing blocks ${fromBlock} - ${toBlock}`);
    
    // Query all events in range
    const assetEvents = await this.contract.queryFilter(
      this.contract.filters.AssetRegistered(),
      fromBlock,
      toBlock
    );
    
    const credentialEvents = await this.contract.queryFilter(
      this.contract.filters.CredentialIssued(),
      fromBlock,
      toBlock
    );
    
    const exceptionOpenedEvents = await this.contract.queryFilter(
      this.contract.filters.ExceptionOpened(),
      fromBlock,
      toBlock
    );
    
    const exceptionClosedEvents = await this.contract.queryFilter(
      this.contract.filters.ExceptionClosed(),
      fromBlock,
      toBlock
    );
    
    // Process in order
    for (const event of assetEvents) {
      await this.handleAssetRegistered(event);
    }
    
    for (const event of credentialEvents) {
      await this.handleCredentialIssued(event);
    }
    
    for (const event of exceptionOpenedEvents) {
      await this.handleExceptionOpened(event);
    }
    
    for (const event of exceptionClosedEvents) {
      await this.handleExceptionClosed(event);
    }
    
    // Update sync state
    await this.updateSyncState(toBlock);
  }

  // ==================== Event Handlers ====================

  private async handleAssetRegistered(event: ethers.EventLog | ethers.Log): Promise<void> {
    const parsed = this.contract.interface.parseLog({
      topics: event.topics as string[],
      data: event.data,
    });
    
    if (!parsed) return;
    
    const { assetIdHash, pointer, registrar, timestamp } = parsed.args;
    
    console.log(`  📝 AssetRegistered: ${assetIdHash.slice(0, 18)}...`);
    
    await this.db.query(`
      INSERT INTO assets (asset_id_hash, pointer, registrar, created_at, block_number, tx_hash)
      VALUES ($1, $2, $3, to_timestamp($4), $5, $6)
      ON CONFLICT (asset_id_hash) DO NOTHING
    `, [
      Buffer.from(assetIdHash.slice(2), 'hex'),
      pointer,
      registrar,
      Number(timestamp),
      event.blockNumber,
      event.transactionHash,
    ]);
  }

  private async handleCredentialIssued(event: ethers.EventLog | ethers.Log): Promise<void> {
    const parsed = this.contract.interface.parseLog({
      topics: event.topics as string[],
      data: event.data,
    });
    
    if (!parsed) return;
    
    const { assetIdHash, credentialHash, prevHash, evidenceRoot, pointer, issuer, timestamp } = parsed.args;
    
    console.log(`  🎫 CredentialIssued: ${credentialHash.slice(0, 18)}...`);
    
    await this.db.query(`
      INSERT INTO credentials (
        credential_hash, asset_id_hash, prev_hash, evidence_root, 
        pointer, issuer, issued_at, block_number, tx_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8, $9)
      ON CONFLICT (credential_hash) DO NOTHING
    `, [
      Buffer.from(credentialHash.slice(2), 'hex'),
      Buffer.from(assetIdHash.slice(2), 'hex'),
      prevHash === ethers.ZeroHash ? null : Buffer.from(prevHash.slice(2), 'hex'),
      Buffer.from(evidenceRoot.slice(2), 'hex'),
      pointer,
      issuer,
      Number(timestamp),
      event.blockNumber,
      event.transactionHash,
    ]);
    
    // Fetch and parse credential JSON to populate denormalized fields
    await this.enrichCredential(credentialHash, pointer);
  }

  private async handleExceptionOpened(event: ethers.EventLog | ethers.Log): Promise<void> {
    const parsed = this.contract.interface.parseLog({
      topics: event.topics as string[],
      data: event.data,
    });
    
    if (!parsed) return;
    
    const { exceptionId, assetIdHash, relatedCredentialHash, reasonCode, detailsPointer, openedBy, timestamp } = parsed.args;
    
    console.log(`  ⚠️ ExceptionOpened: #${exceptionId}`);
    
    const reasonMap: Record<number, string> = {
      1: 'HASH_MISMATCH',
      2: 'EVIDENCE_MISSING',
      3: 'CHAIN_BREAK',
      4: 'EXPIRED_CREDENTIAL',
      5: 'REVOKED_ISSUER',
      6: 'TAMPERED_EVIDENCE',
    };
    
    await this.db.query(`
      INSERT INTO exceptions (
        exception_id, asset_id_hash, related_credential_hash, 
        reason_code, reason, details_pointer, opened_by, opened_at,
        block_number_opened, tx_hash_opened
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10)
      ON CONFLICT (exception_id) DO NOTHING
    `, [
      Number(exceptionId),
      Buffer.from(assetIdHash.slice(2), 'hex'),
      relatedCredentialHash === ethers.ZeroHash ? null : Buffer.from(relatedCredentialHash.slice(2), 'hex'),
      reasonCode,
      reasonMap[reasonCode] || 'OTHER',
      detailsPointer,
      openedBy,
      Number(timestamp),
      event.blockNumber,
      event.transactionHash,
    ]);
  }

  private async handleExceptionClosed(event: ethers.EventLog | ethers.Log): Promise<void> {
    const parsed = this.contract.interface.parseLog({
      topics: event.topics as string[],
      data: event.data,
    });
    
    if (!parsed) return;
    
    const { exceptionId, resolutionPointer, closedBy, timestamp } = parsed.args;
    
    console.log(`  ✅ ExceptionClosed: #${exceptionId}`);
    
    await this.db.query(`
      UPDATE exceptions SET
        closed = true,
        closed_by = $2,
        closed_at = to_timestamp($3),
        resolution_pointer = $4,
        block_number_closed = $5,
        tx_hash_closed = $6,
        updated_at_db = NOW()
      WHERE exception_id = $1
    `, [
      Number(exceptionId),
      closedBy,
      Number(timestamp),
      resolutionPointer,
      event.blockNumber,
      event.transactionHash,
    ]);
  }

  // ==================== Real-time Listeners ====================

  private setupEventListeners(): void {
    this.contract.on('AssetRegistered', async (...args) => {
      const event = args[args.length - 1];
      await this.handleAssetRegistered(event);
    });
    
    this.contract.on('CredentialIssued', async (...args) => {
      const event = args[args.length - 1];
      await this.handleCredentialIssued(event);
    });
    
    this.contract.on('ExceptionOpened', async (...args) => {
      const event = args[args.length - 1];
      await this.handleExceptionOpened(event);
    });
    
    this.contract.on('ExceptionClosed', async (...args) => {
      const event = args[args.length - 1];
      await this.handleExceptionClosed(event);
    });
    
    console.log('👂 Real-time event listeners active');
  }

  // ==================== Helpers ====================

  private async enrichCredential(credentialHash: string, pointer: string): Promise<void> {
    try {
      // Fetch credential JSON from pointer (S3, IPFS, etc.)
      const credentialJson = await this.fetchFromPointer(pointer);
      if (!credentialJson) return;
      
      const parsed = JSON.parse(credentialJson);
      
      await this.db.query(`
        UPDATE credentials SET
          credential_type = $2,
          issuer_org = $3,
          subject = $4,
          evidence_count = $5
        WHERE credential_hash = $1
      `, [
        Buffer.from(credentialHash.slice(2), 'hex'),
        parsed.credential_type,
        parsed.issuer_org,
        JSON.stringify(parsed.subject || {}),
        parsed.evidence?.length || 0,
      ]);
      
      // Insert evidence file records
      if (parsed.evidence && Array.isArray(parsed.evidence)) {
        for (const ev of parsed.evidence) {
          await this.db.query(`
            INSERT INTO evidence_files (credential_hash, uri, sha256_hash, filename)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
          `, [
            Buffer.from(credentialHash.slice(2), 'hex'),
            ev.uri,
            Buffer.from(ev.sha256, 'hex'),
            ev.filename || path.basename(ev.uri),
          ]);
        }
      }
    } catch (error) {
      console.warn(`  ⚠️ Could not enrich credential: ${error}`);
    }
  }

  private async fetchFromPointer(pointer: string): Promise<string | null> {
    // TODO: Implement S3/IPFS/HTTP fetching
    // For now, return null (enrichment will be skipped)
    return null;
  }

  private async getLastSyncedBlock(): Promise<number> {
    const result = await this.db.query(
      'SELECT last_block_number FROM sync_state WHERE id = 1'
    );
    return result.rows[0]?.last_block_number || 0;
  }

  private async updateSyncState(blockNumber: number): Promise<void> {
    await this.db.query(`
      UPDATE sync_state SET 
        last_block_number = $1, 
        last_synced_at = NOW() 
      WHERE id = 1
    `, [blockNumber]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== CLI Entry ====================

async function main() {
  const contractAddress = process.argv[2] || process.env.CONTRACT_ADDRESS;
  
  if (!contractAddress) {
    console.error('Usage: ts-node indexer.ts <contract_address>');
    console.error('  or set CONTRACT_ADDRESS environment variable');
    process.exit(1);
  }
  
  const indexer = new BioPassportIndexer({ contractAddress });
  
  process.on('SIGINT', async () => {
    await indexer.stop();
    process.exit(0);
  });
  
  await indexer.start();
}

if (require.main === module) {
  main().catch(console.error);
}

export default BioPassportIndexer;
