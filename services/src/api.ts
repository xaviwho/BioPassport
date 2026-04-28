/**
 * BioPassport V2 REST API
 * Acquirer-friendly integration surface
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Pool } from 'pg';
import { ethers } from 'ethers';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { generateAuditPack, generateAuditPackPDF } from './audit-pack';
import { computeCredentialHash, computeEvidenceRoot } from './crypto';

// ==================== Configuration ====================

const PORT = parseInt(process.env.PORT || '3000');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/biopassport';
const RPC_URL = process.env.RPC_URL || 'https://purechainnode.com:8547';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 900520900520;

// ==================== Contract ABI ====================

const CONTRACT_ABI = [
  'function registerAsset(bytes32 assetIdHash, string pointer) external',
  'function issueCredential(bytes32 assetIdHash, bytes32 credentialHash, bytes32 prevHash, bytes32 evidenceRoot, string pointer) external',
  'function openException(bytes32 assetIdHash, bytes32 relatedCredentialHash, uint8 reasonCode, string detailsPointer) external returns (uint256)',
  'function closeException(uint256 exceptionId, string resolutionPointer) external',
  'function getAsset(bytes32 assetIdHash) external view returns (tuple(bytes32,string,address,uint64,bytes32,bool))',
  'function getCredential(bytes32 credentialHash) external view returns (tuple(bytes32,bytes32,bytes32,bytes32,string,address,uint64,bool))',
  'function verifyChainLinkage(bytes32 credentialHash) external view returns (bool)',
];

// ==================== Validation Schemas ====================

const RegisterAssetSchema = z.object({
  assetId: z.string().min(1),
  pointer: z.string().url().or(z.string().startsWith('s3://')).or(z.string().startsWith('ipfs://')),
  metadata: z.record(z.any()).optional(),
});

const IssueCredentialSchema = z.object({
  assetId: z.string().min(1),
  credentialType: z.enum(['CHAIN_OF_CUSTODY', 'COA', 'INTAKE', 'QC', 'SHIPMENT', 'IDENTITY', 'USAGE_RIGHTS']),
  issuerOrg: z.string().min(1),
  subject: z.record(z.any()).optional(),
  evidence: z.array(z.object({
    uri: z.string(),
    sha256: z.string().length(64),
    filename: z.string().optional(),
  })),
  notes: z.string().optional(),
});

const OpenExceptionSchema = z.object({
  assetId: z.string().min(1),
  relatedCredentialHash: z.string().optional(),
  reasonCode: z.number().int().min(1).max(7),
  detailsPointer: z.string(),
});

const CloseExceptionSchema = z.object({
  resolutionPointer: z.string(),
});

const VerifyRequestSchema = z.object({
  credentialHash: z.string().optional(),
  assetId: z.string().optional(),
});

// ==================== App Setup ====================

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const db = new Pool({ connectionString: DATABASE_URL });

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;
let contract: ethers.Contract;

// ==================== Middleware ====================

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

// ==================== Routes ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== Asset Endpoints ====================

/**
 * POST /assets - Register a new asset
 */
app.post('/assets', asyncHandler(async (req, res) => {
  const data = RegisterAssetSchema.parse(req.body);
  
  const assetIdHash = ethers.keccak256(ethers.toUtf8Bytes(data.assetId));
  
  // Call contract (gasPrice: 0 for PureChain)
  const tx = await contract.registerAsset(assetIdHash, data.pointer, { gasPrice: 0 });
  const receipt = await tx.wait();
  
  res.status(201).json({
    success: true,
    assetId: data.assetId,
    assetIdHash,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });
}));

/**
 * GET /assets/:assetId - Get asset details
 */
app.get('/assets/:assetId', asyncHandler(async (req, res) => {
  const assetIdHash = ethers.keccak256(ethers.toUtf8Bytes(req.params.assetId));
  const hashBuffer = Buffer.from(assetIdHash.slice(2), 'hex');
  
  const result = await db.query(`
    SELECT 
      a.*,
      (SELECT json_agg(c ORDER BY c.issued_at) 
       FROM credentials c WHERE c.asset_id_hash = a.asset_id_hash) as credentials,
      (SELECT json_agg(e ORDER BY e.opened_at) 
       FROM exceptions e WHERE e.asset_id_hash = a.asset_id_hash) as exceptions
    FROM assets a
    WHERE a.asset_id_hash = $1
  `, [hashBuffer]);
  
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Asset not found' });
  }
  
  res.json(result.rows[0]);
}));

/**
 * GET /assets/:assetId/credentials - Get credential chain
 */
app.get('/assets/:assetId/credentials', asyncHandler(async (req, res) => {
  const assetIdHash = ethers.keccak256(ethers.toUtf8Bytes(req.params.assetId));
  const hashBuffer = Buffer.from(assetIdHash.slice(2), 'hex');
  
  const result = await db.query(`
    SELECT * FROM credentials 
    WHERE asset_id_hash = $1 
    ORDER BY issued_at ASC
  `, [hashBuffer]);
  
  res.json({
    assetId: req.params.assetId,
    assetIdHash,
    credentialCount: result.rows.length,
    credentials: result.rows,
  });
}));

