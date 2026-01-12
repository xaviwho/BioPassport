# BioPassport Benchmark Methodology

## Comprehensive Evaluation Framework for Blockchain-Based Biological Material Provenance

---

## 1. Overview

This document describes the methodology used to evaluate BioPassport, a blockchain-based provenance and compliance verification system for biological materials. The evaluation encompasses performance benchmarking, security validation through confusion matrix analysis, ablation studies, and comparative baseline assessment.

### 1.1 Evaluation Objectives

1. **Performance Characterization**: Measure latency and throughput under realistic workloads
2. **Scalability Verification**: Confirm O(1) verification complexity as chain state grows
3. **Security Validation**: Quantify detection accuracy for compliance anomalies
4. **Ablation Analysis**: Isolate the contribution of individual security features
5. **Comparative Assessment**: Position against alternative architectural approaches

---

## 2. Experimental Setup

### 2.1 Blockchain Environment

| Parameter | Value |
|-----------|-------|
| **Platform** | Hardhat Local Network (EVM-compatible) |
| **Chain ID** | 31337 |
| **Consensus** | Instant mining (single-node) |
| **Gas Model** | Zero gas price (eliminating cost variance) |
| **Block Time** | Instant (no mining delay) |

**Rationale**: Using a local Hardhat node isolates smart contract performance from network latency, consensus delays, and gas price volatility. This provides reproducible measurements of the contract's intrinsic computational overhead.

### 2.2 Smart Contract Configuration

- **Contract**: `BioPassportRegistry.sol`
- **Deployment**: Fresh deployment per benchmark run
- **Compiler**: Solidity 0.8.x with optimization enabled
- **Storage Model**: Mapping-based O(1) lookups for materials, credentials, and transfers

### 2.3 Hardware Specifications

Benchmarks should report:
- CPU model and core count
- RAM capacity
- Storage type (SSD/NVMe)
- Operating system version

### 2.4 Software Stack

| Component | Technology |
|-----------|------------|
| Smart Contracts | Solidity 0.8.x |
| Blockchain Client | ethers.js v6 |
| Benchmark Suite | TypeScript (ts-node) |
| Data Generation | Custom synthetic generator |
| Plotting | Python 3.x + matplotlib |

---

## 3. Dataset Generation

### 3.1 Synthetic Data Model

The benchmark uses synthetic datasets that mirror real-world biological material workflows:

```
Material Hierarchy:
└── Material (CELL_LINE | PLASMID)
    ├── Metadata (strain, source, biosafety level)
    ├── Credentials[]
    │   ├── IDENTITY (provenance attestation)
    │   ├── QC_MYCO (mycoplasma testing certification)
    │   └── USAGE_RIGHTS (licensing/IP attestation)
    └── Transfers[]
        └── (fromOrg, toOrg, shipmentHash, accepted)
```

### 3.2 Dataset Presets

Three dataset configurations target different evaluation scenarios:

| Preset | Materials | Pass Rate | Purpose |
|--------|-----------|-----------|---------|
| **Normal** | 500 | ~75-80% | Performance benchmarking |
| **Drift** | 500 | ~50-55% | QC expiry detection |
| **Adversarial** | 500 | ~30-40% | Security stress testing |

### 3.3 Anomaly Injection

The adversarial dataset includes controlled anomaly injection:

| Anomaly Type | Rate | Description |
|--------------|------|-------------|
| Expired QC | 35% | Latest QC credential past validity window |
| Tampered Artifact | 35% | Artifact hash mismatch (simulated) |
| QC Replay Attack | 15% | Older valid QC + newer expired QC |
| Missing QC | 10% | No QC credential issued |
| Revoked Material | 7% | Material status set to REVOKED |
| Quarantined Material | 5% | Material status set to QUARANTINED |
| Pending Transfer | 10% | Unaccepted custody transfer |

### 3.4 QC Replay Attack Scenario

A novel attack scenario tests the "Latest-QC-only" policy:

```
Timeline:
  T-60 days: QC_v1 issued (validity: 180 days) → VALID today
  T-20 days: QC_v2 issued (validity: 15 days)  → EXPIRED today

Attack: Attacker presents QC_v1 (still valid) instead of QC_v2 (expired)
Defense: BioPassport's Latest-QC-only policy rejects based on QC_v2
```

### 3.5 Ground Truth Labeling

Each material is labeled with ground truth anomalies computed from its actual state:

```typescript
anomalies = [];
if (status === 'REVOKED') anomalies.push('REVOKED');
if (status === 'QUARANTINED') anomalies.push('QUARANTINED');
if (!hasQC) anomalies.push('MISSING_QC');
if (latestQCExpired) anomalies.push('EXPIRED_QC');
if (hasValidOlderQC && latestQCExpired) anomalies.push('QC_REPLAY');
if (artifactTampered) anomalies.push('TAMPERED_ARTIFACT');
if (pendingTransfer) anomalies.push('PENDING_TRANSFER');
```

