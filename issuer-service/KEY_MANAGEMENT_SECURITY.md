# BioPassport Key Management Security Guide

## ⚠️ CRITICAL SECURITY CHANGES

**All predictable key derivation has been REMOVED from this system.**

### What Changed

#### ❌ **REMOVED** (Insecure)
- `keyFromSeed()` fallback in `createIssuer()`
- Automatic key generation from organization names
- Predictable keys derived from `sha256(orgId)`

#### ✅ **ADDED** (Secure)
- Mandatory private key path requirement
- Entropy validation (minimum 4.0 bits for hex strings)
- Secure key generation tool with cryptographic randomness
- Deprecation warnings for insecure functions
- Production safety checks

---

## Why This Matters

### The Vulnerability

Previously, the system allowed keys to be derived from organization names:

```typescript
// ❌ INSECURE (REMOVED)
const privateKey = keyFromSeed('Org1MSP');
// Generates: sha256('Org1MSP') = predictable value
```

**Attack Scenario:**
1. Attacker knows your organization name (publicly available)
2. Attacker computes: `privateKey = sha256('Org1MSP')`
3. Attacker can now sign ANY credential as your organization
4. Attacker can forge STR profiles, QC results, transfer documents
5. **Complete compromise of credential integrity**

### The Fix

Now all keys must be cryptographically generated:

```typescript
// ✅ SECURE (REQUIRED)
const privateKey = loadPrivateKey('./keys/Org1MSP-private.pem');
// Loaded from file with entropy validation
```

---

## Generating Secure Keys

### Step 1: Generate Keypair

```bash
cd issuer-service
npm run generate-keypair -- <OrgName> ./keys
```

**Example:**
```bash
npm run generate-keypair -- Org1MSP ./keys
```

**Output:**
```
🔐 Generating secure keypair for: Org1MSP

🔄 Generating cryptographically secure keypair...
✅ Generated key with entropy: 3.912 bits (excellent)
✅ Created directory: ./keys
✅ Private key: ./keys/Org1MSP-private.pem (mode: 0600)
✅ Public key:  ./keys/Org1MSP-public.txt

📋 Next Steps:
1. Store private key securely (AWS Secrets Manager, Vault, etc.)
2. Add public key to verifier's issuer-registry.json
3. Set: export ISSUER_PRIVATE_KEY=./keys/Org1MSP-private.pem
4. Delete plaintext file after storing securely
```

### Step 2: Secure the Private Key

**DO:**
- ✅ Store in secure key management system (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault)
- ✅ Set restrictive file permissions (0600)
- ✅ Encrypt at rest
- ✅ Limit access to authorized personnel only
- ✅ Enable audit logging for all access
- ✅ Rotate keys periodically (every 90-180 days)

**DON'T:**
- ❌ Commit to version control (add to `.gitignore`)
- ❌ Share via email or chat
- ❌ Store in plaintext on disk long-term
- ❌ Use the same key across environments (dev/staging/prod)
- ❌ Derive from predictable values (names, dates, etc.)

### Step 3: Configure Environment

```bash
# Set private key path
export ISSUER_PRIVATE_KEY=./keys/Org1MSP-private.pem

# Or use key management service
export ISSUER_PRIVATE_KEY=/path/from/vault/Org1MSP-private.pem
```

### Step 4: Share Public Key

Add to verifier's `issuer-registry.json`:

```json
{
  "issuers": {
    "Org1MSP": {
      "issuerId": "Org1MSP",
      "publicKey": "04a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2...",
      "addedAt": "2026-02-03T12:00:00Z",
      "description": "Research Laboratory A"
    }
  }
}
```

---

## Entropy Validation

### What is Entropy?

**Entropy** measures randomness in a key. Higher entropy = more unpredictable = more secure.

For hexadecimal strings (64 characters, 0-9 and a-f):
- **Maximum entropy**: 4.0 bits per character (16 equally probable values)
- **Minimum required**: 4.0 bits (well-distributed random)
- **Low entropy**: <3.8 bits (predictable patterns)

### How It Works

When you load a private key, the system calculates its entropy:

```typescript
const entropy = calculateEntropy(keyHex);
// keyHex = "a1b2c3d4..." (64 characters)

if (entropy < 4.0) {
  throw new Error('SECURITY ERROR: Low entropy key detected!');
}
```

### Examples

**High Entropy (GOOD):**
```
a7f4b9e2c8d1f6a3b5e7c9f1d4a6b8e2c7f9d1a5b3e8c6f2d9a4b7e1c5f8d2a6
Entropy: 3.985 bits ✅
```

**Low Entropy (BAD):**
```
1111111111111111222222222222222233333333333333334444444444444444
Entropy: 2.000 bits ❌ (predictable pattern)
```

**Zero Entropy (TERRIBLE):**
```
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Entropy: 0.000 bits ❌ (completely predictable)
```

---

## Migration Guide

### For Existing Deployments Using `keyFromSeed()`

If you're currently using predictable keys, **you must rotate immediately**:

#### Step 1: Generate New Secure Keys

For each issuer organization:

```bash
npm run generate-keypair -- Org1MSP ./keys/new
npm run generate-keypair -- QCLab ./keys/new
# ... for each issuer
```

