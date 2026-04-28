# Edge Attestation Implementation Summary

Date: 2026-04-23  
Branch: `feat/edge-attestation`

## What We Achieved

We added the BioPassport Instrument Edge Node (IEN) attestation layer for QC credential issuance. The implementation now supports enrolling instrument devices on-chain, signing QC measurements at capture time with a device-bound key, and verifying that device signature during credential issuance.

## Contract Layer

Updated `contracts/src/BioPassportRegistry.sol` with:

- `DEVICE_MANAGER_ROLE` for device enrollment and revocation.
- Device registry state via `Device`, `devices`, and `deviceExists`.
- Per-credential attestation metadata via `Attestation` and `credentialAttestations`.
- Device lifecycle events for enrollment and revocation.
- `attestationHash(...)`, matching the edge-node signing scheme.
- `_recoverAttestationSigner(...)` using EIP-191-compatible `ecrecover`.
- `issueCredentialWithAttestation(...)`, a parallel issuance path that preserves the existing `issueCredential(...)` API.
- Batch API compatibility restored for the existing full Hardhat suite.

The new attested issuance path enforces:

- Device must be enrolled.
- Device must not be revoked.
- Device signature must recover to the enrolled device address.
- `captureTs` must be non-zero and not in the future.
- `captureTs` must be strictly greater than the device's previous capture timestamp.
- Issuer must still be approved and authorized for the credential type.

## Contract Tests

Added:

- `contracts/test/EdgeAttestation.test.ts`
- `contracts/test/EdgeAttestation.t.sol`

The Hardhat test suite covers:

- Valid device-signed QC credential acceptance.
- Wrong device signature rejection.
- Replay rejection via monotonic `captureTs`.
- Revoked device rejection.
- Future timestamp rejection.
- Unenrolled device rejection.

The Foundry fuzz target covers forgery resistance over 5,000 fuzz runs.

## Edge Node

Added a new top-level `edge-node/` package with:

- Software development signer.
- TPM signer stub for follow-up hardware integration.
- File-watch instrument adapter.
- USB serial adapter stub.
- Attestation hash/signing logic aligned with the smart contract.
- Multipart transport to issuer-service.
- Edge daemon for watching new instrument outputs and submitting signed attestations.
- Edge overhead benchmark.
- RPi 4 TPM and ESP32 ATECC setup notes.

The edge node signs the same digest that the registry verifies on-chain.

## Issuer Service

Updated issuer-service with:

- `SignedAttestation` and attestation payload types.
- `CredentialIssuer.issueFromAttestation(...)`.
- Defense-in-depth local signature recovery check.
- Raw artifact SHA-256 verification.
- Buffer upload to MinIO/S3.
- On-chain submission through `issueCredentialWithAttestation(...)`.
- Device lookup through the PureChain client.
- Jest smoke coverage for attested issuance validation.
- Runtime `.env` configured for the live PureChain registry.
- Issuer signing keypair generated for `Org1MSP`.
- PureChain client startup logging hardened so it no longer prints private-key prefixes.
- New REST endpoint:

```http
POST /v1/attested-credential
```

The endpoint accepts multipart form data:

- `attestation`: JSON signed attestation
- `artifact`: raw instrument output file

## Benchmark And Security Extensions

Updated `experiments/security-tests.ts` with A6-A9:

- A6: Compromised issuer without valid edge attestation.
- A7: Attestation replay.
- A8: Future timestamp / clock manipulation.
- A9: Software signer device-key compromise, intentionally reported as not protocol-detectable.

Updated `experiments/benchmark-suite.ts` with:

- Edge overhead ingestion from `edge-node` benchmark output.
- Artifact fetch + SHA-256 recomputation latency scenarios.
- Placeholder support for multi-signer scaling results.
- Relabeled the ablation output so the previous `30.2%` value is explicitly reported as adversarial-subset pass rate rather than false acceptance.

Added:

- `experiments/multi-account-setup.ts`
- `experiments/multi-account-throughput.ts`
- `experiments/multi-signer-scaling.ts`
- `experiments/besu-cluster/` Clique cluster scaffolding

Added IoT-J evaluation harness scaffolding:

- `experiments/eval-utils.ts` for shared live PureChain configuration.
- `experiments/bench-upgraded.ts` for n>=1000 latency measurements with bootstrap confidence intervals and cold/warm separation.
- `experiments/scaling-state-growth.ts` for verification-vs-registry-size experiments using a dedicated registry.
- `experiments/security-tests-live.ts` for A1-A9 live PureChain attack runs.
- `experiments/diagnostics/dataset-composition.ts` for diagnosing dataset balance and false-acceptance reporting.
- `experiments/postgres-baseline/` for the centralized PostgreSQL comparison service and benchmark.
- `experiments/e2e-latency/` for MinIO RTT-injection end-to-end latency experiments.
- `experiments/plots/` scripts for state growth, cold-vs-warm, and multi-signer figures.
- `experiments/energy/analyze-energy.py` for USB power-meter energy-per-attestation analysis.
- `experiments/reproduce-iotj.sh` and `experiments/REPRODUCE.md` for reproducibility.

