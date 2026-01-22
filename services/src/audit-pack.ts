/**
 * BioPassport V2 Audit Pack Generator
 * Generates machine-readable JSON and human-readable PDF audit packages
 */

import { Pool } from 'pg';
import { ethers } from 'ethers';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import { computeCredentialHash, computeEvidenceRoot, hashAssetId } from './crypto';

// ==================== Types ====================

export interface AuditPack {
  version: string;
  generatedAt: string;
  generatedBy?: string;
  
  asset: {
    assetId: string;
    assetIdHash: string;
    pointer: string;
    registrar: string;
    createdAt: string;
    credentialCount: number;
    hasOpenExceptions: boolean;
  };
  
  credentialChain: CredentialEntry[];
  
  evidenceSummary: {
    totalFiles: number;
    verifiedFiles: number;
    failedFiles: number;
  };
  
  verificationResults: {
    overallStatus: 'PASS' | 'FAIL' | 'PARTIAL';
    checks: VerificationCheck[];
  };
  
  exceptionHistory: ExceptionEntry[];
  
  chainProof: {
    contractAddress: string;
    networkId: string;
    blockRange: { from: number; to: number };
    relevantTxHashes: string[];
  };
}

interface CredentialEntry {
  position: number;
  credentialHash: string;
  prevHash: string | null;
  credentialType: string;
  issuerOrg: string;
  issuer: string;
  issuedAt: string;
  evidenceRoot: string;
  pointer: string;
  blockNumber: number;
  txHash: string;
  evidenceFiles: EvidenceFile[];
}

interface EvidenceFile {
  uri: string;
  sha256: string;
  filename: string;
  verified: boolean;
  verifiedAt?: string;
}

interface VerificationCheck {
  name: string;
  passed: boolean;
  details: string;
  timestamp: string;
}

interface ExceptionEntry {
  exceptionId: number;
  reasonCode: number;
  reason: string;
  detailsPointer: string;
  openedBy: string;
  openedAt: string;
  closed: boolean;
  closedBy?: string;
  closedAt?: string;
  resolutionPointer?: string;
}

// ==================== Generator ====================

