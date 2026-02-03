# BioPassport Verifier Setup Guide

## ⚠️ IMPORTANT: No Mock Data

This verifier uses **REAL** blockchain queries and cryptographic signature verification. All mock implementations have been removed.

## Prerequisites

1. **Compiled Smart Contracts**: The verifier needs access to the contract ABI
2. **Issuer Public Keys**: You must have a registry of issuer public keys
3. **PureChain RPC Access**: Access to a PureChain node
4. **Contract Address**: The deployed BioPassport Registry contract address

## Setup Steps

### 1. Compile Smart Contracts

The verifier needs the contract ABI to interact with the blockchain:

```bash
cd contracts
npx hardhat compile
```

This creates the ABI at: `contracts/artifacts/src/BioPassportRegistry.sol/BioPassportRegistry.json`

### 2. Create Issuer Registry

Create an `issuer-registry.json` file with public keys for all trusted issuers:

```json
{
  "issuers": {
    "Org1MSP": {
      "issuerId": "Org1MSP",
      "publicKey": "04a1b2c3d4...",  // Full hex-encoded public key
      "addedAt": "2026-02-03T00:00:00Z",
      "description": "Research Laboratory A"
    },
    "QCLab": {
      "issuerId": "QCLab",
      "publicKey": "04d4e5f6a7...",  // Full hex-encoded public key
      "addedAt": "2026-02-03T00:00:00Z",
      "description": "Quality Control Laboratory"
    }
  }
}
```

**How to get public keys:**
- If you have the issuer's private key file, extract the public key
- Request public keys from each issuer organization
- Never use predictable or derived keys in production

### 3. Configure Environment Variables

Create a `.env` file or set environment variables:

```bash
# PureChain RPC endpoint (REQUIRED)
RPC_URL=https://purechainnode.com:8547

# Contract address (REQUIRED)
CONTRACT_ADDRESS=0x1234567890abcdef...

# Issuer registry path (REQUIRED)
ISSUER_REGISTRY_PATH=./issuer-registry.json

# Storage configuration
STORAGE_ENDPOINT=localhost
STORAGE_PORT=9000
STORAGE_BUCKET=biopassport
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=minioadmin

# Optional: Trusted issuers (comma-separated)
TRUSTED_ISSUERS=Org1MSP,QCLab
```

### 4. Install Dependencies

```bash
npm install
```

This installs:
- `ethers@^6.9.0` - For blockchain interaction
- `elliptic@^6.5.4` - For signature verification
- `canonicalize@^2.0.0` - For canonical JSON
- `minio@^7.1.0` - For artifact storage

### 5. Verify Setup

Test the verifier configuration:

```bash
npm run verify -- --material bio:cell_line:1
```

## How It Works

### 1. Blockchain Queries (NO MOCKS)

The verifier connects to PureChain and queries:
- **Material details**: Status, owner, metadata hash
- **Credentials**: All credentials for the material
- **Transfers**: Complete transfer history

All queries use `ethers.js` with retry logic for reliability.

### 2. Signature Verification (NO MOCKS)

For each credential:
1. Fetches the issuer's public key from the registry
2. Reconstructs the canonical credential payload
3. Retrieves the signature (from storage or inline)
4. Verifies using ECDSA secp256k1 cryptography

**Result:** `true` only if signature is valid, `false` otherwise

### 3. Artifact Integrity (NO MOCKS)

For artifacts:
1. Downloads from MinIO/S3 storage
2. Computes SHA-256 hash
3. Compares with on-chain hash

**Result:** Files must match exactly or verification fails

## Security Notes

### ❌ What We Removed

1. **Stubbed signature verification** - Previously always returned `true`
2. **Mocked chain queries** - Previously returned `null` or empty arrays
3. **Fake data** - All data now comes from real sources

### ✅ What's Real Now

1. **Cryptographic verification** - Using elliptic curve cryptography
2. **Blockchain queries** - Direct RPC calls to PureChain
3. **Artifact validation** - Real hash comparison
4. **Issuer validation** - Public key lookup and verification

## Troubleshooting

### Error: "Contract ABI not found"

**Solution**: Compile contracts first
```bash
cd contracts && npx hardhat compile
```

### Error: "Public key not found for issuer"

**Solution**: Add issuer to `issuer-registry.json`
- Get the issuer's public key
- Add entry to the registry
- Restart the verifier

### Error: "Contract address is required"

**Solution**: Set `CONTRACT_ADDRESS` environment variable
```bash
export CONTRACT_ADDRESS=0x...
```

### Error: "Failed to query material"

**Possible causes:**
- PureChain RPC endpoint unreachable
- Material doesn't exist on-chain
- Network connectivity issues

**Solution**: Check RPC_URL and network connectivity

### Signature Verification Fails

**Possible causes:**
- Wrong public key in registry
- Credential was signed with different key
- Signature tampering

**Solution**: Verify public key matches the issuer's actual key

## Testing

### Unit Tests

```bash
npm test
```

### Integration Test (with real blockchain)

```bash
# 1. Start local PureChain node (or use testnet)
cd contracts && npx hardhat node

# 2. Deploy contract
npx hardhat run scripts/deploy.ts --network localhost

# 3. Update CONTRACT_ADDRESS in .env

# 4. Register test material and issue credentials via issuer-service

# 5. Verify
npm run verify -- --material bio:cell_line:1 --artifacts
```

## Production Checklist

- [ ] Smart contracts compiled and deployed
- [ ] All issuer public keys added to registry
- [ ] CONTRACT_ADDRESS environment variable set
- [ ] RPC_URL points to production PureChain node
- [ ] Storage credentials configured (MinIO/S3)
- [ ] Issuer registry backed up securely
- [ ] Network connectivity tested
- [ ] Signature verification tested end-to-end
- [ ] No mock data or stub functions remain

## Support

For issues or questions:
- Check logs for detailed error messages
- Verify all configuration is correct
- Ensure blockchain connectivity
- Test with known-good credentials first

---

**Remember:** This verifier uses REAL cryptographic verification and blockchain queries. All data must be authentic.
