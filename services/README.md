# BioPassport V2 Services

Production-ready backend services for the BioPassport biological material provenance system.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        BioPassport V2                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   REST API   │    │   Indexer    │    │ Audit Pack   │       │
│  │  (Express)   │    │  (ethers.js) │    │  Generator   │       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                   │                   │                │
│         └─────────┬─────────┴─────────┬─────────┘                │
│                   │                   │                          │
│            ┌──────▼──────┐    ┌───────▼───────┐                  │
│            │  PostgreSQL │    │   Hardhat/EVM │                  │
│            │   (indexed) │    │  (on-chain)   │                  │
│            └─────────────┘    └───────────────┘                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Smart Contract (`BioPassportV2.sol`)
- **Minimal on-chain storage**: hashes + pointers only
- **Event-driven**: all state changes emit indexed events
- **RBAC**: `ISSUER_ROLE`, `AUDITOR_ROLE`, `ADMIN_ROLE`
- **Functions**: `registerAsset`, `issueCredential`, `openException`, `closeException`

### 2. Indexer (`src/indexer.ts`)
- Listens to blockchain events
- Populates PostgreSQL with indexed data
- Maintains sync state for crash recovery
- Enriches credentials by fetching off-chain JSON

### 3. REST API (`src/api.ts`)
- Acquirer-friendly integration surface
- Full CRUD for assets, credentials, exceptions
- Verification endpoint with detailed checks
- Audit pack generation

### 4. Audit Pack Generator (`src/audit-pack.ts`)
- JSON + PDF output formats
- Complete credential chain with evidence
- Verification results and exception history
- Blockchain proof (tx hashes, block range)

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Hardhat node (for local development)

### 1. Install Dependencies
```bash
cd services
npm install
```

### 2. Setup Database
```bash
# Create database
createdb biopassport

# Run migrations
psql biopassport -f schema.sql
```

### 3. Configure Environment
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 4. Deploy Contract
```bash
cd ../contracts
npx hardhat node &
npx hardhat run scripts/deploy.ts --network localhost
# Copy deployed address to .env CONTRACT_ADDRESS
```

### 5. Start Services
```bash
# Terminal 1: Start indexer
npm run indexer

# Terminal 2: Start API
npm run api
```

## API Endpoints

### Assets
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/assets` | Register new asset |
| GET | `/assets/:id` | Get asset details |
| GET | `/assets/:id/credentials` | Get credential chain |

### Credentials
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/credentials` | Issue credential |
| GET | `/credentials/:hash` | Get credential details |

### Verification
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/verify` | Verify credential/asset |

### Exceptions
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/exceptions` | Open exception |
| POST | `/exceptions/:id/close` | Close exception |
| GET | `/exceptions` | List exceptions |

### Audit
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/audit-pack/:assetId` | Generate audit pack |

## Credential Payload Schema

```json
{
  "schema_version": "1.0",
  "asset_id": "ASSET-123",
  "credential_type": "COA|QC|SHIPMENT|INTAKE|CHAIN_OF_CUSTODY",
  "issuer_org": "LabCorp",
  "issued_at": "2026-01-13T10:00:00Z",
  "subject": {
    "lot": "L-88",
    "vendor": "VEND-X"
  },
  "evidence": [
    { "uri": "s3://bucket/coa.pdf", "sha256": "abc123..." },
    { "uri": "s3://bucket/temp.csv", "sha256": "def456..." }
  ],
  "prev_credential_hash": "0x...",
  "notes": "optional"
}
```

## Evidence Root Computation

```typescript
// Sort evidence file hashes, concatenate, then keccak256
const hashes = evidence.map(e => e.sha256).sort();
const evidenceRoot = keccak256(concat(hashes));
```

## Exception Reason Codes

| Code | Reason |
|------|--------|
| 1 | HASH_MISMATCH |
| 2 | EVIDENCE_MISSING |
| 3 | CHAIN_BREAK |
| 4 | EXPIRED_CREDENTIAL |
| 5 | REVOKED_ISSUER |
| 6 | TAMPERED_EVIDENCE |
| 7 | OTHER |

## Audit Pack Output

The audit pack provides:
- **Asset summary**: ID, registrar, creation time
- **Credential chain**: ordered list with hashes and evidence
- **Verification results**: pass/fail with detailed checks
- **Exception history**: open/closed with resolution
- **Chain proof**: contract address, block range, tx hashes

## Security

- All credentials are hash-linked (prev_credential_hash)
- Evidence files have SHA-256 integrity verification
- On-chain events provide immutable audit trail
- OpenZeppelin AccessControl for role management

## Development

```bash
# Run tests
npm test

# Build TypeScript
npm run build

# Development mode (hot reload)
npm run dev
```

## License

MIT