export async function generateAuditPack(
  assetId: string,
  db: Pool,
  contract?: ethers.Contract,
  options?: { generatedBy?: string }
): Promise<AuditPack> {
  const assetIdHash = hashAssetId(assetId);
  const hashBuffer = Buffer.from(assetIdHash.slice(2), 'hex');
  
  // Fetch asset
  const assetResult = await db.query(`
    SELECT * FROM assets WHERE asset_id_hash = $1
  `, [hashBuffer]);
  
  if (assetResult.rows.length === 0) {
    throw new Error(`Asset not found: ${assetId}`);
  }
  
  const asset = assetResult.rows[0];
  
  // Fetch credentials in chain order
  const credentialsResult = await db.query(`
    SELECT c.*, 
      (SELECT json_agg(e) FROM evidence_files e WHERE e.credential_hash = c.credential_hash) as evidence_files
    FROM credentials c
    WHERE c.asset_id_hash = $1
    ORDER BY c.issued_at ASC
  `, [hashBuffer]);
  
  // Fetch exceptions
  const exceptionsResult = await db.query(`
    SELECT * FROM exceptions WHERE asset_id_hash = $1 ORDER BY opened_at ASC
  `, [hashBuffer]);
  
  // Fetch verification history
  const verificationsResult = await db.query(`
    SELECT * FROM verifications WHERE asset_id_hash = $1 ORDER BY checked_at DESC LIMIT 10
  `, [hashBuffer]);
  
  // Build credential chain
  const credentialChain: CredentialEntry[] = credentialsResult.rows.map((row, idx) => ({
    position: idx + 1,
    credentialHash: '0x' + row.credential_hash.toString('hex'),
    prevHash: row.prev_hash ? '0x' + row.prev_hash.toString('hex') : null,
    credentialType: row.credential_type || 'UNKNOWN',
    issuerOrg: row.issuer_org || '',
    issuer: row.issuer,
    issuedAt: row.issued_at.toISOString(),
    evidenceRoot: '0x' + row.evidence_root.toString('hex'),
    pointer: row.pointer,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    evidenceFiles: (row.evidence_files || []).map((ef: any) => ({
      uri: ef.uri,
      sha256: ef.sha256_hash ? ef.sha256_hash.toString('hex') : ef.sha256,
      filename: ef.filename,
      verified: ef.verification_passed || false,
      verifiedAt: ef.last_verified_at?.toISOString(),
    })),
  }));
  
  // Compute evidence summary
  let totalFiles = 0;
  let verifiedFiles = 0;
  let failedFiles = 0;
  
  for (const cred of credentialChain) {
    for (const ef of cred.evidenceFiles) {
      totalFiles++;
      if (ef.verified) verifiedFiles++;
      else failedFiles++;
    }
  }
  
  // Build verification checks
  const checks: VerificationCheck[] = [];
  
  // Check 1: Chain integrity
  let chainIntact = true;
  for (let i = 1; i < credentialChain.length; i++) {
    const expected = credentialChain[i - 1].credentialHash;
    const actual = credentialChain[i].prevHash;
    if (expected !== actual) {
      chainIntact = false;
      break;
    }
  }
  checks.push({
    name: 'Chain Integrity',
    passed: chainIntact,
    details: chainIntact 
      ? `All ${credentialChain.length} credentials properly linked`
      : 'Chain linkage broken - prevHash mismatch detected',
    timestamp: new Date().toISOString(),
  });
  
  // Check 2: Evidence completeness
  const evidenceComplete = failedFiles === 0;
  checks.push({
    name: 'Evidence Completeness',
    passed: evidenceComplete,
    details: evidenceComplete
      ? `All ${totalFiles} evidence files verified`
      : `${failedFiles} of ${totalFiles} evidence files failed verification`,
    timestamp: new Date().toISOString(),
  });
  
  // Check 3: No open exceptions
  const openExceptions = exceptionsResult.rows.filter((e: any) => !e.closed);
  const noOpenExceptions = openExceptions.length === 0;
  checks.push({
    name: 'Exception Status',
    passed: noOpenExceptions,
    details: noOpenExceptions
      ? 'No open exceptions'
      : `${openExceptions.length} open exception(s) require resolution`,
    timestamp: new Date().toISOString(),
  });
  
  // Overall status
  const allPassed = checks.every(c => c.passed);
  const somePassed = checks.some(c => c.passed);
  const overallStatus: 'PASS' | 'FAIL' | 'PARTIAL' = 
    allPassed ? 'PASS' : (somePassed ? 'PARTIAL' : 'FAIL');
  
  // Build exception history
  const exceptionHistory: ExceptionEntry[] = exceptionsResult.rows.map((row: any) => ({
    exceptionId: row.exception_id,
    reasonCode: row.reason_code,
    reason: row.reason || 'UNKNOWN',
    detailsPointer: row.details_pointer,
    openedBy: row.opened_by,
    openedAt: row.opened_at.toISOString(),
    closed: row.closed,
    closedBy: row.closed_by,
    closedAt: row.closed_at?.toISOString(),
    resolutionPointer: row.resolution_pointer,
  }));
  
  // Build chain proof
  const txHashes = credentialsResult.rows.map((r: any) => r.tx_hash);
  const blockNumbers = credentialsResult.rows.map((r: any) => r.block_number);
  
  const pack: AuditPack = {
    version: '2.0',
    generatedAt: new Date().toISOString(),
    generatedBy: options?.generatedBy,
    
    asset: {
      assetId,
      assetIdHash,
      pointer: asset.pointer,
      registrar: asset.registrar,
      createdAt: asset.created_at.toISOString(),
      credentialCount: credentialChain.length,
      hasOpenExceptions: openExceptions.length > 0,
    },
    
    credentialChain,
    
    evidenceSummary: {
      totalFiles,
      verifiedFiles,
      failedFiles,
    },
    
    verificationResults: {
      overallStatus,
      checks,
    },
    
    exceptionHistory,
    
    chainProof: {
      contractAddress: contract?.target?.toString() || process.env.CONTRACT_ADDRESS || '',
      networkId: process.env.NETWORK_ID || 'hardhat-31337',
      blockRange: {
        from: blockNumbers.length > 0 ? Math.min(...blockNumbers) : 0,
        to: blockNumbers.length > 0 ? Math.max(...blockNumbers) : 0,
      },
      relevantTxHashes: txHashes,
    },
  };
  
  return pack;
}

// ==================== PDF Generation ====================

