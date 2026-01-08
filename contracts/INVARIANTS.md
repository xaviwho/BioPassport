# BioPassport Contract Invariants

This document formalizes the security invariants enforced by the BioPassportRegistry smart contract. These invariants are verified through property-based testing, static analysis, and formal reasoning.

## Core Verification Invariant

A material `M` is **valid** if and only if:

```
VALID(M) ≡ 
    (∃ c ∈ M.credentials : c.type = IDENTITY ∧ ¬c.revoked) ∧
    (∃ c ∈ M.credentials : c.type = QC_MYCO ∧ c.validUntil > now ∧ isLatestQC(c)) ∧
    (∀ t ∈ M.transfers : t.accepted = true) ∧
    (M.status = ACTIVE)
```

## Invariant Categories

### INV-1: Credential Issuance Authorization

**Statement:** Only approved issuers with the correct permission can issue credentials of a given type.

```solidity
∀ credential c:
    c.type = IDENTITY → issuerPermissions[c.issuer].canIssueIdentity = true
    c.type = QC_MYCO  → issuerPermissions[c.issuer].canIssueQC = true
    c.type = USAGE_RIGHTS → issuerPermissions[c.issuer].canIssueUsageRights = true
```

**Enforcement:** `issueCredential()` checks `issuerPermissions[msg.sender]` before allowing issuance.

**Test Coverage:**
- `test_unauthorized_issuer_rejected()`
- `test_wrong_permission_type_rejected()`
- `test_authorized_issuer_succeeds()`

---

### INV-2: Issuer Revocation Semantics

**Statement:** Credentials issued BEFORE an issuer's revocation remain valid; credentials cannot be issued AFTER revocation.

```solidity
∀ credential c, issuer i:
    issuerRevokedAt[i] > 0 ∧ c.issuedAt < issuerRevokedAt[i] → c is valid
    issuerRevokedAt[i] > 0 ∧ block.timestamp > issuerRevokedAt[i] → issueCredential() reverts
```

**Enforcement:** `issueCredential()` checks `issuerRevokedAt[msg.sender] == 0`.

**Test Coverage:**
- `test_credential_before_revocation_valid()`
- `test_issuance_after_revocation_reverts()`

---

### INV-3: Status Authority Control

**Statement:** Only authorized parties can set material status, with role-based restrictions.

```solidity
setStatusByOwner(materialId, status):
    require(msg.sender = material.owner)
    require(status ∈ {QUARANTINED})  // Owner can only quarantine

setStatusByAuthority(materialId, status):
    require(msg.sender = admin ∨ issuerPermissions[msg.sender].canIssueQC)
    // Authority can set any status
```

**Enforcement:** Separate functions with different permission checks.

**Test Coverage:**
- `test_owner_can_quarantine()`
- `test_owner_cannot_revoke()`
- `test_authority_can_revoke()`
- `test_qc_issuer_can_quarantine()`

---

### INV-4: Transfer Chain Continuity

**Statement:** At most one pending transfer exists at any time; verification fails with pending transfers.

```solidity
∀ material M:
    |{t ∈ M.transfers : ¬t.accepted}| ≤ 1

initiateTransfer(materialId, ...):
    require(¬∃ t ∈ M.transfers : ¬t.accepted)
```

**Enforcement:** `initiateTransfer()` checks for existing pending transfer.

**Test Coverage:**
- `test_single_pending_transfer()`
- `test_double_transfer_rejected()`
- `test_pending_transfer_fails_verification()`

---

### INV-5: Latest QC Credential Policy

**Statement:** Verification uses only the most recent QC credential, not any historical QC.

```solidity
verifyMaterial(materialId):
    latestQC = max{c.issuedAt : c ∈ M.credentials ∧ c.type = QC_MYCO}
    require(latestQC.validUntil > block.timestamp)
```

**Enforcement:** `verifyMaterial()` iterates to find latest QC by `issuedAt`.

**Test Coverage:**
- `test_latest_qc_used()`
- `test_old_valid_qc_ignored()`
- `test_expired_latest_qc_fails()`

---

### INV-6: Material Type Validation

**Statement:** Only valid material types can be registered.

```solidity
registerMaterial(materialType, ...):
    require(materialType ∈ {"CELL_LINE", "PLASMID"})
```

**Enforcement:** `registerMaterial()` validates `materialType` string.

**Test Coverage:**
- `test_valid_material_types()`
- `test_invalid_material_type_rejected()`

---

### INV-7: Commitment Hash Integrity

**Statement:** All commitment hashes must be non-zero.

```solidity
∀ material M: M.metadataHash ≠ 0x0
∀ credential c: c.commitmentHash ≠ 0x0
∀ transfer t: t.shipmentHash ≠ 0x0
```

**Enforcement:** Input validation in all mutating functions.

**Test Coverage:**
- `test_zero_hash_rejected()`

---

### INV-8: History Immutability

**Statement:** History entries are append-only and cannot be modified or deleted.

```solidity
∀ material M, time t1 < t2:
    M.history[t1] = M.history[t2][0..len(M.history[t1])]
```

**Enforcement:** `history` array only supports `push()`, no delete/modify.

**Test Coverage:**
- `test_history_append_only()`
- `test_history_count_monotonic()`

---

## Verification Evidence

### Static Analysis (Slither)

```bash
cd contracts
slither src/BioPassportRegistry.sol --config slither.config.json
```

Expected findings addressed:
- ✅ No reentrancy vulnerabilities (no external calls before state changes)
- ✅ No integer overflow (Solidity 0.8+ built-in checks)
- ✅ Access control properly enforced

### Property-Based Fuzzing (Foundry)

```bash
cd contracts
forge test --fuzz-runs 10000
```

Fuzz targets:
- `testFuzz_issueCredential_authorization(address issuer, uint8 credType)`
- `testFuzz_verifyMaterial_consistency(bytes32 materialId)`
- `testFuzz_transfer_chain_integrity(uint256 transferCount)`

### Test Coverage

```bash
cd contracts
forge coverage
```

Target: >90% line coverage, 100% branch coverage for security-critical functions.

---

## Bug Classes Prevented

| Bug Class | Prevention Mechanism | Invariant |
|-----------|---------------------|-----------|
| Replay old QC | Latest-QC-only policy | INV-5 |
| Revoked issuer issuance | Revocation timestamp check | INV-2 |
| Owner status abuse | Authority-only revocation | INV-3 |
| Pending transfer bypass | Single pending transfer check | INV-4 |
| Unauthorized credential | RBAC permission check | INV-1 |

---

## Formal Verification Roadmap

Future work includes:
1. **Certora Prover** rules for INV-1 through INV-8
2. **Symbolic execution** with Manticore for edge cases
3. **Economic invariants** for gas cost bounds
