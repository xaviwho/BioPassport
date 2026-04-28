# Methodology

## 1. System Architecture Overview

BioPassport employs a hybrid on-chain/off-chain architecture to establish tamper-evident provenance records for biological materials such as cell lines and plasmids. The system is composed of five principal components: (i) two Solidity smart contracts deployed to PureChain, a permissioned Ethereum Virtual Machine (EVM)-compatible blockchain; (ii) an issuer service responsible for credential construction, cryptographic signing, and on-chain anchoring; (iii) a verifier client that performs multi-layered material compliance checks against on-chain state; (iv) an event-driven indexer that populates a relational database from blockchain event logs; and (v) a REST API that exposes acquirer-facing endpoints for registration, issuance, verification, exception management, and audit pack generation. Off-chain artifacts—including evidence files, credential JSON documents, and audit reports—are persisted in S3-compatible object storage (MinIO), with only their cryptographic commitments stored on-chain. This separation ensures that the blockchain layer remains lightweight and cost-efficient while still providing the cryptographic guarantees necessary for provenance verification.

## 2. Blockchain Layer

### 2.1 Network Selection

PureChain is the sole blockchain platform used in this work. We deployed all smart contracts and conducted all experiments exclusively on PureChain (chain ID 900520900520), a private, permissioned EVM-compatible blockchain operating with zero transaction fees (gasPrice = 0). No other blockchain network (public or private) was used at any stage of the implementation or evaluation. PureChain was selected for three reasons: (a) zero gas costs eliminate economic barriers to high-frequency credential issuance in laboratory workflows; (b) permissioned consensus (configured as Raft in the deployment topology) provides deterministic finality without the latency variance of proof-of-work or proof-of-stake mechanisms; and (c) EVM compatibility enables the use of mature Solidity tooling (OpenZeppelin, Hardhat, ethers.js) without vendor lock-in. The network is accessed via an HTTPS JSON-RPC endpoint (`https://purechainnode.com:8547`). All service components connect with `staticNetwork: true` to avoid extraneous `eth_chainId` calls that can fail under transient network conditions.

### 2.2 Smart Contract Design

Two complementary smart contracts were developed, each serving a distinct role in the system:

**BioPassportRegistry** (811 lines, Solidity ^0.8.20, deployed bytecode 22,841 bytes) implements the full credential lifecycle for the issuer and verifier subsystems. It inherits from OpenZeppelin v5's `ReentrancyGuard`, `AccessControl`, and `Pausable` contracts. The registry enforces role-based access control (RBAC) through four roles—`ADMIN_ROLE`, `REGISTRAR_ROLE`, `AUDITOR_ROLE`, and `ISSUER_MANAGER_ROLE`—and maintains fine-grained issuer permissions that specify which credential types (IDENTITY, QC_MYCO, USAGE_RIGHTS) each issuer address may issue. Materials are restricted to two validated types (`CELL_LINE`, `PLASMID`) enforced via keccak256 comparison of the type string. The contract stores structured `Material`, `Credential`, and `Transfer` records on-chain, including commitment hashes, artifact hashes, validity periods, and a per-material history log of keccak256-encoded audit events. Status transitions are bifurcated: material owners may self-quarantine but cannot revoke, while administrators and authorized QC issuers may set any status, with each transition emitting a distinct event (`StatusChangedByOwner` vs. `StatusChangedByAuthority`). The on-chain `verifyMaterial` function implements a composite policy check that evaluates material status, the presence of an unexpired IDENTITY credential from a non-revoked issuer, the validity of the *latest* (not any) QC_MYCO credential, and transfer chain continuity. The contract was designed to remain within the EIP-170 contract size limit (24,576 bytes); individual operations (register, issue, verify, transfer) are exposed as separate functions rather than batched to minimize bytecode footprint.

