# BioPassport IoT-J Reproducibility Guide

This guide lists the evaluation commands used for the IoT-J submission. Results should be saved under `experiments/results/` and every paper claim should cite a specific JSON or log file.

## Prerequisites

- Node.js 18+
- Docker Desktop or Docker Engine
- Python 3 with `matplotlib`
- `issuer-service/.env` configured with the live PureChain registry
- PureChain registry: `0x22cC5D83D8a62c9cdA5959fd1EDBd1e380996FfC`

## Live PureChain Experiments

```bash
cd experiments
npm install
npm run bench:upgraded -- --reads 1000 --writes 200 --warmup 20 --bootstrap 2000
npm run diagnostics:dataset
npm run security:live
```

## State Growth

Use a dedicated registry to avoid polluting the production/live demo deployment.

```bash
cd contracts
npm exec hardhat run scripts/deploy-registry.ts --network purechain

cd ../experiments
PURECHAIN_SCALING_REGISTRY=0x... npm run scaling:state -- --max 31623 --batch 100
python3 plots/state-growth-plot.py
```

## Cold Start Vs. Warm

```bash
cd experiments
python3 plots/cold-warm-plot.py
```

## RPi 4 Edge Benchmarks

On the Raspberry Pi:

```bash
cd ~/BioPassport/edge-node
npm install
npm run build
SIGNER_TYPE=software npm run bench -- --iterations=1000 > rpi4-software-results.json
```

For TPM:

```bash
SIGNER_TYPE=tpm TPM_HANDLE=0x81010001 npm run bench -- --iterations=1000 > rpi4-tpm-results.json
```

## Energy

Capture a USB power-meter CSV, then analyze from the repo:

```bash
cd experiments/energy
python3 analyze-energy.py --log power-log.csv --iterations 10000 --workload-start <ms> --workload-end <ms>
```

## Reproduce Script

The convenience script runs the core host-side experiments:

```bash
cd experiments
bash reproduce-iotj.sh
```

Hardware and very long-running experiments remain separate so they can be scheduled around device availability.