// ==================== Credential Endpoints ====================

/**
 * POST /credentials - Issue a new credential
 */
app.post('/credentials', asyncHandler(async (req, res) => {
  const data = IssueCredentialSchema.parse(req.body);
  
  const assetIdHash = ethers.keccak256(ethers.toUtf8Bytes(data.assetId));
  const hashBuffer = Buffer.from(assetIdHash.slice(2), 'hex');
  
  // Get latest credential for this asset (for chain linkage)
  const latestResult = await db.query(`
    SELECT credential_hash FROM credentials 
    WHERE asset_id_hash = $1 
    ORDER BY issued_at DESC LIMIT 1
  `, [hashBuffer]);
  
  const prevHash = latestResult.rows.length > 0 
    ? '0x' + latestResult.rows[0].credential_hash.toString('hex')
    : ethers.ZeroHash;
  
  // Build credential payload
  const credentialPayload = {
    schema_version: '1.0',
    asset_id: data.assetId,
    credential_type: data.credentialType,
    issuer_org: data.issuerOrg,
    issued_at: new Date().toISOString(),
    subject: data.subject || {},
    evidence: data.evidence,
    prev_credential_hash: prevHash,
    notes: data.notes,
  };
  
  // Compute hashes
  const credentialHash = computeCredentialHash(credentialPayload);
  const evidenceRoot = computeEvidenceRoot(data.evidence.map(e => e.sha256));
  
  // TODO: Upload credential JSON to S3/IPFS and get pointer
  const pointer = `s3://biopassport/credentials/${credentialHash.slice(2, 18)}.json`;
  
  // Call contract (gasPrice: 0 for PureChain)
  const tx = await contract.issueCredential(
    assetIdHash,
    credentialHash,
    prevHash,
    evidenceRoot,
    pointer,
    { gasPrice: 0 }
  );
  const receipt = await tx.wait();
  
  res.status(201).json({
    success: true,
    credentialHash,
    assetIdHash,
    prevHash,
    evidenceRoot,
    pointer,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });
}));

/**
 * GET /credentials/:hash - Get credential details
 */
app.get('/credentials/:hash', asyncHandler(async (req, res) => {
  const hashBuffer = Buffer.from(req.params.hash.replace('0x', ''), 'hex');
  
  const result = await db.query(`
    SELECT c.*, 
      (SELECT json_agg(e) FROM evidence_files e WHERE e.credential_hash = c.credential_hash) as evidence_files
    FROM credentials c
    WHERE c.credential_hash = $1
  `, [hashBuffer]);
  
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Credential not found' });
  }
  
  res.json(result.rows[0]);
}));

// ==================== Verification Endpoints ====================

/**
 * POST /verify - Verify a credential or asset
 */