**BioPassportV2** (382 lines, Solidity ^0.8.20) implements an event-driven audit trail design for the services tier (API, indexer, audit pack generator). It stores minimal on-chain state—only `AssetRecord`, `CredentialRecord`, and `ExceptionRecord` structs keyed by `bytes32` hashes—and relies on rich indexed events (`AssetRegistered`, `CredentialIssued`, `ExceptionOpened`, `ExceptionClosed`) as the primary source of audit data. Credential chain integrity is enforced at issuance time: the `issueCredential` function requires that the caller-supplied `prevHash` matches the asset's `latestCredentialHash`, creating a linked list of credentials whose linkage can be verified on-chain via `verifyChainLinkage`. Exception records support a structured lifecycle (open/close) with off-chain detail and resolution pointers, enabling compliance workflows that span multiple organizations.

Both contracts were compiled with Solidity 0.8.20 and the optimizer set to 50 runs to minimize deployed bytecode size. Custom errors (e.g., `MaterialNotFound()`, `InvalidCommitmentHash()`) are used throughout for gas efficiency over string-based `require` messages.

## 3. Cryptographic Primitives

### 3.1 Commitment Hashing

Credential payloads are canonicalized prior to hashing using RFC 8785 JSON Canonicalization Scheme (JCS) to ensure deterministic byte representation regardless of key ordering or whitespace. The issuer service computes commitment hashes as `SHA-256(canonicalize(payload))`, while the services tier uses `keccak256(UTF-8(canonicalize(payload)))` for Ethereum-native compatibility. This dual-hash approach accommodates both off-chain verification (where SHA-256 is standard) and on-chain verification (where keccak256 is natively supported by the EVM).

### 3.2 Evidence Root Computation

Each credential may reference zero or more evidence files (e.g., QC reports, sequencing data, certificates of analysis). The evidence root is computed as `keccak256(concat(sort(lowercase(sha256_1), lowercase(sha256_2), ...)))`: individual file SHA-256 hashes are normalized to lowercase hexadecimal, lexicographically sorted, concatenated, and then hashed with keccak256. This construction provides a compact 32-byte commitment to an arbitrary number of evidence files while enabling efficient membership proofs.

### 3.3 Digital Signatures

The issuer service signs credentials using ECDSA over the secp256k1 curve. The signing process operates on the SHA-256 hash of the canonicalized credential payload, producing a DER-encoded signature. Private keys are loaded from PEM files with an entropy validation check: the Shannon entropy of the key's hexadecimal representation must exceed 4.0 bits to prevent weak or predictable keys from entering the system. A deprecated `keyFromSeed` function—which deterministically derives keys from organization names—is blocked in production (`NODE_ENV=production`) as a defense-in-depth measure.

### 3.4 Asset Identification

Asset IDs follow a hierarchical naming convention (`bio:cell_line:<n>` or `bio:plasmid:<n>`) and are mapped to `bytes32` on-chain identifiers via `keccak256(UTF-8(assetId))`. This hashing preserves privacy of the plaintext identifier while enabling efficient on-chain lookups via mapping keys.

## 4. Off-Chain Storage

Artifacts, credential JSON documents, and evidence files are stored in S3-compatible object storage (MinIO) organized by material ID and credential type (`{materialId}/{credentialType}/{hash_prefix}-{filename}`). Each uploaded artifact is tagged with its SHA-256 hash in object metadata (`x-amz-meta-hash`), enabling integrity verification without downloading the full object. The storage layer supports content-addressed retrieval via `s3://` URI pointers stored on-chain, as well as pre-signed URL generation for time-limited external access. Artifact integrity verification is implemented as a download-and-hash comparison: the object is streamed, SHA-256 is computed over the received bytes, and the result is compared against the expected hash stored on-chain. This end-to-end verification detects both storage corruption and unauthorized modification.

## 5. Credential Issuance Pipeline

The credential issuance pipeline proceeds through seven stages:

1. **Payload Construction**: The issuer service assembles a credential payload containing the material ID, credential type, issuer organization ID, issuance timestamp, validity period, and domain-specific fields (e.g., test method, laboratory, result for QC_MYCO credentials; permissions and restrictions for USAGE_RIGHTS credentials).