Dataset diagnostic result:

- `normal`: 200 total, 155 valid, 45 invalid, invalid rate `22.5%`.
- `drift`: 200 total, 109 valid, 91 invalid, invalid rate `45.5%`.
- `adversarial`: 500 total, 141 valid, 359 invalid, invalid rate `71.8%`.
- Combined: 900 total, 405 valid, 495 invalid, invalid rate `55.0%`.
- Implication: the previously suspicious `30.2%` baseline false-acceptance number is not explained by overall dataset invalid prevalence and should be traced as a metric/reporting issue.

Follow-up diagnosis of the `30.2%` number:

- Exact value appears in `experiments/results/benchmark-report.json` as `baselinePassRate: 0.30200000000000005`.
- Producing code is `experiments/benchmark-suite.ts` in `runAblationStudies(...)`.
- The ablation code loads only `experiments/data/adversarial/materials.json`, not the full combined dataset.
- The value is computed as `baselinePassRate = 1 - baselineFailRate` after applying `verifyWithFullPolicy(...)` to the adversarial subset.
- Best current interpretation: `30.2%` is an adversarial-subset baseline pass rate, not a full-dataset false-acceptance rate.
- Hypothesis category: `(b) Computed on a dataset subset rather than the full dataset`.

Follow-up fix:

- `experiments/benchmark-suite.ts` now labels the metric explicitly as adversarial-subset pass rate.
- Old ambiguous fields `baselinePassRate`, `ablatedPassRate`, and `falseAcceptIncrease` were replaced with explicit fields:
  - `baselinePassRate_adversarial`
  - `baselineDetectionRate_adversarial`
  - `ablatedPassRate_adversarial`
  - `ablatedDetectionRate_adversarial`
  - `passRateIncrease_adversarial`
- Console and LaTeX table labels now use `Adv Base`, `Adv Abl`, and `Delta Pass` semantics instead of false-acceptance wording.

Live upgraded latency benchmark:

- `experiments/bench-upgraded.ts` completed against the deployed PureChain registry with `reads=1000`, `writes=200`, `warmup=20`, and `bootstrap=2000`.
- The PureChain client nonce path was hardened in `issuer-service/src/purechain-client.ts`:
  - Preflight syncs `_nextNonce` from the chain's pending nonce before each write.
  - Retries once after `NONCE_EXPIRED`, `nonce too low`, or `nonce has already been used`.
  - Exposes `resyncNonce(...)` for experiment helpers that send transactions outside the client.
- `experiments/bench-upgraded.ts` now calls `client.resyncNonce(...)` after ephemeral device enrollment.
- Result JSON: `experiments/results/upgraded/bench-upgraded-1776916800822.json`
- Raw log: `experiments/results/upgraded/bench-upgraded-run-v2.log`
- Total runtime: `4388.8s` / about `73m 09s`
- All five required operations were initially present as `verifyOnChain`, `verifyFull`, `registerMaterial`, `issueCredential`, and `issueCredentialWithAttestation`.
- No log errors, reverts, nonce failures, or high-variance operations were detected.
- Important caveat: current `verifyFull` in this harness is a proxy path (`verifyMaterial + getCredentialsForMaterial`), not a real MinIO artifact fetch.

Follow-up relabel for the upgraded benchmark:

- `experiments/bench-upgraded.ts` now labels the proxy read path as `verifyOnChainWithCredentials`.
- A stub `verifyFullE2E` entry was added in the upgraded benchmark file, with the real end-to-end numbers now recorded separately in `experiments/e2e-latency/`.
- The sampling loop now includes an explicit note that this path measures two on-chain round-trips only and does not include MinIO artifact fetch or SHA-256 recomputation.
- Existing result JSON `experiments/results/upgraded/bench-upgraded-1776916800822.json` now carries a top-level note clarifying that the earlier `verifyFull` label in that draft should not be interpreted as full end-to-end verification.
- That upgraded benchmark JSON now also includes `verifyFullE2E_pointer`, pointing at the real MinIO-backed end-to-end result file.

Updated upgraded latency benchmark labels:

- Result JSON: `experiments/results/upgraded/bench-upgraded-1776916800822.json`
- Run log: `experiments/results/upgraded/bench-upgraded-run-v2.log`
- `verifyOnChain`: `n=1000`, p50 `30.9 ms` (`30.8`, `31.0`), p95 `35.4 ms` (`34.6`, `36.4`), p99 `43.0 ms` (`40.8`, `43.3`), mean `31.3 ms`, std `2.5 ms`
- `verifyOnChainWithCredentials`: `n=1000`, p50 `61.2 ms` (`61.1`, `61.4`), p95 `76.3 ms` (`71.6`, `79.8`), p99 `112.1 ms` (`102.0`, `122.7`), mean `63.9 ms`, std `13.9 ms`
- `verifyFullE2E`: not embedded in this upgraded benchmark file; the real artifact-fetch verification results are recorded separately in `experiments/e2e-latency/`

