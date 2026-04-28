# BioPassport Edge Node

Instrument Edge Nodes (IENs) bind raw instrument outputs to a device key at capture time. The daemon watches an instrument output directory, hashes each new file, signs the on-chain-compatible attestation digest, and submits the signed payload plus artifact to the issuer service.

## Quick Start

```bash
npm install
npm run build
mkdir keys watch
node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))" > keys/device.key
npm run dev
```

Drop a file into `watch/`. The daemon logs the raw artifact hash, attestation hash, and issuer-service submission result.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `WATCH_DIR` | `./watch` | Directory watched for new instrument outputs |
| `INSTRUMENT_ID` | `microscope-01` | Human-readable instrument identifier |
| `DEVICE_ID` | `device:dev:SN-0001` | Raw device identifier hashed into `deviceId` |
| `DEVICE_KEY_PATH` | `./keys/device.key` | Development-only private key file |
| `ISSUER_URL` | `http://localhost:8080` | Issuer service base URL |
| `MATERIAL_ID` | `bio:cell_line:dev` | Material ID attached to captured files |

The software signer is for development and paper experiments only. Production deployments should provision keys in a TPM or secure element and enroll the derived Ethereum address on-chain.