2. **Artifact Upload**: Supporting evidence files are uploaded to MinIO. For each file, the SHA-256 hash, content-addressed URI, filename, content type, and byte size are recorded as artifact references.

3. **Commitment Hash Computation**: The complete payload (including artifact references) is canonicalized and hashed to produce a 32-byte commitment.

4. **Credential Signing**: The canonicalized payload is signed with the issuer's secp256k1 private key, producing a DER-encoded ECDSA signature.

5. **On-Chain Anchoring**: The commitment hash, artifact hash, validity period, and issuer signature are submitted to the BioPassportRegistry contract via `issueCredential`. The contract validates that: the commitment hash is non-zero, the artifact hash is non-zero, the validity timestamp is in the future, the caller is an approved issuer, the issuer has permission for the specified credential type, and the issuer has not been revoked.

6. **Event Emission**: The contract emits a `CredentialIssued` event with the credential ID, material ID, credential type, issuer address, and validity period.

7. **Transaction Confirmation**: The issuer service awaits transaction confirmation and returns the credential ID, commitment hash, artifact references, and transaction hash.

## 6. Verification Protocol

The verifier client performs a multi-layered verification against both on-chain state and off-chain artifacts:

1. **Material Existence**: The verifier queries `getMaterial(materialId)` on the BioPassportRegistry contract. If the material is not found, verification fails immediately.

2. **Status Check**: The material's `MaterialStatus` enum (ACTIVE, QUARANTINED, REVOKED) is evaluated. Any non-ACTIVE status is flagged.

3. **Credential Policy Evaluation**: For each required credential type (determined by material type), the verifier retrieves all credentials via `getCredentials(materialId)`, filters to the most recent non-revoked credential with a valid expiry, and checks:
   - Whether the credential exists at all (MISSING check)
   - Whether it has expired at the verification time (EXPIRED check)
   - Whether the issuing address has been revoked prior to issuance (ISSUER_REVOKED check)

4. **Issuer Trust Validation**: The verifier maintains a local issuer registry that maps issuer addresses to organization metadata and trust levels. Credentials from unrecognized or untrusted issuers are flagged.

5. **Signature Verification** (optional): If enabled, the verifier downloads the credential JSON from off-chain storage, canonicalizes the payload, and verifies the ECDSA signature against the issuer's public key.

6. **Artifact Integrity Verification** (optional): If enabled, each artifact referenced by the credential is downloaded from MinIO and its SHA-256 hash is recomputed and compared against the on-chain artifact hash. This is performed in parallel across all artifacts for a given credential to minimize verification latency.

7. **Transfer Chain Continuity**: The verifier checks for pending (unaccepted) transfers, which indicate the material is in transit and its chain of custody is incomplete.

8. **Composite Scoring**: Results from all checks are aggregated into an overall pass/fail determination with per-check severity levels (ERROR, WARNING, INFO) and a numeric overall score.

Verification results are cached with a 5-minute TTL for materials and credentials to reduce redundant RPC calls during batch verification. The `batchVerify` method parallelizes verification across multiple materials using `Promise.all`.

## 7. Event Indexing and Audit Trail

The indexer service maintains a real-time mirror of on-chain events in a PostgreSQL database. It operates in a polling loop with configurable interval (default 2 seconds), querying the PureChain node for events in 1000-block ranges using `queryFilter`. Four event types are processed:

- **AssetRegistered**: Inserts a row into the `assets` table with the asset ID hash, metadata pointer, registrar address, and block metadata.
- **CredentialIssued**: Inserts into `credentials` and triggers an enrichment step that fetches the credential JSON from its off-chain pointer (S3 or HTTPS) to populate denormalized fields (credential type, issuer organization, subject metadata, evidence count). Individual evidence file records are extracted and inserted into the `evidence_files` table.
- **ExceptionOpened/ExceptionClosed**: Maintains exception lifecycle state with reason codes mapped to human-readable enums (HASH_MISMATCH, EVIDENCE_MISSING, CHAIN_BREAK, EXPIRED_CREDENTIAL, REVOKED_ISSUER, TAMPERED_EVIDENCE).