Real `verifyFullE2E` latency with MinIO RTT injection:

- Completed `experiments/e2e-latency/` with a working local MinIO + `tc` RTT-injection setup:
  - `docker-compose.yml` now launches MinIO with `NET_ADMIN` capability through a custom image that includes `tc`
  - `inject-rtt.sh` now detects the MinIO container and applies or clears `netem` delay
  - `e2e-bench.ts` now stages artifacts, fetches them from MinIO, recomputes SHA-256, and combines that with live PureChain `verifyMaterial(...)`
- Result JSON: `experiments/results/e2e-latency/e2e-latency-1776944402293.json`
- Run log: `experiments/results/e2e-latency/e2e-bench-run.log`
- The upgraded benchmark JSON now points at this file via `verifyFullE2E_pointer`
- Three artifact sizes were staged on-chain and in MinIO:
  - `1 KB`: material `bio:cell_line:1104`, credential `cred:1191`
  - `1 MB`: material `bio:cell_line:1105`, credential `cred:1193`
  - `10 MB`: material `bio:cell_line:1106`, credential `cred:1195`
- p50 end-to-end totals across the RTT/size grid:
  - RTT `0 ms`: `1 KB = 31.650 ms`, `1 MB = 49.183 ms`, `10 MB = 135.443 ms`
  - RTT `1 ms`: `1 KB = 42.527 ms`, `1 MB = 47.368 ms`, `10 MB = 145.659 ms`
  - RTT `50 ms`: `1 KB = 92.863 ms`, `1 MB = 201.765 ms`, `10 MB = 1279.843 ms`
  - RTT `100 ms`: `1 KB = 138.619 ms`, `1 MB = 351.153 ms`, `10 MB = 2415.999 ms`
- At RTT `0 ms`, the cost breakdown shifts from on-chain-dominated at `1 KB` to MinIO-fetch-dominated at `10 MB`
- Across all `12` scenario cells and `600` total iterations, there were `0` failures
- `verifyMaterial(...)` remained stable at about `25-36 ms` p50 across the sweep, indicating no obvious PureChain congestion during the run
- At higher RTTs and larger artifacts, total latency is dominated by MinIO fetch time rather than hashing

Live PureChain multi-account throughput sweep:

- Added `experiments/multi-account-setup.ts` to generate and authorize fresh issuer wallets and pre-register target materials.
- Added `experiments/multi-account-throughput.ts` to drive concurrent `issueCredential(...)` writes with per-account nonce tracking and per-tx latency capture.
- Added `experiments/multi-account-wallets.json` to `.gitignore` and persisted the generated temporary wallets there during the run.
- Provisioned `20` temporary issuer accounts, authorized all `20` on-chain, and pre-registered `20` materials per account (`400` total) for the throughput sweep.
- The admin wallet had zero effective gas-cost pressure on PureChain's zero-gas setup, so positive-value funding was not required for these temporary accounts to submit transactions.
- After the sweep, the temporary issuers were revoked again on-chain.

Live PureChain throughput results:

- `K=1`: `20/20` successful, `0` failed, wall-clock `87.226 s`, aggregate throughput `0.2293 ops/s`, per-account p50 `4355.0 ms`, p99 `4406.8 ms`
- `K=2`: `40/40` successful, `0` failed, wall-clock `87.626 s`, aggregate throughput `0.4565 ops/s`, per-account p50 `4377.2 ms`, p99 `4445.9 ms`
- `K=5`: `100/100` successful, `0` failed, wall-clock `88.891 s`, aggregate throughput `1.1250 ops/s`, per-account p50 `4426.6 ms`, p99 `4533.7 ms`
- `K=10`: `200/200` successful, `0` failed, wall-clock `89.759 s`, aggregate throughput `2.2282 ops/s`, per-account p50 `4474.1 ms`, p99 `4706.6 ms`
- `K=20`: `400/400` successful, `0` failed, wall-clock `91.962 s`, aggregate throughput `4.3496 ops/s`, per-account p50 `4600.8 ms`, p99 `4634.9 ms`
- Interpretation: client-side parallel submission across independent issuer accounts scales nearly linearly on the deployed PureChain network up to the tested `20` accounts, improving the observed write ceiling from about `0.23 ops/s` at `K=1` to about `4.35 ops/s` at `K=20`.

Local Besu Clique multi-signer scaling:

- Completed a local Besu Clique PoA proxy study for `1`, `3`, `5`, and `7` signers using `experiments/besu-cluster/` and `experiments/multi-signer-scaling.ts`.
- `experiments/besu-cluster/scripts/generate-genesis.sh` now generates deterministic Clique genesis files, validator metadata, benchmark accounts, and correct bootnode enodes for `1/3/5/7` signers.
- `experiments/besu-cluster/docker-compose.yml` now supports `s1`, `s3`, `s5`, and `s7` profiles with static Docker IPs so Besu bootnodes use valid literal IP addresses rather than rejected hostname-based enodes.
- `contracts/hardhat.config.ts` now includes a local `besu` network on chain ID `2026`.
- `experiments/plots/multi-signer-plot.py` now reads the per-signer result JSON files and emits a combined PDF/PNG figure.