export async function generateAuditPackPDF(
  pack: AuditPack,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    
    doc.pipe(stream);
    
    // Title
    doc.fontSize(24).font('Helvetica-Bold').text('BioPassport Audit Pack', { align: 'center' });
    doc.moveDown();
    
    // Metadata
    doc.fontSize(10).font('Helvetica')
      .text(`Generated: ${pack.generatedAt}`)
      .text(`Version: ${pack.version}`)
      .text(`Status: ${pack.verificationResults.overallStatus}`);
    doc.moveDown();
    
    // Asset Summary
    doc.fontSize(16).font('Helvetica-Bold').text('Asset Summary');
    doc.fontSize(10).font('Helvetica')
      .text(`Asset ID: ${pack.asset.assetId}`)
      .text(`Asset ID Hash: ${pack.asset.assetIdHash}`)
      .text(`Registrar: ${pack.asset.registrar}`)
      .text(`Created: ${pack.asset.createdAt}`)
      .text(`Credentials: ${pack.asset.credentialCount}`)
      .text(`Open Exceptions: ${pack.asset.hasOpenExceptions ? 'Yes' : 'No'}`);
    doc.moveDown();
    
    // Credential Chain
    doc.fontSize(16).font('Helvetica-Bold').text('Credential Chain');
    doc.moveDown(0.5);
    
    for (const cred of pack.credentialChain) {
      doc.fontSize(11).font('Helvetica-Bold')
        .text(`#${cred.position}: ${cred.credentialType}`);
      doc.fontSize(9).font('Helvetica')
        .text(`Hash: ${cred.credentialHash}`)
        .text(`Issuer: ${cred.issuerOrg} (${cred.issuer})`)
        .text(`Issued: ${cred.issuedAt}`)
        .text(`Evidence: ${cred.evidenceFiles.length} file(s)`)
        .text(`Block: ${cred.blockNumber} | Tx: ${cred.txHash.slice(0, 18)}...`);
      doc.moveDown(0.5);
    }
    
    // Verification Results
    doc.addPage();
    doc.fontSize(16).font('Helvetica-Bold').text('Verification Results');
    doc.moveDown(0.5);
    
    for (const check of pack.verificationResults.checks) {
      const icon = check.passed ? '✓' : '✗';
      doc.fontSize(11).font('Helvetica-Bold')
        .text(`${icon} ${check.name}: ${check.passed ? 'PASS' : 'FAIL'}`);
      doc.fontSize(9).font('Helvetica')
        .text(check.details);
      doc.moveDown(0.3);
    }
    
    // Exception History
    if (pack.exceptionHistory.length > 0) {
      doc.moveDown();
      doc.fontSize(16).font('Helvetica-Bold').text('Exception History');
      doc.moveDown(0.5);
      
      for (const exc of pack.exceptionHistory) {
        const status = exc.closed ? 'CLOSED' : 'OPEN';
        doc.fontSize(11).font('Helvetica-Bold')
          .text(`#${exc.exceptionId}: ${exc.reason} [${status}]`);
        doc.fontSize(9).font('Helvetica')
          .text(`Opened: ${exc.openedAt} by ${exc.openedBy}`);
        if (exc.closed) {
          doc.text(`Closed: ${exc.closedAt} by ${exc.closedBy}`);
        }
        doc.moveDown(0.3);
      }
    }
    
    // Chain Proof
    doc.addPage();
    doc.fontSize(16).font('Helvetica-Bold').text('Blockchain Proof');
    doc.fontSize(10).font('Helvetica')
      .text(`Contract: ${pack.chainProof.contractAddress}`)
      .text(`Network: ${pack.chainProof.networkId}`)
      .text(`Block Range: ${pack.chainProof.blockRange.from} - ${pack.chainProof.blockRange.to}`);
    doc.moveDown();
    doc.text('Transaction Hashes:');
    for (const tx of pack.chainProof.relevantTxHashes) {
      doc.fontSize(8).text(`  ${tx}`);
    }
    
    // Footer
    doc.moveDown(2);
    doc.fontSize(8).font('Helvetica-Oblique')
      .text('This audit pack provides cryptographic proof of biological material provenance.', { align: 'center' })
      .text('Verify on-chain data independently using the transaction hashes above.', { align: 'center' });
    
    doc.end();
    
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

export default { generateAuditPack, generateAuditPackPDF };
