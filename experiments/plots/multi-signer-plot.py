import collections
import glob
import json
import os

import matplotlib.pyplot as plt

files = sorted(glob.glob('experiments/results/multi-signer/multi-signer-scaling-s*.json'))
if not files:
    raise SystemExit('No multi-signer result files found in experiments/results/multi-signer/')

by_sig = collections.defaultdict(list)
for path in files:
    payload = json.load(open(path, 'r', encoding='utf-8'))
    for row in payload.get('results', []):
        by_sig[row['signers']].append(row)

fig, ax = plt.subplots(figsize=(7.5, 4.5))
for sig, rows in sorted(by_sig.items()):
    rows.sort(key=lambda r: r['concurrency'])
    ax.plot(
        [r['concurrency'] for r in rows],
        [r['opsPerSec'] for r in rows],
        'o-',
        linewidth=2,
        markersize=6,
        label=f'{sig} signer{"s" if sig > 1 else ""}',
    )

ax.set_xlabel('Concurrent clients')
ax.set_ylabel('Throughput (ops/s)')
ax.set_title('Besu Clique Throughput vs. Signer Count')
ax.legend()
ax.grid(True, alpha=0.3)
plt.tight_layout()

out_dir = 'experiments/results/multi-signer'
os.makedirs(out_dir, exist_ok=True)
plt.savefig(f'{out_dir}/multi-signer-scaling.pdf', dpi=200)
plt.savefig(f'{out_dir}/multi-signer-scaling.png', dpi=200)
print('Wrote experiments/results/multi-signer/multi-signer-scaling.{pdf,png}')