app.post('/verify', asyncHandler(async (req, res) => {
  const data = VerifyRequestSchema.parse(req.body);
  
  const results: any = {
    timestamp: new Date().toISOString(),
    status: 'PASS',
    checks: [],
  };
  
  if (data.credentialHash) {
    const hashBuffer = Buffer.from(data.credentialHash.replace('0x', ''), 'hex');
    
    // Get credential from DB
    const credResult = await db.query(
      'SELECT * FROM credentials WHERE credential_hash = $1',
      [hashBuffer]
    );
    
    if (credResult.rows.length === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    
    const cred = credResult.rows[0];
    
    // Check 1: Chain linkage (on-chain)
    const chainValid = await contract.verifyChainLinkage(data.credentialHash);
    results.checks.push({
      name: 'chain_linkage',
      passed: chainValid,
      details: chainValid ? 'Previous credential hash verified' : 'Chain linkage broken',
    });
    
    // Check 2: Evidence root
    const evidenceResult = await db.query(
      'SELECT sha256_hash FROM evidence_files WHERE credential_hash = $1 ORDER BY sha256_hash',
      [hashBuffer]
    );
    const evidenceHashes = evidenceResult.rows.map(r => r.sha256_hash.toString('hex'));
    const computedRoot = computeEvidenceRoot(evidenceHashes);
    const storedRoot = '0x' + cred.evidence_root.toString('hex');
    const evidenceValid = computedRoot.toLowerCase() === storedRoot.toLowerCase();
    
    results.checks.push({
      name: 'evidence_root',
      passed: evidenceValid,
      details: evidenceValid ? 'Evidence root matches' : `Mismatch: computed ${computedRoot}, stored ${storedRoot}`,
    });
    
    // TODO: Check 3: Fetch and verify each evidence file hash
    
    // Overall status
    results.status = results.checks.every((c: any) => c.passed) ? 'PASS' : 'FAIL';
    
    // Log verification
    await db.query(`
      INSERT INTO verifications (credential_hash, status, details)
      VALUES ($1, $2, $3)
    `, [hashBuffer, results.status, JSON.stringify(results)]);
  }
  
  res.json(results);
}));

// ==================== Exception Endpoints ====================

/**
 * POST /exceptions - Open an exception
 */
app.post('/exceptions', asyncHandler(async (req, res) => {
  const data = OpenExceptionSchema.parse(req.body);
  
  const assetIdHash = ethers.keccak256(ethers.toUtf8Bytes(data.assetId));
  const relatedHash = data.relatedCredentialHash || ethers.ZeroHash;
  
  const tx = await contract.openException(
    assetIdHash,
    relatedHash,
    data.reasonCode,
    data.detailsPointer,
    { gasPrice: 0 }
  );
  const receipt = await tx.wait();
  
  // Parse exception ID from event
  const iface = new ethers.Interface([
    'event ExceptionOpened(uint256 indexed exceptionId, bytes32 indexed assetIdHash, bytes32 relatedCredentialHash, uint8 reasonCode, string detailsPointer, address indexed openedBy, uint64 timestamp)'
  ]);
  const log = receipt.logs.find((l: any) => {
    try { iface.parseLog(l); return true; } catch { return false; }
  });
  const parsed = log ? iface.parseLog(log) : null;
  const exceptionId = parsed?.args.exceptionId.toString();
  
  res.status(201).json({
    success: true,
    exceptionId,
    assetIdHash,
    txHash: receipt.hash,
  });
}));

/**
 * POST /exceptions/:id/close - Close an exception
 */
app.post('/exceptions/:id/close', asyncHandler(async (req, res) => {
  const data = CloseExceptionSchema.parse(req.body);
  const exceptionId = parseInt(req.params.id);
  
  const tx = await contract.closeException(exceptionId, data.resolutionPointer, { gasPrice: 0 });
  const receipt = await tx.wait();
  
  res.json({
    success: true,
    exceptionId,
    txHash: receipt.hash,
  });
}));

/**
 * GET /exceptions - List open exceptions
 */
app.get('/exceptions', asyncHandler(async (req, res) => {
  const onlyOpen = req.query.open !== 'false';
  
  const result = await db.query(`
    SELECT * FROM v_open_exceptions
    ${onlyOpen ? 'WHERE closed = FALSE' : ''}
    ORDER BY opened_at DESC
    LIMIT 100
  `);
  
  res.json({
    count: result.rows.length,
    exceptions: result.rows,
  });
}));

// ==================== Audit Pack Endpoints ====================

/**
 * GET /audit-pack/:assetId - Generate audit pack
 */
app.get('/audit-pack/:assetId', asyncHandler(async (req, res) => {
  const format = req.query.format as string || 'json';
  
  const pack = await generateAuditPack(req.params.assetId, db, contract);
  
  if (format === 'pdf') {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const tmpPath = path.join(os.tmpdir(), `audit-pack-${Date.now()}.pdf`);
    await generateAuditPackPDF(pack, tmpPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="audit-pack-${req.params.assetId}.pdf"`);
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpPath, () => {}));
  } else {
    res.json(pack);
  }
}));

// ==================== Webhook Registration (stub) ====================

const WebhookSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.enum(['AssetRegistered', 'CredentialIssued', 'ExceptionOpened', 'ExceptionClosed'])).min(1),
  secret: z.string().optional(),
});

app.post('/webhooks', asyncHandler(async (req, res) => {
  const data = WebhookSchema.parse(req.body);

  const result = await db.query(`
    INSERT INTO webhooks (url, event_types, secret)
    VALUES ($1, $2, $3)
    RETURNING id, url, event_types, is_active, created_at
  `, [data.url, data.eventTypes, data.secret || null]);

  res.status(201).json({
    success: true,
    webhook: result.rows[0],
  });
}));

app.delete('/webhooks/:id', asyncHandler(async (req, res) => {
  await db.query('UPDATE webhooks SET is_active = FALSE WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

// ==================== Error Handler ====================

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('API Error:', err);
  
  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation error',
      details: err.errors,
    });
  }
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ==================== Server Start ====================

async function start() {
  console.log('🚀 Starting BioPassport API...');
  
  // Initialize blockchain connection
  provider = new ethers.JsonRpcProvider(
    RPC_URL,
    { chainId: CHAIN_ID, name: 'purechain' },
    { staticNetwork: true }
  );
  
  if (PRIVATE_KEY) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`   Wallet: ${wallet.address}`);
  } else {
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
    console.log('   Read-only mode (no private key)');
  }
  
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);
  
  // Test database
  await db.query('SELECT 1');
  console.log('   Database: connected');
  
  app.listen(PORT, () => {
    console.log(`   API listening on port ${PORT}`);
    console.log('\n📖 Endpoints:');
    console.log('   POST /assets              - Register asset');
    console.log('   GET  /assets/:id          - Get asset');
    console.log('   GET  /assets/:id/credentials - Get credential chain');
    console.log('   POST /credentials         - Issue credential');
    console.log('   GET  /credentials/:hash   - Get credential');
    console.log('   POST /verify              - Verify credential');
    console.log('   POST /exceptions          - Open exception');
    console.log('   POST /exceptions/:id/close - Close exception');
    console.log('   GET  /exceptions          - List exceptions');
    console.log('   GET  /audit-pack/:id      - Generate audit pack');
  });
}

start().catch(console.error);

export default app;
