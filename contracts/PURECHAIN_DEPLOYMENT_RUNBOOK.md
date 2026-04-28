# PureChain Deployment Runbook

Date: 2026-04-22

This runbook deploys the edge-attestation-enabled `BioPassportRegistry` to PureChain and runs a live attestation smoke test against the deployed address.

## Prerequisites

- A funded PureChain deployer private key.
- PureChain RPC access.
- Contract dependencies installed in `contracts/`.

Do not paste private keys into chat, commits, issue trackers, or markdown files. Keep the key in a local `.env` file or a process environment variable.

## Environment

Create either `contracts/.env` or `issuer-service/.env` locally:

```bash
RPC_URL=https://purechainnode.com:8547
CHAIN_ID=900520900520
PURECHAIN_NETWORK=mainnet
PURECHAIN_PRIVATE_KEY=0x...
```

`contracts/hardhat.config.ts` also accepts `PRIVATE_KEY` for compatibility.

## Deploy

From the repository root:

```bash
cd contracts
npm exec hardhat compile
npm exec hardhat run scripts/deploy-registry.ts --network purechain
```

The deploy script writes:

```text
contracts/deployment.registry.json
```

Copy the printed `BIOPASSPORT_CONTRACT_ADDRESS` into `issuer-service/.env` after deployment.

## Live Edge-Attestation Smoke Test

Run this against the newly deployed address:

```bash
cd contracts
$env:BIOPASSPORT_CONTRACT_ADDRESS="0x..."
npm exec hardhat run scripts/smoke-edge-attestation.ts --network purechain
```

Expected output includes:

```text
Attestation verified:
  credentialId: cred:...
  deviceId: 0x...
  attestationHash: 0x...
  tx: 0x...
```

## Post-Deploy Verification

After the smoke test passes, update:

- `issuer-service/.env`: `CONTRACT_ADDRESS` and `BIOPASSPORT_CONTRACT_ADDRESS`
- `contracts/deployment.registry.json`: keep as an operator artifact, or force-add it only if the team wants the live address committed and it contains no secrets
- `EDGE_ATTESTATION_IMPLEMENTATION_SUMMARY.md`: mark PureChain deployment as complete and include the deployed address/transaction hash

## Current Status

Deployment and live edge-attestation smoke testing are complete.

- Registry: `0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC`
- Deployer: `0xAA3DFc054293Dd3731892A1Ba0366D6e6FB1Ee51`
- Latest smoke credential: `cred:2`
- Latest smoke transaction: `0x285df36dbba1c4e705decc70c69a8350a0325147ae3e326de24f210449702b2b`
