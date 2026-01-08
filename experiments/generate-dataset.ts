/**
 * Synthetic Dataset Generator for BioPassport Experiments
 * 
 * Generates a realistic dataset with:
 * - 500 materials (mix of cell lines + plasmids)
 * - 2 issuers (Repository + QC Lab) + 2 holder labs
 * - 1-3 transfers per material
 * - QC validity windows (30/60/90 days)
 * - 5-10% tampered artifacts
 * - 5-10% expired QC credentials
 * - 1-2% revoked materials
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ==================== Configuration ====================

type DatasetType = 'normal' | 'drift' | 'adversarial';

interface DatasetConfig {
  totalMaterials: number;
  cellLineRatio: number;  // 0.7 = 70% cell lines, 30% plasmids
  
  issuers: {
    repository: string;
    qcLab: string;
  };
  
  holderLabs: string[];
  
  transfersPerMaterial: { min: number; max: number };
  
  qcValidityDays: number[];  // [30, 60, 90]
  
  // Anomaly rates
  tamperedArtifactRate: number;   // 0.05-0.10
  expiredQCRate: number;          // 0.05-0.10
  revokedMaterialRate: number;    // 0.01-0.02
  quarantinedMaterialRate: number; // For QC-triggered quarantine
  pendingTransferRate: number;    // 0.03
  unauthorizedIssuerRate: number; // For adversarial dataset - simulates rejected issuance
}

// Dataset presets for different experiment scenarios
const DATASET_PRESETS: Record<DatasetType, DatasetConfig> = {
  // Normal operations: ~75-80% PASS (realistic day-to-day usage)
  normal: {
    totalMaterials: 500,
    cellLineRatio: 0.7,
    issuers: {
      repository: 'BioRepository_MSP',
      qcLab: 'CertifiedQCLab_MSP'
    },
    holderLabs: ['LabA_MSP', 'LabB_MSP'],
    transfersPerMaterial: { min: 1, max: 3 },
    qcValidityDays: [60, 90, 120],  // Longer validity for normal ops
    tamperedArtifactRate: 0.02,     // Very low tampering
    expiredQCRate: 0.12,            // ~12% naturally expired (nudged up for 75-80% PASS)
    revokedMaterialRate: 0.01,      // ~1% revoked
    quarantinedMaterialRate: 0.02,  // ~2% quarantined (QC-triggered)
    pendingTransferRate: 0.06,      // ~6% in transit
    unauthorizedIssuerRate: 0.0     // No unauthorized issuers
  },
  
  // Compliance drift: QC expiry grows over time (PASS → FAIL trend)
  drift: {
    totalMaterials: 500,
    cellLineRatio: 0.7,
    issuers: {
      repository: 'BioRepository_MSP',
      qcLab: 'CertifiedQCLab_MSP'
    },
    holderLabs: ['LabA_MSP', 'LabB_MSP'],
    transfersPerMaterial: { min: 1, max: 2 },
    qcValidityDays: [30, 45, 60],   // Shorter validity windows
    tamperedArtifactRate: 0.03,     // Low tampering
    expiredQCRate: 0.40,            // 40% expired (drift scenario)
    revokedMaterialRate: 0.02,      // ~2% revoked
    quarantinedMaterialRate: 0.03,  // ~3% quarantined
    pendingTransferRate: 0.03,      // ~3% pending
    unauthorizedIssuerRate: 0.0     // No unauthorized issuers
  },
  
  // Adversarial: tampered artifacts + replayed QC + unauthorized issuers (~60-70% FAIL)
  adversarial: {
    totalMaterials: 500,
    cellLineRatio: 0.7,
    issuers: {
      repository: 'BioRepository_MSP',
      qcLab: 'CertifiedQCLab_MSP'
    },
    holderLabs: ['LabA_MSP', 'LabB_MSP'],
    transfersPerMaterial: { min: 1, max: 3 },
    qcValidityDays: [30, 60, 90],
    tamperedArtifactRate: 0.35,     // 35% tampered artifacts (increased)
    expiredQCRate: 0.35,            // 35% expired/replayed QC (increased)
    revokedMaterialRate: 0.07,      // 7% revoked (increased)
    quarantinedMaterialRate: 0.05,  // 5% quarantined
    pendingTransferRate: 0.10,      // 10% pending (increased)
    unauthorizedIssuerRate: 0.10    // 10% unauthorized issuer attempts (simulates missing QC)
  }
};

const DEFAULT_CONFIG: DatasetConfig = DATASET_PRESETS.normal;

// ==================== Types ====================

interface GeneratedMaterial {
  materialId: string;
  materialType: 'CELL_LINE' | 'PLASMID';
  metadata: MaterialMetadata;
  metadataHash: string;
  ownerOrg: string;
  status: 'ACTIVE' | 'QUARANTINED' | 'REVOKED';
  createdAt: string;
  credentials: GeneratedCredential[];
  transfers: GeneratedTransfer[];
  anomalies: string[];
}

interface MaterialMetadata {
  name: string;
  description: string;
  species?: string;
  tissueType?: string;
  cellType?: string;
  plasmidSize?: number;
  selectionMarker?: string;
  biosafety: string;
}

interface GeneratedCredential {
  credentialId: string;
  credentialType: 'IDENTITY' | 'QC_MYCO' | 'TRANSFER' | 'USAGE_RIGHTS';
  issuerId: string;
  issuedAt: string;
  validUntil: string;
  commitmentHash: string;
  payload: Record<string, unknown>;
  artifactRef?: {
    cid: string;
    hash: string;
    tampered: boolean;
  };
  expired: boolean;
  revoked: boolean;
  unauthorizedIssuer: boolean;
}

interface GeneratedTransfer {
  transferId: string;
  fromOrg: string;
  toOrg: string;
  timestamp: string;
  accepted: boolean;
  shipmentHash: string;
}

interface DatasetSummary {
  totalMaterials: number;
  byType: { cellLines: number; plasmids: number };
  byStatus: { active: number; quarantined: number; revoked: number };
  totalCredentials: number;
  totalTransfers: number;
  anomalies: {
    tamperedArtifacts: number;
    expiredQC: number;
    missingQC: number;
    revokedMaterials: number;
    quarantinedMaterials: number;
    pendingTransfers: number;
  };
  // Split verification results: on-chain vs full (on-chain + artifact integrity)
  onChainVerification: {
    pass: number;
    fail: number;
    failReasons: Record<string, number>;
  };
  fullVerification: {
    pass: number;
    fail: number;
    failReasons: Record<string, number>;
  };
}

// ==================== Generator ====================

class DatasetGenerator {
  private config: DatasetConfig;
  private materials: GeneratedMaterial[] = [];
  private summary: DatasetSummary;

  constructor(config: DatasetConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.summary = this.initSummary();
  }

  private initSummary(): DatasetSummary {
    return {
      totalMaterials: 0,
      byType: { cellLines: 0, plasmids: 0 },
      byStatus: { active: 0, quarantined: 0, revoked: 0 },
      totalCredentials: 0,
      totalTransfers: 0,
      anomalies: {
        tamperedArtifacts: 0,
        expiredQC: 0,
        missingQC: 0,
        revokedMaterials: 0,
        quarantinedMaterials: 0,
        pendingTransfers: 0
      },
      onChainVerification: {
        pass: 0,
        fail: 0,
        failReasons: {}
      },
      fullVerification: {
        pass: 0,
        fail: 0,
        failReasons: {}
      }
    };
  }

  generate(): { materials: GeneratedMaterial[]; summary: DatasetSummary } {
    console.log(`Generating ${this.config.totalMaterials} materials...`);

    for (let i = 0; i < this.config.totalMaterials; i++) {
      const material = this.generateMaterial(i);
      this.materials.push(material);
      this.updateSummary(material);

      if ((i + 1) % 100 === 0) {
        console.log(`  Generated ${i + 1}/${this.config.totalMaterials}`);
      }
    }

    this.calculateExpectedResults();
    return { materials: this.materials, summary: this.summary };
  }

  private generateMaterial(index: number): GeneratedMaterial {
    const isCellLine = Math.random() < this.config.cellLineRatio;
    const materialType = isCellLine ? 'CELL_LINE' : 'PLASMID';
    const materialId = `bio:${materialType.toLowerCase()}:${this.uuid()}`;

    // Determine anomaly flags for this material (used during generation)
    const isRevoked = Math.random() < this.config.revokedMaterialRate;
    const isQuarantined = !isRevoked && Math.random() < this.config.quarantinedMaterialRate;
    const forceExpiredQC = Math.random() < this.config.expiredQCRate;
    const forceTamperedArtifact = Math.random() < this.config.tamperedArtifactRate;
    const forceUnauthorizedIssuer = Math.random() < this.config.unauthorizedIssuerRate;

    // Generate metadata
    const metadata = isCellLine
      ? this.generateCellLineMetadata(index)
      : this.generatePlasmidMetadata(index);

    const metadataHash = this.sha256(JSON.stringify(metadata));

    // Determine initial owner and status
    const initialOwner = this.config.issuers.repository;
    const status = isRevoked ? 'REVOKED' : (isQuarantined ? 'QUARANTINED' : 'ACTIVE');

    const createdAt = this.randomDate(-365, -30); // Created 1-12 months ago

    // Generate credentials
    const credentials = this.generateCredentials(
      materialId,
      materialType,
      createdAt,
      forceExpiredQC,
      forceTamperedArtifact,
      forceUnauthorizedIssuer
    );

    // Generate transfers
    const transfers = this.generateTransfers(materialId, initialOwner, createdAt);

    // Determine current owner from transfers
    const ownerOrg = transfers.length > 0 && transfers[transfers.length - 1].accepted
      ? transfers[transfers.length - 1].toOrg
      : initialOwner;

    // FIX: Compute anomalies from ACTUAL state after generation
    const anomalies: string[] = [];
    const hasQC = credentials.some(c => c.credentialType === 'QC_MYCO');
    const qcExpired = credentials.some(c => c.credentialType === 'QC_MYCO' && c.expired);
    const tampered = credentials.some(c => c.artifactRef?.tampered);
    const pending = transfers.some(t => !t.accepted);

    if (status === 'REVOKED') anomalies.push('REVOKED');
    if (status === 'QUARANTINED') anomalies.push('QUARANTINED');
    if (!hasQC) anomalies.push('MISSING_QC'); // Unauthorized issuer was rejected
    if (qcExpired) anomalies.push('EXPIRED_QC');
    if (tampered) anomalies.push('TAMPERED_ARTIFACT');
    if (pending) anomalies.push('PENDING_TRANSFER');

    return {
      materialId,
      materialType,
      metadata,
      metadataHash,
      ownerOrg,
      status,
      createdAt,
      credentials,
      transfers,
      anomalies
    };
  }

  private generateCellLineMetadata(index: number): MaterialMetadata {
    const cellLines = [
      { name: 'HeLa', species: 'Human', tissue: 'Cervix', cell: 'Epithelial' },
      { name: 'HEK293', species: 'Human', tissue: 'Kidney', cell: 'Epithelial' },
      { name: 'CHO', species: 'Hamster', tissue: 'Ovary', cell: 'Epithelial' },
      { name: 'Jurkat', species: 'Human', tissue: 'Blood', cell: 'T-lymphocyte' },
      { name: 'MCF-7', species: 'Human', tissue: 'Breast', cell: 'Epithelial' },
      { name: 'A549', species: 'Human', tissue: 'Lung', cell: 'Epithelial' },
      { name: 'NIH3T3', species: 'Mouse', tissue: 'Embryo', cell: 'Fibroblast' },
      { name: 'U2OS', species: 'Human', tissue: 'Bone', cell: 'Osteosarcoma' }
    ];

    const base = cellLines[index % cellLines.length];
    const variant = Math.floor(index / cellLines.length) + 1;

    return {
      name: `${base.name}-${variant}`,
      description: `${base.name} cell line variant ${variant} for research`,
      species: base.species,
      tissueType: base.tissue,
      cellType: base.cell,
      biosafety: 'BSL-2'
    };
  }

  private generatePlasmidMetadata(index: number): MaterialMetadata {
    const plasmids = [
      { name: 'pUC19', size: 2686, marker: 'Ampicillin' },
      { name: 'pBR322', size: 4361, marker: 'Ampicillin/Tetracycline' },
      { name: 'pET28a', size: 5369, marker: 'Kanamycin' },
      { name: 'pcDNA3.1', size: 5428, marker: 'Ampicillin/Neomycin' },
      { name: 'pGEX-4T', size: 4969, marker: 'Ampicillin' },
      { name: 'pEGFP-N1', size: 4733, marker: 'Kanamycin/Neomycin' }
    ];

    const base = plasmids[index % plasmids.length];
    const variant = Math.floor(index / plasmids.length) + 1;

    return {
      name: `${base.name}-v${variant}`,
      description: `${base.name} expression vector variant ${variant}`,
      plasmidSize: base.size + (variant * 100),
      selectionMarker: base.marker,
      biosafety: 'BSL-1'
    };
  }

  private generateCredentials(
    materialId: string,
    materialType: string,
    createdAt: string,
    hasExpiredQC: boolean,
    hasTamperedArtifact: boolean,
    hasUnauthorizedIssuer: boolean
  ): GeneratedCredential[] {
    const credentials: GeneratedCredential[] = [];
    const createdDate = new Date(createdAt);

    // 1. IDENTITY credential (always present, from repository)
    const identityDate = new Date(createdDate.getTime() + 24 * 60 * 60 * 1000); // +1 day
    credentials.push(this.generateIdentityCredential(
      materialId,
      materialType,
      identityDate,
      hasTamperedArtifact && Math.random() < 0.3 // 30% chance tampered artifact is on identity
    ));

    // 2. QC_MYCO credential (from QC lab)
    // If unauthorized issuer attack, simulate missing QC (contract rejected the issuance)
    if (!hasUnauthorizedIssuer) {
      const qcDate = new Date(createdDate.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days
      const validityDays = this.config.qcValidityDays[
        Math.floor(Math.random() * this.config.qcValidityDays.length)
      ];
      credentials.push(this.generateQCCredential(
        materialId,
        qcDate,
        validityDays,
        hasExpiredQC,
        hasTamperedArtifact && Math.random() >= 0.3 // 70% chance tampered artifact is on QC
      ));
    }
    // else: QC credential is missing because unauthorized issuer was rejected by contract

    // 3. USAGE_RIGHTS credential (50% chance)
    if (Math.random() < 0.5) {
      const usageDate = new Date(createdDate.getTime() + 14 * 24 * 60 * 60 * 1000);
      credentials.push(this.generateUsageRightsCredential(materialId, usageDate));
    }

    return credentials;
  }

  private generateIdentityCredential(
    materialId: string,
    materialType: string,
    issuedAt: Date,
    tampered: boolean
  ): GeneratedCredential {
    const payload = {
      materialId,
      verificationMethod: materialType === 'CELL_LINE' ? 'STR_PROFILE' : 'SEQUENCING',
      verificationResult: this.sha256(`identity-${materialId}`).substring(0, 32),
      referenceDatabase: materialType === 'CELL_LINE' ? 'Cellosaurus' : 'GenBank',
      matchScore: 95 + Math.floor(Math.random() * 5)
    };

    const artifactHash = this.sha256(JSON.stringify(payload) + '-artifact');

    return {
      credentialId: `cred:identity:${this.uuid()}`,
      credentialType: 'IDENTITY',
      issuerId: this.config.issuers.repository,
      issuedAt: issuedAt.toISOString(),
      validUntil: new Date(issuedAt.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      commitmentHash: this.sha256(JSON.stringify(payload)),
      payload,
      artifactRef: {
        cid: `s3://biopassport/identity/${materialId.replace(/:/g, '-')}.pdf`,
        hash: tampered ? this.sha256('tampered-' + artifactHash) : artifactHash,
        tampered
      },
      expired: false,
      revoked: false,
      unauthorizedIssuer: false
    };
  }

  private generateQCCredential(
    materialId: string,
    _issuedAt: Date, // Unused - we compute actualIssuedAt based on forceExpired
    validityDays: number,
    forceExpired: boolean,
    tampered: boolean
  ): GeneratedCredential {
    const DAY = 24 * 60 * 60 * 1000;

    // FIX: If forcing expired, set issuedAt to (validityDays + extra) days ago.
    // If NOT forcing expired, set issuedAt within the last (validityDays - buffer) days,
    // so it is very likely still valid today.
    const actualIssuedAt = forceExpired
      ? new Date(Date.now() - (validityDays + this.randomInt(15, 90)) * DAY)
      : new Date(Date.now() - this.randomInt(1, Math.max(2, validityDays - 5)) * DAY);

    const validUntil = new Date(actualIssuedAt.getTime() + validityDays * DAY);
    const expired = validUntil.getTime() < Date.now();

    const payload = {
      materialId,
      testType: 'MYCOPLASMA',
      result: 'NEGATIVE',
      testMethod: Math.random() < 0.5 ? 'PCR' : 'CULTURE',
      testDate: actualIssuedAt.toISOString().split('T')[0],
      laboratory: this.config.issuers.qcLab,
      labAccreditation: 'ISO-17025-' + Math.floor(Math.random() * 100000),
      sampleId: `QC-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    };

    const artifactHash = this.sha256(JSON.stringify(payload) + '-report');

    return {
      credentialId: `cred:qc_myco:${this.uuid()}`,
      credentialType: 'QC_MYCO',
      issuerId: this.config.issuers.qcLab,
      issuedAt: actualIssuedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      commitmentHash: this.sha256(JSON.stringify(payload)),
      payload,
      artifactRef: {
        cid: `s3://biopassport/qc/${materialId.replace(/:/g, '-')}-myco.pdf`,
        hash: tampered ? this.sha256('tampered-' + artifactHash) : artifactHash,
        tampered
      },
      expired,
      revoked: false,
      unauthorizedIssuer: false
    };
  }

  private generateUsageRightsCredential(
    materialId: string,
    issuedAt: Date
  ): GeneratedCredential {
    const permissions = ['RESEARCH', 'PUBLICATION'];
    if (Math.random() < 0.3) permissions.push('COMMERCIAL');
    if (Math.random() < 0.2) permissions.push('DERIVATIVE_WORKS');

    const payload = {
      materialId,
      grantedPermissions: permissions,
      restrictions: ['NO_REDISTRIBUTION'],
      mtaReference: `MTA-${Date.now()}`,
      effectiveDate: issuedAt.toISOString().split('T')[0]
    };

    return {
      credentialId: `cred:usage:${this.uuid()}`,
      credentialType: 'USAGE_RIGHTS',
      issuerId: this.config.issuers.repository,
      issuedAt: issuedAt.toISOString(),
      validUntil: new Date(issuedAt.getTime() + 730 * 24 * 60 * 60 * 1000).toISOString(), // 2 years
      commitmentHash: this.sha256(JSON.stringify(payload)),
      payload,
      expired: false,
      revoked: false,
      unauthorizedIssuer: false
    };
  }

  private generateTransfers(
    materialId: string,
    initialOwner: string,
    createdAt: string
  ): GeneratedTransfer[] {
    const transfers: GeneratedTransfer[] = [];
    const numTransfers = this.randomInt(
      this.config.transfersPerMaterial.min,
      this.config.transfersPerMaterial.max
    );

    let currentOwner = initialOwner;
    let currentDate = new Date(createdAt);

    for (let i = 0; i < numTransfers; i++) {
      // Pick next owner (different from current)
      const possibleOwners = [
        ...this.config.holderLabs,
        this.config.issuers.repository
      ].filter(o => o !== currentOwner);

      const nextOwner = possibleOwners[Math.floor(Math.random() * possibleOwners.length)];

      // Advance time by 7-60 days
      currentDate = new Date(currentDate.getTime() + this.randomInt(7, 60) * 24 * 60 * 60 * 1000);

      // Determine if transfer is pending (not accepted)
      const isPending = i === numTransfers - 1 && Math.random() < this.config.pendingTransferRate;

      transfers.push({
        transferId: `xfer:${this.uuid()}`,
        fromOrg: currentOwner,
        toOrg: nextOwner,
        timestamp: currentDate.toISOString(),
        accepted: !isPending,
        shipmentHash: this.sha256(`shipment-${materialId}-${i}`)
      });

      if (!isPending) {
        currentOwner = nextOwner;
      }
    }

    return transfers;
  }

  private updateSummary(material: GeneratedMaterial): void {
    this.summary.totalMaterials++;

    if (material.materialType === 'CELL_LINE') {
      this.summary.byType.cellLines++;
    } else {
      this.summary.byType.plasmids++;
    }

    if (material.status === 'ACTIVE') this.summary.byStatus.active++;
    else if (material.status === 'QUARANTINED') this.summary.byStatus.quarantined++;
    else if (material.status === 'REVOKED') this.summary.byStatus.revoked++;

    this.summary.totalCredentials += material.credentials.length;
    this.summary.totalTransfers += material.transfers.length;

    // Count anomalies from actual state
    if (material.anomalies.includes('REVOKED')) {
      this.summary.anomalies.revokedMaterials++;
    }
    if (material.anomalies.includes('QUARANTINED')) {
      this.summary.anomalies.quarantinedMaterials++;
    }
    if (material.anomalies.includes('MISSING_QC')) {
      this.summary.anomalies.missingQC++;
    }
    if (material.anomalies.includes('EXPIRED_QC')) {
      this.summary.anomalies.expiredQC++;
    }
    if (material.anomalies.includes('TAMPERED_ARTIFACT')) {
      this.summary.anomalies.tamperedArtifacts++;
    }
    if (material.anomalies.includes('PENDING_TRANSFER')) {
      this.summary.anomalies.pendingTransfers++;
    }
  }

  private calculateExpectedResults(): void {
    const onChainFailReasons: Record<string, number> = {};
    const fullFailReasons: Record<string, number> = {};
    let onChainPass = 0;
    let fullPass = 0;

    for (const material of this.materials) {
      const onChainReasons: string[] = [];
      const fullReasons: string[] = [];

      // On-chain checks
      if (material.status === 'REVOKED') {
        onChainReasons.push('MATERIAL_REVOKED');
      } else if (material.status === 'QUARANTINED') {
        onChainReasons.push('MATERIAL_QUARANTINED');
      }

      const hasIdentity = material.credentials.some(c => c.credentialType === 'IDENTITY' && !c.revoked);
      if (!hasIdentity) {
        onChainReasons.push('MISSING_IDENTITY');
      }

      const qcCred = material.credentials.find(c => c.credentialType === 'QC_MYCO');
      if (!qcCred) {
        onChainReasons.push('QC_MISSING'); // Unauthorized issuer was rejected
      } else if (qcCred.expired) {
        onChainReasons.push('QC_EXPIRED');
      }

      const hasPending = material.transfers.some(t => !t.accepted);
      if (hasPending) {
        onChainReasons.push('TRANSFER_PENDING');
      }

      // Full verification adds artifact integrity check
      const hasTampered = material.credentials.some(c => c.artifactRef?.tampered);
      if (hasTampered) {
        fullReasons.push('ARTIFACT_TAMPERED');
      }

      // Count results
      const onChainPasses = onChainReasons.length === 0;
      const fullPasses = onChainPasses && fullReasons.length === 0;

      if (onChainPasses) {
        onChainPass++;
      } else {
        for (const reason of onChainReasons) {
          onChainFailReasons[reason] = (onChainFailReasons[reason] || 0) + 1;
        }
      }

      if (fullPasses) {
        fullPass++;
      } else {
        // Include both on-chain and full reasons
        for (const reason of [...onChainReasons, ...fullReasons]) {
          fullFailReasons[reason] = (fullFailReasons[reason] || 0) + 1;
        }
      }
    }

    // Store both on-chain and full verification results
    this.summary.onChainVerification.pass = onChainPass;
    this.summary.onChainVerification.fail = this.materials.length - onChainPass;
    this.summary.onChainVerification.failReasons = onChainFailReasons;
    
    this.summary.fullVerification.pass = fullPass;
    this.summary.fullVerification.fail = this.materials.length - fullPass;
    this.summary.fullVerification.failReasons = fullFailReasons;
  }

  // ==================== Utilities ====================

  private uuid(): string {
    return crypto.randomUUID();
  }

  private sha256(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private randomDate(daysAgoMin: number, daysAgoMax: number): string {
    const daysAgo = this.randomInt(Math.abs(daysAgoMax), Math.abs(daysAgoMin));
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    return date.toISOString();
  }
}

// ==================== Main ====================

function generateDataset(datasetType: DatasetType, outputDir: string): void {
  const config = DATASET_PRESETS[datasetType];
  const generator = new DatasetGenerator(config);
  const { materials, summary } = generator.generate();

  // Create output subdirectory
  const typeDir = path.join(outputDir, datasetType);
  fs.mkdirSync(typeDir, { recursive: true });

  // Save materials
  const materialsPath = path.join(typeDir, 'materials.json');
  fs.writeFileSync(materialsPath, JSON.stringify(materials, null, 2));

  // Save summary
  const summaryPath = path.join(typeDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Generate CSV with split on-chain vs full verification results
  const csvPath = path.join(typeDir, 'materials.csv');
  const csvHeader = 'materialId,materialType,status,ownerOrg,numCredentials,numTransfers,hasIdentity,hasQC,hasExpiredQC,hasTamperedArtifact,hasPendingTransfer,expectedOnChain,expectedFull\n';
  const csvRows = materials.map(m => {
    const hasIdentity = m.credentials.some(c => c.credentialType === 'IDENTITY' && !c.revoked);
    const hasQC = m.credentials.some(c => c.credentialType === 'QC_MYCO');
    const hasExpiredQC = m.credentials.some(c => c.credentialType === 'QC_MYCO' && c.expired);
    const hasTampered = m.credentials.some(c => c.artifactRef?.tampered);
    const hasPending = m.transfers.some(t => !t.accepted);

    // On-chain verification: status, identity, QC present & not expired, no pending transfers
    const expectedOnChain = (m.status === 'ACTIVE') && hasIdentity && hasQC && !hasExpiredQC && !hasPending ? 'PASS' : 'FAIL';
    // Full verification: on-chain + off-chain artifact integrity
    const expectedFull = (expectedOnChain === 'PASS') && !hasTampered ? 'PASS' : 'FAIL';

    return `${m.materialId},${m.materialType},${m.status},${m.ownerOrg},${m.credentials.length},${m.transfers.length},${hasIdentity},${hasQC},${hasExpiredQC},${hasTampered},${hasPending},${expectedOnChain},${expectedFull}`;
  }).join('\n');
  fs.writeFileSync(csvPath, csvHeader + csvRows);

  // Print summary with both on-chain and full verification results
  console.log(`\n─ ${datasetType.toUpperCase()} DATASET ─`);
  console.log(`  Materials: ${summary.totalMaterials}`);
  console.log(`  On-chain verification (contract):`);
  console.log(`    PASS: ${summary.onChainVerification.pass} (${(summary.onChainVerification.pass / summary.totalMaterials * 100).toFixed(1)}%)`);
  console.log(`    FAIL: ${summary.onChainVerification.fail} (${(summary.onChainVerification.fail / summary.totalMaterials * 100).toFixed(1)}%)`);
  console.log(`  Full verification (contract + artifact integrity):`);
  console.log(`    PASS: ${summary.fullVerification.pass} (${(summary.fullVerification.pass / summary.totalMaterials * 100).toFixed(1)}%)`);
  console.log(`    FAIL: ${summary.fullVerification.fail} (${(summary.fullVerification.fail / summary.totalMaterials * 100).toFixed(1)}%)`);
  console.log(`  Anomalies:`);
  console.log(`    revoked=${summary.anomalies.revokedMaterials}, quarantined=${summary.anomalies.quarantinedMaterials}`);
  console.log(`    expiredQC=${summary.anomalies.expiredQC}, missingQC=${summary.anomalies.missingQC}`);
  console.log(`    tampered=${summary.anomalies.tamperedArtifacts}, pending=${summary.anomalies.pendingTransfers}`);
  console.log(`  On-chain fail reasons:`);
  for (const [reason, count] of Object.entries(summary.onChainVerification.failReasons)) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log(`  Output: ${typeDir}/`);
}

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  BIOPASSPORT SYNTHETIC DATASET GENERATOR');
  console.log('  Generating 3 dataset types for experiments');
  console.log('═'.repeat(60));

  const outputDir = path.join(__dirname, 'data');
  fs.mkdirSync(outputDir, { recursive: true });

  // Parse command line args
  const args = process.argv.slice(2);
  const datasetTypes: DatasetType[] = args.length > 0 
    ? args.filter(a => ['normal', 'drift', 'adversarial'].includes(a)) as DatasetType[]
    : ['normal', 'drift', 'adversarial'];

  if (datasetTypes.length === 0) {
    console.log('\nUsage: npm run generate [normal] [drift] [adversarial]');
    console.log('  normal      - ~75-80% PASS (realistic operations)');
    console.log('  drift       - ~50-55% PASS (QC expiry trend)');
    console.log('  adversarial - ~60-70% FAIL (attack scenarios)');
    console.log('\nGenerating all 3 datasets by default...\n');
    datasetTypes.push('normal', 'drift', 'adversarial');
  }

  // Generate each dataset type
  for (const datasetType of datasetTypes) {
    generateDataset(datasetType, outputDir);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  GENERATION COMPLETE');
  console.log('═'.repeat(60));
  console.log('\nDataset descriptions:');
  console.log('  normal/      - Normal operations (~75-80% PASS)');
  console.log('                 Use for: performance benchmarks, scalability tests');
  console.log('  drift/       - Compliance drift (~50-55% PASS)');
  console.log('                 Use for: QC expiry detection, policy enforcement');
  console.log('  adversarial/ - Attack scenarios (~60-70% FAIL)');
  console.log('                 Use for: tamper detection, security forensics');
  console.log('\nEach folder contains:');
  console.log('  materials.json - Full dataset with credentials & transfers');
  console.log('  summary.json   - Statistics and expected results');
  console.log('  materials.csv  - CSV for analysis/plotting');
  console.log('═'.repeat(60));
}

main().catch(console.error);