#### Step 2: Update Issuer Registry

Update `issuer-registry.json` with NEW public keys:

```json
{
  "issuers": {
    "Org1MSP": {
      "issuerId": "Org1MSP",
      "publicKey": "<NEW_PUBLIC_KEY_HERE>",
      "addedAt": "2026-02-03T12:00:00Z",
      "description": "Research Laboratory A"
    }
  }
}
```

#### Step 3: Coordinate Key Rotation

**Maintenance Window Required** (2-3 hours):

1. **T-0 minutes**: Announce maintenance window
2. **T+0 minutes**: Stop accepting new credential requests
3. **T+5 minutes**: Deploy new issuer-service with `ISSUER_PRIVATE_KEY` set to new key
4. **T+10 minutes**: Deploy new verifier with updated `issuer-registry.json`
5. **T+15 minutes**: Test issuance → verification workflow
6. **T+30 minutes**: Resume normal operations
7. **T+24 hours**: Disable old keys on-chain (call `revokeIssuer()` for old addresses)

#### Step 4: Verify Migration

```bash
# Issue a test credential with new key
npm run issue -- --material bio:cell_line:test --type IDENTITY

# Verify with updated registry
cd verifier-cli
npm run verify -- --material bio:cell_line:test
# Should show: ✅ Signature valid
```

---

## Security Best Practices

### 1. Key Generation

- ✅ **Always** use `npm run generate-keypair`
- ✅ Verify entropy >= 3.9 bits
- ✅ Generate unique keys per environment (dev/staging/prod)
- ❌ **Never** derive keys from predictable inputs
- ❌ **Never** reuse keys across organizations

### 2. Key Storage

**Production:**
- ✅ AWS Secrets Manager
- ✅ HashiCorp Vault
- ✅ Azure Key Vault
- ✅ Google Cloud Secret Manager

**Development:**
- ✅ Local filesystem with 0600 permissions
- ✅ Encrypted disk
- ❌ **Never** commit to Git

### 3. Key Rotation

**Schedule:**
- Regular rotation: Every 90 days
- Emergency rotation: Immediately if compromised
- Post-incident: After security breach

**Process:**
1. Generate new keypair
2. Update verifier registry
3. Deploy new private key to issuer
4. Verify end-to-end
5. Revoke old key on-chain

### 4. Access Control

- ✅ Limit access to private keys (need-to-know basis)
- ✅ Enable audit logging for key access
- ✅ Use role-based access control (RBAC)
- ✅ Require multi-factor authentication (MFA)
- ❌ **Never** share keys between team members

### 5. Monitoring

**Alert on:**
- Private key file access
- Failed key load attempts
- Low entropy key detection (should never happen)
- Deprecated `keyFromSeed()` usage in production

---

## Troubleshooting

### Error: "Private key path is required"

**Cause:** No `ISSUER_PRIVATE_KEY` environment variable set

**Solution:**
```bash
# Generate keypair if you don't have one
npm run generate-keypair -- YourOrgName ./keys

# Set environment variable
export ISSUER_PRIVATE_KEY=./keys/YourOrgName-private.pem

# Restart issuer service
npm run dev
```

### Error: "Low entropy key detected"

**Cause:** Private key has insufficient randomness (entropy < 4.0)

**Possible reasons:**
- Key was derived from predictable value
- Key was manually created
- Key file corrupted

**Solution:**
```bash
# Generate a new secure keypair
npm run generate-keypair -- YourOrgName ./keys/new

# Update configuration
export ISSUER_PRIVATE_KEY=./keys/new/YourOrgName-private.pem
```

### Error: "keyFromSeed() is FORBIDDEN in production"

**Cause:** Attempted to use deprecated `keyFromSeed()` in production

**Solution:**
- This is a security protection - do NOT bypass it
- Generate secure keys using the tool
- Never use predictable key derivation

---

## Compliance Checklist

Before deploying to production:

- [ ] All issuers have cryptographically generated keys (via `generate-keypair`)
- [ ] All private keys stored in secure key management system
- [ ] All public keys added to verifier's issuer registry
- [ ] Entropy validation enabled (minimum 4.0 bits)
- [ ] `keyFromSeed()` never called in production code
- [ ] Private keys have 0600 file permissions (if stored on disk)
- [ ] Keys not committed to version control (.gitignore configured)
- [ ] Key rotation schedule established (90 days)
- [ ] Key access audit logging enabled
- [ ] Emergency key rotation procedure documented
- [ ] All team members trained on key security

---

## Support

For security issues or questions:

- **Do NOT** share private keys in support requests
- **Do NOT** post private keys in issue trackers
- **Do** describe the issue without revealing sensitive data
- **Do** contact security team directly for key compromise

---

## References

- [NIST SP 800-57: Key Management Recommendation](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)
- [Elliptic Curve Cryptography (ECC)](https://en.wikipedia.org/wiki/Elliptic-curve_cryptography)
- [Shannon Entropy](https://en.wikipedia.org/wiki/Entropy_(information_theory))

---

**Last Updated**: 2026-02-03
**Version**: 1.0
**Status**: Production-Ready