Database triggers automatically maintain denormalized counters (credential count, open exception flag) on the `assets` table. The `sync_state` table tracks the last processed block to enable crash recovery without reprocessing the full event history.

## 8. Audit Pack Generation

The audit pack generator produces a self-contained, machine-readable JSON document and a human-readable PDF report for a given asset. The JSON audit pack (schema version 2.0) includes:

- Asset metadata (ID, hash, registrar, creation timestamp)
- The complete credential chain, ordered by issuance time, with per-credential evidence file listings
- Evidence summary (total files, verified count, failed count)
- Automated verification results with three checks: chain integrity (prevHash linkage), evidence completeness, and exception status
- Full exception history with open/closed lifecycle
- Blockchain proof section (contract address, network ID, block range, all relevant transaction hashes)

The overall verification status is computed as PASS (all checks pass), PARTIAL (some checks pass), or FAIL (no checks pass). The PDF report is generated using PDFKit with structured sections for asset summary, credential chain, verification results, exception history, and blockchain proof.

## 9. API Surface

The REST API (Express.js) exposes twelve endpoints organized around four resource types:

| Endpoint | Method | Description |
|---|---|---|
| `/assets` | POST | Register a new asset on-chain |
| `/assets/:assetId` | GET | Retrieve asset with credentials and exceptions |
| `/assets/:assetId/credentials` | GET | Retrieve credential chain |
| `/credentials` | POST | Issue a new credential |
| `/credentials/:hash` | GET | Retrieve credential by hash |
| `/verify` | POST | Verify credential chain linkage and evidence root |
| `/exceptions` | POST | Open a compliance exception |
| `/exceptions/:id/close` | POST | Close an exception with resolution |
| `/exceptions` | GET | List open exceptions |
| `/audit-pack/:assetId` | GET | Generate audit pack (JSON or PDF) |
| `/webhooks` | POST | Register event notification webhook |
| `/webhooks/:id` | DELETE | Deactivate a webhook |

Input validation is enforced at the API boundary using Zod schemas. All write operations submit transactions to PureChain with `gasPrice: 0`. The verification endpoint performs on-chain chain linkage verification via `verifyChainLinkage` and recomputes evidence roots from the database to detect tampering.

## 10. Deployment Infrastructure

Smart contracts were deployed directly to the live PureChain network using Hardhat deployment scripts (`deploy-all.ts`, `deploy-registry.ts`) that connect to the PureChain JSON-RPC endpoint. The deployer account (`0xAA3DFc054293Dd3731892A1Ba0366D6e6FB1Ee51`) was used to deploy both contracts, with the resulting addresses recorded in `deployment.json` (BioPassportRegistry at `0x8fC7e91A24A8CfAefc3DCB5E04d9c81f5F825b34`, BioPassportV2 at `0x01877E8f9b87528787a3fcEE90915E80981F463B`). All deployment transactions were submitted with `gasPrice: 0` and `gasLimit: 30000000` to accommodate PureChain's zero-fee model and the large contract bytecode. A Docker Compose configuration is provided for local development and integration testing, comprising PostgreSQL 15 (relational store), MinIO (S3-compatible object storage with buckets for `biopassport`, `credentials`, `evidence`, and `audit-packs`), two PureChain nodes with Raft consensus, a PureChain orderer, and the application services (indexer + API). For the evaluation presented in this paper, all experiments were conducted against the live PureChain network node, not the containerized environment.

## 11. Security Considerations

Several security measures are implemented across the stack:

- **Role-Based Access Control**: Four on-chain roles restrict who may register materials, manage issuers, issue credentials, and audit materials.
- **Issuer Revocation with Temporal Tracking**: Revoking an issuer records a timestamp; the verification function retroactively invalidates only credentials issued *after* the revocation, preserving the validity of credentials issued while the issuer was authorized.
- **ReentrancyGuard**: All state-changing contract functions are protected against reentrancy attacks.
- **Emergency Pause**: The admin can halt all state-changing operations via the `Pausable` pattern.
- **Input Validation**: Zero-hash checks, material type validation, and validity period enforcement prevent malformed data from entering the on-chain state.
- **Key Entropy Validation**: Private keys loaded from PEM files are checked for minimum Shannon entropy to reject weak or predictable keys.
- **No Predictable Key Derivation in Production**: The `keyFromSeed` function throws in `NODE_ENV=production` to prevent deterministic key generation from entering production environments.
- **Custom Errors**: Gas-efficient custom errors replace string-based `require` messages, reducing attack surface for gas-related denial-of-service.

## 12. Experimental Evaluation

All performance measurements were obtained from live transactions on the PureChain network. No simulated or mock data was used for the results reported in this paper.

### 12.1 Benchmark Design

The benchmark suite (`benchmark-suite.ts`) executes six evaluation modules against the deployed BioPassportRegistry contract:

1. **Latency Distribution**: Measures end-to-end time-to-finality for seven operation types (registerMaterial, issueIdentity, issueQC, initiateTransfer, acceptTransfer, verifyMaterial on-chain, verifyMaterial full) across 20 iterations. Each iteration registers a new material, issues IDENTITY and QC_MYCO credentials, and performs verification. Write latency is measured from transaction submission to receipt confirmation; read latency is measured as RPC round-trip time. Transfer operations are sampled every 10th iteration.

2. **Throughput vs. Concurrency**: A pool of 10 materials with IDENTITY and QC_MYCO credentials is pre-seeded on-chain. Mixed workloads (70% reads, 30% writes) are executed at concurrency levels of 1, 5, 10, and 20 logical clients. Because PureChain uses a single-signer model, all transactions are serialized with a manual nonce-tracking lock to prevent nonce collisions; the throughput measurement thus reflects the sequential transaction processing rate of the network.

3. **Confusion Matrices**: The verification system's detection accuracy is evaluated against the ground-truth dataset (`experiments/data/`) containing 500 materials with known anomaly labels (QC_EXPIRED, QC_MISSING, MATERIAL_REVOKED, MATERIAL_QUARANTINED, TRANSFER_PENDING, ARTIFACT_TAMPERED). The system's predictions are compared against ground truth to compute true/false positive/negative rates, precision, recall, and F1 scores for each anomaly type.

4. **Baseline Comparisons**: BioPassport's performance is compared against theoretical baselines for alternative approaches: a centralized database system, a public Ethereum deployment, and a Hyperledger Fabric deployment. Baseline estimates are derived from published literature rather than measured implementations.

5. **Ablation Studies**: Two features are independently disabled to measure their security contribution: (a) the latest-QC-only policy (which requires the most recent QC credential to be valid, rather than any QC credential) and (b) the artifact integrity check (which verifies off-chain evidence hashes against on-chain commitments). The false-accept rate increase is measured against the ground-truth dataset.

6. **Scaling Test**: Materials are incrementally registered on-chain at counts of 10, 25, 50, 75, and 100, with IDENTITY and QC_MYCO credentials issued for each. At each scale point, verify and getHistory latencies are measured to confirm O(1) lookup behavior via Solidity mappings.

### 12.2 Reproducibility

Each benchmark run records a reproducibility metadata block containing the git commit hash, Node.js version, platform, benchmark mode (live), PureChain chain ID, and a SHA-256 checksum of the input dataset. The benchmark outputs three artifacts: a JSON report (`benchmark-report.json`), LaTeX tables (`tables.tex`), and a scaling CSV (`scaling.csv`). Publication-quality figures are generated from these artifacts using a Python script (`generate-plots.py`) with matplotlib.