Local Besu Clique throughput results:

- Result files:
  - `experiments/results/multi-signer/multi-signer-scaling-s1-1776928576601.json`
  - `experiments/results/multi-signer/multi-signer-scaling-s3-1776938217393.json`
  - `experiments/results/multi-signer/multi-signer-scaling-s5-1776941130818.json`
  - `experiments/results/multi-signer/multi-signer-scaling-s7-1776941847971.json`
- Plot outputs:
  - `experiments/results/multi-signer/multi-signer-scaling.pdf`
  - `experiments/results/multi-signer/multi-signer-scaling.png`
- At fixed concurrency `1`, throughput was essentially flat across signer counts:
  - `N=1`: `0.2387 ops/s`
  - `N=3`: `0.2392 ops/s`
  - `N=5`: `0.2392 ops/s`
  - `N=7`: `0.2392 ops/s`
- At fixed concurrency `20`, throughput likewise remained flat:
  - `N=1`: `4.6463 ops/s`
  - `N=3`: `4.6269 ops/s`
  - `N=5`: `4.6036 ops/s`
  - `N=7`: `4.5815 ops/s`
- p50 latency stayed near the block cadence:
  - `N=1, C=20`: p50 `4291.5 ms`, p99 `4431.9 ms`
  - `N=7, C=20`: p50 `4355.3 ms`, p99 `4530.7 ms`
- Every run completed with `0` failures and average block time about `1.000 s`.
- `clique_getSignerMetrics` confirmed proposer rotation across all validators on the `7`-signer cluster, so signer count was active but did not materially improve throughput in this configuration.
- Interpretation: in this local Besu Clique proxy, client concurrency improves throughput substantially, but increasing validator count from `1` to `7` does not raise write throughput under the tested settings.

Centralized PostgreSQL baseline:

- Completed `experiments/postgres-baseline/` as a minimal centralized comparison service that mirrors the BioPassport API surface for `registerMaterial`, `issueCredential`, and `verifyMaterial`.
- The baseline uses PostgreSQL row storage plus the same canonicalization / SHA-256 / secp256k1 credential-signing stack as `issuer-service`, isolating the storage-backend tradeoff rather than changing the cryptographic cost model.
- `docker-compose.yml` now launches a dedicated Postgres 16 baseline instance.
- `src/server.ts` now exposes:
  - `POST /materials`
  - `POST /credentials`
  - `POST /transfers`
  - `POST /transfers/:id/accept`
  - `POST /materials/:id/status`
  - `GET /verify/:materialId`
- `bench/postgres-bench.ts` now supports:
  - latency mode with bootstrap confidence intervals
  - throughput mode with the same `K={1,2,5,10,20}` / `20 ops per client` setup used for PureChain
- Result files:
  - `experiments/results/postgres-baseline/postgres-latency-1776945592921.json`
  - `experiments/results/postgres-baseline/postgres-throughput-1776945603886.json`
- Latency highlights:
  - `registerMaterial`: p50 `1.908 ms`, p95 `3.386 ms`, p99 `4.427 ms`
  - `issueCredential`: p50 `4.943 ms`, p95 `7.902 ms`, p99 `10.238 ms`
  - `verifyMaterial`: p50 `2.711 ms`, p95 `5.224 ms`, p99 `6.924 ms`
- Throughput highlights:
  - `K=1`: `186.719 ops/s`
  - `K=2`: `287.294 ops/s`
  - `K=5`: `406.623 ops/s`
  - `K=10`: `361.551 ops/s`
  - `K=20`: `433.361 ops/s`
- Across both latency and throughput runs there were `0` benchmark failures.
- Interpretation: the centralized baseline is orders of magnitude faster than the PureChain-backed path, providing the concrete performance side of the security-vs-performance tradeoff for the paper.

Registry state-growth scaling on a dedicated PureChain registry:

- Completed `experiments/scaling-state-growth.ts` against a fresh dedicated scaling registry rather than the production deployment.
- Dedicated scaling registry:
  - `0xA3B57B89Cc0364749Da6E84aAF27eA8442d667de`
- `batchRegisterMaterials(...)` was already present in `BioPassportRegistry.sol`, so no contract refactor was required.
- `scaling-state-growth.ts` was tightened so it:
  - requires `PURECHAIN_SCALING_REGISTRY`
  - refuses to fall back to the production registry
  - creates a valid probe material with IDENTITY + QC credentials before sampling
  - checkpoints results incrementally after each registry-size target
- Cap selected: `N=10000`
- Result files:
  - `experiments/results/scaling-state-growth-1776946700900.json`
  - `experiments/results/scaling-state-growth-run.log`
  - `experiments/results/state-growth.pdf`
  - `experiments/results/state-growth.png`
