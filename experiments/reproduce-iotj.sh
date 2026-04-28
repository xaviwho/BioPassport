#!/usr/bin/env bash
# Reproduces BioPassport IoT-J evaluation experiments that can run from this host.
# Hardware experiments for RPi/TPM/ESP32 are run separately on those devices.
set -euo pipefail

OUTDIR="results/iotj-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTDIR"

echo "[A1] Upgraded latency benchmarks..."
npm exec ts-node -- bench-upgraded.ts --reads 1000 --writes 200 --warmup 20 --bootstrap 2000 | tee "$OUTDIR/A1-bench.log"

echo "[A3] Dataset diagnostics..."
npm exec ts-node -- diagnostics/dataset-composition.ts | tee "$OUTDIR/A3-dataset.log"

echo "[A4] Live attack suite A1-A9..."
npm exec ts-node -- security-tests-live.ts | tee "$OUTDIR/A4-attacks.log"

echo "[F] Cold-vs-warm plot..."
python3 plots/cold-warm-plot.py

echo "[Plots] Generating plots if source JSON exists..."
python3 plots/state-growth-plot.py || true
python3 plots/multi-signer-plot.py || true

cat <<EOF
Done. Results in $OUTDIR

Separate long-running or hardware-dependent experiments:
- A2 state growth: npm run scaling:state -- --max 31623 --batch 100
- B multi-signer Besu scaling: npm exec ts-node -- multi-signer-scaling.ts
- C Postgres baseline: see postgres-baseline/
- D E2E RTT: see e2e-latency/
- E edge hardware: run edge-node benchmarks on RPi/TPM/ESP32
EOF