---

## 4. Performance Benchmarking

### 4.1 Latency Measurement

**Measurement Boundary**: End-to-end time from method invocation to transaction confirmation.

```
Latency = T_confirmation - T_invocation

Where:
  T_invocation  = performance.now() before contract call
  T_confirmation = performance.now() after tx.wait() returns
```

**Operations Measured**:
| Operation | Description |
|-----------|-------------|
| `registerMaterial` | Create new material on-chain |
| `issueCredential` | Attach credential to material |
| `initiateTransfer` | Begin custody transfer |
| `acceptTransfer` | Complete custody transfer |
| `verifyMaterial` | On-chain compliance check |
| `verifyMaterialFull` | On-chain + artifact integrity |

**Statistical Metrics**:
- **p50** (median): Typical user experience
- **p95**: Tail latency for SLA planning
- **p99**: Worst-case latency
- **Mean ± StdDev**: Distribution characterization

### 4.2 Throughput Measurement

**Definition**: Operations completed per second under sustained load.

**Protocol**:
1. Pre-register N materials on-chain
2. Execute verification operations for fixed duration (60s)
3. Count successful completions
4. Compute: `throughput = completions / duration`

**Concurrency Levels**: 1, 5, 20, 50 concurrent clients

**Operation Mix**: Pure verification workload (read-only operations)

### 4.3 Scalability Testing

**Objective**: Verify O(1) verification complexity.

**Protocol**:
1. Deploy fresh contract
2. For each scale point [100, 250, 500, 1000, 2000]:
   - Register N materials with full credential sets
   - Measure verification latency (10 samples)
   - Record mean latency

**Expected Result**: Latency remains constant regardless of chain size due to mapping-based O(1) lookups.

---

## 5. Security Validation

### 5.1 Confusion Matrix Methodology

For each anomaly type, compute detection accuracy by comparing system predictions against ground truth labels.

**Verification Modes**:
- **On-Chain**: Smart contract verification only
- **Full**: On-chain + off-chain artifact integrity check

**Matrix Construction**:
```
For each material M and anomaly type A:
  ground_truth = A ∈ M.anomalies
  prediction   = A ∈ verifier_output.reasons

  if ground_truth AND prediction:     TP++
  if ground_truth AND NOT prediction: FN++
  if NOT ground_truth AND prediction: FP++
  if NOT ground_truth AND NOT prediction: TN++
```

**Metrics Computed**:
| Metric | Formula | Interpretation |
|--------|---------|----------------|
| TPR (Recall) | TP / (TP + FN) | Detection rate |
| TNR (Specificity) | TN / (TN + FP) | False alarm avoidance |
| Precision | TP / (TP + FP) | Prediction confidence |
| F1 Score | 2·(Prec·Recall)/(Prec+Recall) | Balanced accuracy |

### 5.2 Live Confusion Matrix Protocol

**Critical**: Confusion matrices are computed using **live blockchain transactions**, not simulated predictions.

**Protocol**:
1. Deploy contract to Hardhat node
2. For each material in adversarial dataset:
   a. Register material on-chain
   b. Issue all credentials on-chain
   c. Execute transfers on-chain
   d. Set material status on-chain
   e. Call `verifyMaterial()` on-chain
   f. Compare returned reasons to ground truth
3. Aggregate into confusion matrices

**Artifact Tampering Simulation**:
Since physical artifact files are not available in reproducibility scenarios, tampering detection uses dataset labels:
```typescript
if (!artifactFileExists && artifactRef.tampered) {
  return { valid: false, reason: 'ARTIFACT_TAMPERED' };
}
```
*Note: Paper should disclose this simulation approach.*

---

## 6. Ablation Studies

### 6.1 Methodology

Ablation studies isolate the security contribution of individual features by measuring the increase in false accepts when each feature is disabled.

**Baseline**: Full BioPassport verification (all features enabled)

**Ablation Protocol**:
1. Compute baseline pass rate on adversarial dataset
2. For each security feature:
   a. Disable feature in verification logic
   b. Re-evaluate all materials
   c. Compute ablated pass rate
   d. Calculate: `Δ = ablated_rate - baseline_rate`
3. Count materials that would be falsely accepted

### 6.2 Ablated Features

| Feature | Ablation Effect |
|---------|-----------------|
| **Latest-QC-only** | Accept any valid QC, not just latest |
| **Artifact Integrity** | Skip off-chain hash verification |

### 6.3 Interpretation

- **Δ > 0**: Feature prevents false accepts
- **Vulnerable Count**: Materials that would pass without the feature but fail with it

---

## 7. Baseline Comparisons

### 7.1 Comparative Architectures