- Verification latency vs registry size:
  - `N=100`: verify p50 `30.697 ms`, verify p99 `45.719 ms`, getHistory p50 `60.939 ms`
  - `N=316`: verify p50 `30.743 ms`, verify p99 `40.055 ms`, getHistory p50 `61.929 ms`
  - `N=1000`: verify p50 `30.722 ms`, verify p99 `42.569 ms`, getHistory p50 `61.775 ms`
  - `N=3162`: verify p50 `30.765 ms`, verify p99 `35.883 ms`, getHistory p50 `61.669 ms`
  - `N=10000`: verify p50 `30.757 ms`, verify p99 `42.010 ms`, getHistory p50 `61.880 ms`
- Interpretation: `verifyMaterial` remained effectively flat from `100` to `10000` registered materials, empirically supporting the intended `O(1)` registry-size behavior for verification.
- Plot script note: `experiments/plots/state-growth-plot.py` was corrected to locate the latest results file relative to the repo structure when run from `experiments/`.

## Documentation

Updated:

- `contracts/INVARIANTS.md` with `INV-9: Edge Attestation Authenticity`.
- `contracts/SLITHER_REPORT.md` with reviewed Slither findings.
- `contracts/PURECHAIN_DEPLOYMENT_RUNBOOK.md` with deployment and live smoke-test steps.
- `README.md` with an Edge Attestation section and edge-node run instructions.
- `experiments/plots/multi-signer-plot.py` with support for the new per-signer Besu result layout.

## PureChain Activation

Deployed the edge-attestation-enabled registry to PureChain mainnet:

- Network: `purechain`
- Chain ID: `900520900520`
- Registry: `0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC`
- Deployer: `0xAA3DFc054293Dd3731892A1Ba0366D6e6FB1Ee51`

Live edge-attestation smoke test passed:

- Material: `bio:cell_line:3`
- Credential: `cred:2`
- Device ID: `0xe4ba7ad56bdb6d7793974393571309eed2cebd2620eba3fb9f209d439cf4a156`
- Attestation hash: `0x20cf3701d95d605b3d7f20077804e2978d5db03b0ddd5f13c68189b70da06a5b`
- Transaction: `0x285df36dbba1c4e705decc70c69a8350a0325147ae3e326de24f210449702b2b`

Issuer-service activation inputs are also prepared:

- Runtime env file: `issuer-service/.env`
- Contract address: `0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC`
- Issuer org: `Org1MSP`
- Issuer private key path: `issuer-service/keys/Org1MSP-private.pem`
- Issuer public key path: `issuer-service/keys/Org1MSP-public.txt`

The local issuer key directory is ignored by Git via `issuer-service/keys/`.

## Tooling Installed

Installed and configured:

- `hardhat-contract-sizer`
- Slither `0.11.5`
- Foundry `forge 1.5.1`
- `forge-std`

Foundry and Slither locations were added to the user PATH for new terminals.

## Verification Results

Passed:

```bash
cd contracts
npm exec hardhat compile
npm exec hardhat run scripts/deploy-registry.ts --network hardhat
npm exec hardhat run scripts/deploy-registry.ts --network purechain
npm exec hardhat run scripts/smoke-edge-attestation.ts --network purechain
npm exec hardhat test test/EdgeAttestation.test.ts --no-compile
forge test --match-contract EdgeAttestationFuzzTest --fuzz-runs 5000
npm exec hardhat size-contracts
```

Results:

- Hardhat edge tests: `6 passing`
- Foundry fuzz: `1 passed`, `0 failed`, `5000 runs`
- Full Hardhat contract suite: `83 passing`
- Contract size: `BioPassportRegistry = 20.945 KiB`, under the 24 KiB EVM limit
- Deployment script dry run: local Hardhat deployment and smoke material registration passed
- PureChain deployment: registry deployed to `0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC`
- PureChain live edge-attestation smoke test: passed with credential `cred:2`

Passed:

```bash
cd edge-node
npm install
npm run build
npm run bench -- --iterations=500
```

Edge benchmark result highlights:

- SHA-256 1 MB p50: about `4.0 ms`
- ECDSA sign p50: about `0.86 ms`
- End-to-end p50: about `4.89 ms`

Important: these are dev-machine baseline numbers measured on an x64 desktop CPU with the software signer. They are not RPi 4, ESP32, TPM, or secure-element numbers and should not be cited as edge-device overhead in the paper. Hardware edge benchmarks are still pending. A real TPM-backed ECDSA signature is expected to dominate the path, likely around tens to hundreds of milliseconds depending on the module.

RPi 4 software-signer benchmark collected:

- Result file: `experiments/results/edge-hardware/rpi4-software-edge-overhead-pi6-1776842375138.json`
- Platform: `arm64`, Cortex-A72, 4 cores, Node `v20.19.2`, Linux `6.12.47+rpt-rpi-v8`
- Reported memory: `7821 MB`, so the attached Pi appears to be an 8 GB unit rather than the expected 4 GB unit.
- SHA-256 1 MB p50: `9.71 ms`
- ECDSA software sign p50: `3.32 ms`
- End-to-end p50: `13.14 ms`
- End-to-end p95: `19.13 ms`
- End-to-end p99: `29.21 ms`

