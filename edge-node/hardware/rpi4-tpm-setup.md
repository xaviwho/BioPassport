# Raspberry Pi 4 TPM 2.0 Setup

This milestone ships the TPM signer interface and DER-signature plumbing, with public-key ASN.1 extraction intentionally left as a production hardening follow-up.

## Baseline Steps

```bash
sudo apt update
sudo apt install -y tpm2-tools tpm2-abrmd
tpm2_createprimary -C e -G ecc256 -c primary.ctx
tpm2_create -G ecc256 -u dev.pub -r dev.priv -C primary.ctx
tpm2_load -C primary.ctx -u dev.pub -r dev.priv -c dev.ctx
tpm2_evictcontrol -C o -c dev.ctx 0x81010001
```

Enroll the Ethereum address derived from the TPM public key with `enrollDevice(deviceId, deviceAddress, instrumentType)`.

## Benchmark Collection

Run the software-signer baseline on the Pi before wiring the TPM signer:

```bash
cd edge-node
npm install
npm run build
npm run bench -- --iterations=500
```

Record the generated `edge-overhead-*.json` with:

- Raspberry Pi model and RAM size.
- OS image and Node.js version.
- Whether the signer is software, TPM, or secure element backed.
- Optional USB power-meter readings so energy per attestation can be reported.

The current x64 developer-machine benchmark in `EDGE_ATTESTATION_IMPLEMENTATION_SUMMARY.md` is only a baseline sanity check. Do not cite it as edge-device overhead in the paper.
