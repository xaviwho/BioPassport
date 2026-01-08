# BioPassport

A **policy-enforced credential anchoring architecture** for biomaterial provenance verification, built on **PureChain** - a zero gas fee EVM-compatible blockchain.

> **IEEE ICBC 2026 Submission**: This repository contains the complete implementation, experiments, and reproducibility artifacts for our paper on tamper-evident biomaterial provenance with bounded on-chain state.

## Key Contributions

1. **Dual-layer verification** separating on-chain policy compliance from off-chain artifact integrity
2. **Role-based credential issuance** with issuer revocation semantics that preserve pre-revocation credential validity
3. **Authority-controlled status management** preventing owner abuse of quarantine/revocation
4. **Quantified security tradeoffs** under normal, drift, and adversarial conditions

## Overview

BioPassport provides:
1. **Material Registration** - Register biomaterials (cell lines, plasmids) with stable on-chain IDs
2. **Credential Anchoring** - Anchor credentials (identity, QC, passage, transfer, usage rights) as hash commitments + issuer signatures
3. **Policy Enforcement** - Enforce & verify policies (QC expiry, revocation/quarantine, transfer constraints) with deterministic PASS/FAIL verification

## PureChain Network

- **RPC Endpoint**: https://purechainnode.com:8547
- **Chain ID**: 900520900520
- **Gas Price**: 0 (Zero gas fees!)
- **SDK**: [purechainlib](https://www.npmjs.com/package/purechainlib) v2.0.8

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        BioPassport System                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Issuer     │    │   Registry   │    │   Verifier   │       │
│  │   Service    │───▶│  (PureChain) │◀───│     CLI      │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                   │                │
│         ▼                   │                   ▼                │
│  ┌──────────────┐           │           ┌──────────────┐        │
│  │  Off-chain   │           │           │ Verification │        │
│  │   Storage    │◀──────────┴──────────▶│    Report    │        │
│  │ (S3/MinIO)   │                       │  PASS/FAIL   │        │
│  └──────────────┘                       └──────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
BioPassport/
├── contracts/           # Solidity smart contracts (EVM)
├── issuer-service/      # Credential issuance API
├── verifier-cli/        # Verification CLI tool
├── schemas/             # JSON schemas for credentials
├── experiments/         # Benchmarking & security tests
├── docker-compose.yml   # Deployment configuration
└── README.md
```

## Data Model

### Material (on-chain)
```json
{
  "materialId": "bio:cell_line:<uuid>",
  "materialType": "CELL_LINE",
  "metadataHash": "sha256(...)",
  "ownerOrg": "LabA",
  "status": "ACTIVE",
  "createdAt": "2026-01-06T..."
}
```

### Credential (on-chain)
```json
{
  "materialId": "bio:cell_line:<uuid>",
  "credentialId": "cred:<uuid>",
  "credentialType": "QC_MYCO",
  "commitmentHash": "sha256(canonical_credential_json)",
  "issuerId": "OrgQC",
  "issuedAt": "...",
  "validUntil": "...",
  "artifactRefs": [{"cid": "ipfs://...", "hash": "sha256(file_bytes)"}],
  "signatureRef": "sig:base64(...)"
}
```

### Transfer Event (on-chain)
```json
{
  "materialId": "bio:cell_line:<uuid>",
  "from": "LabA",
  "to": "LabB",
  "shipmentHash": "sha256(shipment_form.pdf)",
  "timestamp": "..."
}
```

## Credential Types

| Type | Description |
|------|-------------|
| `IDENTITY` | Cell line STR profile or plasmid sequence fingerprint |
| `QC_MYCO` | Mycoplasma test result |
| `TRANSFER` | Chain-of-custody event |
| `USAGE_RIGHTS` | MTA restrictions and expiration |

## Policy Rules

A material is **VALID** only if:
- Has an `IDENTITY` credential
- Has a `QC_MYCO` credential not past `validUntil`
- Status is not `QUARANTINED` or `REVOKED`
- Transfer chain is continuous (no missing links)

## Quick Start

### 1. Install Dependencies
```bash
cd issuer-service && npm install
cd ../verifier-cli && npm install
```

### 2. Deploy Contract & Register Material
```javascript
const { createPureChainClient } = require('./issuer-service/src/purechain-client');

// Initialize client (connects to PureChain testnet)
const client = createPureChainClient({
  network: 'testnet',
  privateKey: 'your_private_key_here' // or omit to generate new account
});

await client.connect();

// Deploy BioPassport Registry contract (one-time)
const contractAddress = await client.deployContract();
console.log('Contract deployed at:', contractAddress);

// Register a material
const result = await client.registerMaterial('CELL_LINE', 'sha256_of_metadata');
console.log('Material ID:', result.result.materialId);
```

### 3. Issue a Credential
```javascript
// Issue mycoplasma QC credential
const credResult = await client.issueCredential(
  'bio:cell_line:<uuid>',      // materialId
  'QC_MYCO',                    // credentialType
  'sha256_of_credential_json', // commitmentHash
  Math.floor(Date.now()/1000) + 90*24*60*60, // validUntil (90 days)
  JSON.stringify([{cid: 's3://bucket/report.pdf', hash: 'sha256...'}]),
  'signature_base64'
);
console.log('Credential ID:', credResult.result.credentialId);
```

### 4. Verify a Material
```bash
cd verifier-cli
biopassport verify --material bio:cell_line:<uuid>
```

### 5. (Optional) Start Off-chain Storage
```bash
docker-compose up -d minio
```

## API Reference

### Registry Contract Functions

| Function | Description |
|----------|-------------|
| `RegisterMaterial(materialType, metadataHash)` | Register new biomaterial |
| `IssueCredential(materialId, credentialType, commitmentHash, validUntil, artifactRefs, issuerSig)` | Issue credential |
| `TransferMaterial(materialId, toOrg, shipmentHash)` | Transfer ownership |
| `SetStatus(materialId, status, reasonHash)` | Set QUARANTINE/REVOKE |
| `VerifyMaterial(materialId, atTime)` | Verify material validity |
| `GetHistory(materialId)` | Get audit trail |

## Reproducibility (IEEE ICBC)

### One-Command Reproduction

```bash
cd experiments
npm install
npm run reproduce
```

This generates:
- `data/normal/` - Normal operations dataset (~75-80% PASS)
- `data/drift/` - Compliance drift dataset (~50-55% PASS)
- `data/adversarial/` - Attack scenarios dataset (~60-70% FAIL)
- `results/benchmark-report.json` - Full benchmark results
- `results/tables.tex` - LaTeX tables for paper
- `results/scaling.csv` - Scaling data for plots

### Fixed Seed Reproduction

```bash
npm run reproduce -- --seed 42
```

### Full Benchmark Suite

```bash
npm run reproduce:full  # 10,000 fuzz iterations, extended concurrency tests
```

## Experiments

### Performance Benchmarks

| Operation | p50 (ms) | p95 (ms) | p99 (ms) |
|-----------|----------|----------|----------|
| Register Material | ~45 | ~65 | ~90 |
| Issue Credential | ~38 | ~55 | ~75 |
| Verify (on-chain) | ~8 | ~12 | ~18 |
| Verify (full) | ~25 | ~40 | ~55 |

### Confusion Matrix (Anomaly Detection)

| Anomaly Type | On-chain TPR | Full TPR |
|--------------|--------------|----------|
| QC Expired | 100% | 100% |
| QC Missing | 100% | 100% |
| Material Revoked | 100% | 100% |
| Transfer Pending | 100% | 100% |
| Artifact Tampered | 0% | 100% |

### Ablation Studies

| Feature Disabled | False Accept Increase |
|------------------|----------------------|
| Latest-QC-only policy | +15-20% |
| Issuer revocation timestamp | +5% |
| Authority-only status control | +8-12% |
| Artifact integrity check | +20-30% |

## Contract Verification

### Static Analysis (Slither)

```bash
cd contracts
slither src/BioPassportRegistry.sol --config slither.config.json
```

### Property-Based Fuzzing (Foundry)

```bash
cd contracts
forge test --fuzz-runs 10000
```

### Invariants

See [`contracts/INVARIANTS.md`](contracts/INVARIANTS.md) for formal specification of:
- INV-1: Credential Issuance Authorization
- INV-2: Issuer Revocation Semantics
- INV-3: Status Authority Control
- INV-4: Transfer Chain Continuity
- INV-5: Latest QC Credential Policy
- INV-6: Material Type Validation
- INV-7: Commitment Hash Integrity
- INV-8: History Immutability

## Baselines

| Approach | p50 (ms) | Ops/sec | Security |
|----------|----------|---------|----------|
| Centralized DB + Audit Log | 5 | 2500 | 45% |
| On-chain Only | 8 | 850 | 75% |
| **BioPassport Full** | 25 | 420 | **95%** |

## License

MIT