These RPi software-signer numbers are hardware-edge baseline numbers and can replace the x64 dev-machine baseline for the software-only edge-cost floor. TPM-backed numbers are still pending.

Passed:

```bash
cd issuer-service
npm run build
npm test
```

Issuer-service tests:

- Jest attestation smoke tests: `3 passing`
- `.env` required keys present
- `ISSUER_PRIVATE_KEY` file exists
- PureChain private-key logging no longer exposes key material

Passed:

```bash
cd experiments
npm exec tsc -- --noEmit
npm exec ts-node -- security-tests.ts
npm run diagnostics:dataset
npm exec ts-node -- bench-upgraded.ts --reads 1000 --writes 200 --warmup 20 --bootstrap 2000
```

Security tests:

- `11/11 tests passed`
- Dataset diagnostics wrote `experiments/results/diagnostics/dataset-composition-*.json`

Upgraded live PureChain latency benchmark:

- Result JSON: `experiments/results/upgraded/bench-upgraded-1776916800822.json`
- Run log: `experiments/results/upgraded/bench-upgraded-run-v2.log`
- Configuration: `reads=1000`, `writes=200`, `warmup=20`, `bootstrap=2000`
- Wall-clock duration: `4388.8s` / about `73m 09s`
- `verifyOnChain`: `n=1000`, p50 `30.9 ms` (`30.8`, `31.0`), p95 `35.4 ms` (`34.6`, `36.4`), p99 `43.0 ms` (`40.8`, `43.3`), mean `31.3 ms`, std `2.5 ms`
- `verifyOnChainWithCredentials`: `n=1000`, p50 `61.2 ms` (`61.1`, `61.4`), p95 `76.3 ms` (`71.6`, `79.8`), p99 `112.1 ms` (`102.0`, `122.7`), mean `63.9 ms`, std `13.9 ms`
- `registerMaterial`: `n=200`, p50 `4263.8 ms` (`4259.9`, `4267.3`), p95 `4414.7 ms` (`4301.5`, `4445.1`), p99 `4528.8 ms` (`4430.1`, `4559.9`), mean `4274.9 ms`, std `45.9 ms`
- `issueCredential`: `n=200`, p50 `4263.6 ms` (`4261.3`, `4268.7`), p95 `4313.5 ms` (`4297.1`, `4381.7`), p99 `4617.3 ms` (`4339.0`, `4631.0`), mean `4273.5 ms`, std `47.1 ms`
- `issueCredentialWithAttestation`: `n=200`, p50 `4256.7 ms` (`4254.8`, `4258.2`), p95 `4294.6 ms` (`4285.1`, `4307.1`), p99 `4372.6 ms` (`4305.1`, `4503.1`), mean `4263.5 ms`, std `26.8 ms`
- CI width ratios were all below `0.20`; the widest was `verifyOnChainWithCredentials` p99 at `0.1842`.
- Cold/warm ratios were all near `1.0`; no operation exceeded the `1.5x` cold-start threshold.

Passed:

```bash
cd experiments
npm exec ts-node -- multi-account-setup.ts --accounts 20
npm exec ts-node -- multi-account-throughput.ts --accounts 1 --ops-per-account 20
npm exec ts-node -- multi-account-throughput.ts --accounts 2 --ops-per-account 20
npm exec ts-node -- multi-account-throughput.ts --accounts 5 --ops-per-account 20
npm exec ts-node -- multi-account-throughput.ts --accounts 10 --ops-per-account 20
npm exec ts-node -- multi-account-throughput.ts --accounts 20 --ops-per-account 20
```

Live PureChain multi-account throughput sweep:

- Setup: `20` temporary issuers generated, authorized, and verified on-chain
- Materials: `400` pre-registered target materials across the `20` accounts
- Result files were written under `experiments/results/multi-account/`
- All sweep runs completed successfully with `0` failures and no nonce errors
- Headline throughput improved from `0.2293 ops/s` at `K=1` to `4.3496 ops/s` at `K=20`

Passed:

```bash
cd experiments/e2e-latency
docker compose up -d
curl http://localhost:9010/minio/health/live
bash inject-rtt.sh 50
bash inject-rtt.sh 0

cd ..
npm exec ts-node -- e2e-latency/e2e-bench.ts

cd e2e-latency
docker compose down -v
```

MinIO-backed end-to-end verification latency:

- Local MinIO health check passed before the run
- RTT injection was validated locally: baseline health-check fetch was about `27.16 ms`, and with `50 ms` injected delay it rose to about `49.05 ms`
- `e2e-bench.ts` completed all `12` `(RTT, size)` scenarios with `50` iterations each
- Total samples collected: `600`
- Failures: `0`
- Result JSON written to `experiments/results/e2e-latency/e2e-latency-1776944402293.json`
- Run log written to `experiments/results/e2e-latency/e2e-bench-run.log`
- `verifyFullE2E_pointer` was added to `experiments/results/upgraded/bench-upgraded-1776916800822.json`

