# Slither Triage Report

Date: 2026-04-21  
Target: `src/BioPassportRegistry.sol`  
Tool: Slither `0.11.5`

## Summary

Slither runs successfully against the registry using the Foundry build path. The current findings are reviewed below. No high or critical edge-attestation issue was identified in the new `issueCredentialWithAttestation` path.

The project config uses `fail_none` so the command remains reproducible after findings are reviewed:

```bash
cd contracts
slither src/BioPassportRegistry.sol --config slither.config.json
```

## Findings

| Detector | Location | Status | Triage |
| --- | --- | --- | --- |
| `uninitialized-state` | `materialTransfers` | False positive | Mappings are intentionally empty until first write. Solidity mappings do not require explicit initialization. |
| `divide-before-multiply` | `uint2str` | Accepted | Decimal digit extraction uses integer arithmetic for string conversion only. It does not affect balances, authorization, or policy decisions. |
| `incorrect-equality` | Material status and credential existence checks | Accepted | Strict enum equality is intentional for policy decisions such as `REVOKED`, `QUARANTINED`, and missing credential detection. |
| `timestamp` | Validity checks, capture timestamp checks, verification at time | Accepted with justification | The registry intentionally uses `block.timestamp` for credential expiry and future-capture rejection. Edge attestation only rejects future capture timestamps; it does not rely on sub-second precision or miner-controlled randomness. |
| `assembly` | `_recoverAttestationSigner` | Accepted | Inline assembly extracts `r`, `s`, `v` from a 65-byte ECDSA signature before calling `ecrecover`. Signature length is checked before assembly. |
| `costly-loop` | Batch registration and batch credential issuance | Accepted | Batch functions intentionally perform storage writes in bounded loops. Limits are enforced: 100 material registrations and 50 credential issuances. |
| `cyclomatic-complexity` | `_verifyMaterialAt` | Accepted | Verification combines material status, issuer revocation, latest-QC selection, and transfer-chain checks. Complexity is covered by unit tests and fuzz tests. |
| `naming-convention` | `uint2str(uint256 _i)` | Accepted | Internal utility naming predates this change and is not security relevant. |
| `too-many-digits` | `uint2str` fast path | Accepted | The `1_000_000` threshold is a readability/performance constant for decimal string conversion. |

## Edge-Attestation-Specific Review

The new attestation path adds:

- Device enrollment and revocation checks.
- Signature recovery against the enrolled device address.
- Monotonic `captureTs` replay defense.
- Future timestamp rejection.
- Existing issuer permission checks.

Relevant tests:

- `EdgeAttestation.test.ts`: six Hardhat unit tests.
- `EdgeAttestation.t.sol`: Foundry forgery-resistance fuzz test with 5,000 runs.

## Follow-Up Hardening

- Replace manual signature parsing with OpenZeppelin `ECDSA` if bytecode budget permits.
- Consider splitting `_verifyMaterialAt` into smaller internal helpers if readability becomes a maintenance issue.
- Add a CI job that runs Slither and archives `slither-report.json` / `slither-report.sarif`.