| Baseline | Description |
|----------|-------------|
| **Centralized DB + Audit Log** | PostgreSQL with append-only signed audit trail |
| **On-Chain Only** | Smart contract verification without artifact integrity |
| **BioPassport Full** | Complete system (on-chain + artifact integrity) |

### 7.2 Metrics

| Metric | Description |
|--------|-------------|
| **p50 Latency** | Median verification latency |
| **Throughput** | Operations per second |
| **Security Score** | Qualitative security rating (0-100) |
| **Integrity Guarantee** | Description of tamper-evidence properties |

### 7.3 Theoretical Baseline Estimation

For baselines without implementations (Centralized DB), latency is estimated:
```
Centralized_latency = BioPassport_latency × 0.2  // DB faster than blockchain
Centralized_throughput = 2500 ops/sec           // Typical PostgreSQL
```
*Note: Mark theoretical baselines in results.*

---

## 8. Statistical Rigor

### 8.1 Sample Sizes

| Measurement | Samples | Justification |
|-------------|---------|---------------|
| Latency per operation | 500 | Central limit theorem convergence |
| Throughput per concurrency | 60s duration | Steady-state measurement |
| Scaling per size | 10 | Variance estimation |
| Confusion matrix | 500 materials | Statistical significance |

### 8.2 Variance Control

- **Transaction Serialization**: Async mutex prevents nonce conflicts
- **Fresh State**: Contract redeployed per benchmark run
- **Warm-up**: Initial transactions excluded from measurement
- **Isolation**: Single-node execution eliminates network variance

### 8.3 Reproducibility

All benchmark artifacts are deterministically generated:
```
experiments/
├── generate-dataset.ts    # Synthetic data generator
├── benchmark-suite.ts     # Main benchmark harness
├── generate-plots.py      # Visualization generator
├── data/                  # Generated datasets
│   ├── normal/
│   ├── drift/
│   └── adversarial/
└── results/
    ├── benchmark-report.json  # Raw results
    ├── tables.tex             # LaTeX tables
    ├── scaling.csv            # Scaling data
    └── figures/               # PDF/PNG plots
```

---

## 9. Limitations and Threats to Validity

### 9.1 Internal Validity

| Threat | Mitigation |
|--------|------------|
| Nonce conflicts | Async mutex with manual tracking |
| State pollution | Fresh contract per run |
| Measurement noise | High sample counts, percentile reporting |

### 9.2 External Validity

| Threat | Mitigation |
|--------|------------|
| Local node ≠ production | Document as ideal-case baseline |
| Synthetic data ≠ real | Model based on domain expert input |
| Single implementation | Open-source for independent verification |

### 9.3 Construct Validity

| Threat | Mitigation |
|--------|------------|
| Artifact simulation | Clearly disclose in paper |
| Theoretical baselines | Mark with asterisk (*) |
| Security score subjectivity | Provide criteria definition |

---

## 10. Outputs and Deliverables

### 10.1 Data Artifacts

| File | Description |
|------|-------------|
| `benchmark-report.json` | Complete raw results (JSON) |
| `tables.tex` | LaTeX tables for direct inclusion |
| `scaling.csv` | CSV for custom analysis |

### 10.2 Figures

| Figure | Content |
|--------|---------|
| `confusion_f1_scores.pdf` | Detection accuracy by anomaly |
| `scaling_o1.pdf` | O(1) verification proof |
| `latency_distribution.pdf` | Operation latency profiles |
| `baseline_comparison.pdf` | Comparative positioning |
| `ablation_study.pdf` | Feature contribution analysis |
| `throughput.pdf` | Concurrency scaling |

### 10.3 Reproducibility Package

```bash
# Prerequisites
npm install -g ts-node typescript
pip install matplotlib numpy

# Generate datasets
cd experiments
npx ts-node --transpile-only generate-dataset.ts adversarial

# Run benchmark (requires Hardhat node on localhost:8545)
npx ts-node --transpile-only benchmark-suite.ts --live --live-confusion

# Generate plots
python generate-plots.py
```

---

## 11. Summary

This methodology provides a rigorous, reproducible framework for evaluating blockchain-based provenance systems. Key contributions:

1. **Live Confusion Matrices**: Security claims validated against actual blockchain transactions
2. **QC Replay Attack Modeling**: Novel attack scenario with measurable defense efficacy
3. **Ablation Studies**: Quantified contribution of each security feature
4. **O(1) Scalability**: Empirical verification of constant-time lookups
5. **Reproducibility**: Complete artifact generation and benchmarking pipeline

The methodology balances scientific rigor with practical constraints, clearly disclosing simulation approaches and theoretical estimates where necessary.

---

*Document Version: 1.0*  
*Generated: January 2026*  
*Associated Paper: BioPassport - Blockchain-Based Provenance for Biological Materials*