Passed:

```bash
cd experiments/postgres-baseline
docker compose up -d
npm install
npm run build

DATABASE_URL=postgres://bp:bp@localhost:5434/bp_baseline PORT=3100 ISSUER_PRIV=0x... npm exec ts-node -- src/server.ts

SERVICE_URL=http://localhost:3100 npm exec ts-node -- bench/postgres-bench.ts --mode=latency --reads 1000 --writes 1000 --bootstrap 2000
SERVICE_URL=http://localhost:3100 npm exec ts-node -- bench/postgres-bench.ts --mode=throughput --concurrency-levels 1,2,5,10,20 --ops-per-client 20
docker compose down -v
```

Centralized PostgreSQL baseline verification:

- Postgres schema booted successfully with `materials`, `credentials`, and `transfers` tables present
- Baseline service smoke test passed on `http://localhost:3100`
- Latency bench completed successfully and wrote `experiments/results/postgres-baseline/postgres-latency-1776945592921.json`
- Throughput bench completed successfully and wrote `experiments/results/postgres-baseline/postgres-throughput-1776945603886.json`
- There were `0` failures across both benchmark modes
- Headline comparison to PureChain:
  - `registerMaterial` p50: `1.908 ms`
  - `issueCredential` p50: `4.943 ms`
  - `verifyMaterial` p50: `2.711 ms`
  - Throughput `K=1`: `186.719 ops/s`
  - Throughput `K=20`: `433.361 ops/s`

Passed:

```bash
cd experiments/besu-cluster
bash scripts/generate-genesis.sh 1
docker compose --profile s1 up -d

cd ../../contracts
npm exec -- hardhat run scripts/deploy-registry.ts --network besu

cd ../experiments
npm exec ts-node -- multi-signer-scaling.ts --signers 1 --concurrency-levels 1,5,10,20 --ops-per-client 30 --registry 0x049643aC9e68AcBA4600596Da7117BB38Ea399bb
npm exec ts-node -- multi-signer-scaling.ts --signers 3 --concurrency-levels 1,5,10,20 --ops-per-client 30 --registry 0x049643aC9e68AcBA4600596Da7117BB38Ea399bb
npm exec ts-node -- multi-signer-scaling.ts --signers 5 --concurrency-levels 1,5,10,20 --ops-per-client 30 --registry 0x049643aC9e68AcBA4600596Da7117BB38Ea399bb
npm exec ts-node -- multi-signer-scaling.ts --signers 7 --concurrency-levels 1,5,10,20 --ops-per-client 30 --registry 0x049643aC9e68AcBA4600596Da7117BB38Ea399bb
python experiments/plots/multi-signer-plot.py
```

Local Besu Clique scaling verification:

- Docker smoke test: local `1`-signer Clique chain produced blocks successfully on `http://localhost:8545`
- Multi-signer clusters for `3`, `5`, and `7` signers came up with expected peer counts
- Registry deployment to local Besu succeeded
- All `16` `(signers, concurrency)` throughput points completed with `0` failures
- Plot outputs were generated successfully as PDF and PNG

Passed:

```bash
cd contracts
npm exec hardhat run scripts/deploy-registry.ts --network purechain

cd ../experiments
PURECHAIN_SCALING_REGISTRY=0xA3B57B89Cc0364749Da6E84aAF27eA8442d667de npm exec ts-node -- scaling-state-growth.ts --max 10000 2>&1 | tee results/scaling-state-growth-run.log
python plots/state-growth-plot.py
```

Dedicated PureChain state-growth verification:

- Fresh scaling registry deployed successfully to `0xA3B57B89Cc0364749Da6E84aAF27eA8442d667de`
- Existing `batchRegisterMaterials(...)` support was used; no contract change was required
- The state-growth driver completed checkpoints at `100`, `316`, `1000`, `3162`, and `10000`
- Result JSON written to `experiments/results/scaling-state-growth-1776946700900.json`
- Plot outputs written to:
  - `experiments/results/state-growth.pdf`
  - `experiments/results/state-growth.png`
- Verification latency remained flat across registry growth:
  - lowest verify p50: `30.697 ms`
  - highest verify p50: `30.765 ms`
- `PURECHAIN_SCALING_REGISTRY` was removed from `issuer-service/.env` after the run to avoid accidental reuse of the dedicated scaling registry

Live PureChain A1-A9 attack-suite:

- Nonce desynchronization after expected revert transactions was fixed in `experiments/security-tests-live.ts`.
- The harness now resyncs the PureChain client's manually tracked `_nextNonce` after expected reverts and after helper transactions sent outside the client.
- Raw v2 log: `experiments/results/attack-suite-live-run-v2.log`
- Result JSON: `experiments/results/attack-suite-live-1776910387310.json`
- Run duration: `106.855s`
- Outcome: all A1-A9 outcomes matched expectations.

Live A1-A9 result summary:

- A1 credential omission: detected `true`, expected `true`, reason `MISSING_IDENTITY,QC_MISSING`, latency `4390.6 ms`.
- A2 QC replay/latest-QC policy: detected `true`, expected `true`, reason `QC_EXPIRED`, latency `24115.6 ms`.
- A3 pending-transfer abuse: detected `true`, expected `true`, reason `QC_EXPIRED,TRANSFER_PENDING`, latency `17146.6 ms`.
- A4 artifact tampering: detected `true`, expected `true`, reason `ARTIFACT_TAMPERED`, latency `0.2 ms`.
- A5 revoked material: detected `true`, expected `true`, reason `MATERIAL_REVOKED,QC_EXPIRED`, latency `17235.4 ms`.
- A6 compromised issuer without enrolled device attestation: detected `true`, expected `true`, reason `transaction execution reverted`, latency `9165.7 ms`.
- A7 attestation replay: detected `true`, expected `true`, reason `transaction execution reverted`, latency `18438.6 ms`.
- A8 future capture timestamp: detected `true`, expected `true`, reason `transaction execution reverted`, latency `14012.3 ms`.
- A9 software signer key compromise: detected `false`, expected `false`, reason `OUT_OF_SCOPE_SOFTWARE_SIGNER`, latency `0.1 ms`.

## Known Caveats

- Full Hardhat contract suite is now clean locally: `83 passing`.
- `issuer-service npm test` is now clean locally with attestation smoke coverage.
- `issuer-service/.env` is present locally and points at the deployed PureChain registry.
- `issuer-service/keys/Org1MSP-private.pem` exists locally for issuer credential signing.
- Slither findings are triaged in `contracts/SLITHER_REPORT.md`. No edge-attestation high/critical issue was identified from the run.
- TPM public-key ASN.1 parsing is intentionally left as a future hardening task.
- PureChain deployment and live attestation smoke test are complete. Operator steps remain documented in `contracts/PURECHAIN_DEPLOYMENT_RUNBOOK.md`.
- IoT-J software evaluation scripts are now implemented and exercised end-to-end; remaining unfinished work is hardware-side measurement and hardening.
- RPi 4 software-signer benchmark is collected and copied back into `experiments/results/edge-hardware/`.
- Live A1-A9 attack-suite execution is now complete on PureChain with all expected outcomes matched.
- Upgraded n>=1000 live PureChain latency benchmark is complete with bootstrap CIs and cold/warm separation.
- The upgraded benchmark's old `verifyFull` label has been corrected to `verifyOnChainWithCredentials`, and the real MinIO-backed `verifyFullE2E` measurements now live in `experiments/results/e2e-latency/e2e-latency-1776944402293.json`.
- Live PureChain multi-account throughput sweep is complete and shows near-linear scaling up to `20` concurrent issuer accounts.
- Centralized PostgreSQL baseline benchmarking is complete and provides the paper's concrete performance comparison point.
- Local Besu Clique signer-scaling sweep is complete for `1/3/5/7` signers and shows no meaningful throughput gain from higher validator count under the tested `1 s` block-period configuration.
- Dedicated PureChain state-growth scaling is complete through `N=10000` materials and shows flat `verifyMaterial` latency.
- Ablation `30.2%` reporting source has been traced and relabeled as adversarial-subset pass rate, not full-dataset false acceptance.
- `eth_getBlockByNumber` on the local Besu run did not expose a useful miner/author field for signer attribution; signer rotation was instead verified with `clique_getSignerMetrics`.
- The local Besu results are useful for trend analysis, but their absolute ops/s values are not directly comparable to live PureChain because the local cluster used a `1 s` Clique block period and localhost RPC.
- The local MinIO e2e experiment used host ports `9010/9011` rather than `9000/9001` because an unrelated MinIO service was already bound on the default host ports.
- The `verifyFullE2E` numbers are local Docker + localhost MinIO measurements with injected RTT, so their absolute values should be interpreted as controlled end-to-end verification measurements rather than raw WAN production latencies.
- The PostgreSQL baseline used host port `5434` rather than `5433` because an unrelated local Postgres service was already bound on `5433`.
- The state-growth `getHistory` curve was measured on a constant-history probe material, so the reported flat behavior there reflects registry-size independence rather than per-material history-growth cost.

## Current Status

The edge-attestation implementation is functionally complete for the local implementation milestone:

- Contract path is implemented and tested.
- Edge-node can sign and benchmark attestations.
- Issuer-service can accept attested artifacts and submit the new on-chain method.
- Security and benchmark harnesses include the new edge-attestation layer.
- Documentation includes INV-9 and operational instructions.
- Live PureChain multi-account throughput characterization is complete.
- Local Besu Clique validator-scaling characterization is complete.
- Real MinIO-backed `verifyFullE2E` latency characterization is complete.
- Centralized PostgreSQL baseline characterization is complete.
- Dedicated PureChain state-growth characterization is complete.

The remaining work is collecting RPi 4 TPM / ESP32 hardware measurements, collecting energy logs, completing hardware signer hardening, and writing up the completed software results for the paper.
