import glob
import json
from pathlib import Path

import matplotlib.pyplot as plt

plt.rcParams.update(
    {
        'font.size': 11,
        'font.weight': 'bold',
        'axes.labelweight': 'bold',
        'axes.titleweight': 'bold',
        'axes.titlesize': 13,
        'axes.labelsize': 11,
        'legend.fontsize': 10,
        'xtick.labelsize': 10,
        'ytick.labelsize': 10,
    }
)

base = Path(__file__).resolve().parents[1]
candidates = sorted(base.glob('results/scaling-state-growth-*.json'))
if not candidates:
    raise SystemExit('No scaling-state-growth-*.json files found under experiments/results')

latest = candidates[-1]
data = json.load(open(latest))
sizes = [d['registrySize'] for d in data]
v50 = [d['verifyOnChain']['p50'] for d in data]
v99 = [d['verifyOnChain']['p99'] for d in data]
h50 = [d['getHistory']['p50'] for d in data]

fig, ax = plt.subplots(figsize=(6, 4))
ax.semilogx(sizes, v50, 'o-', label='verifyMaterial p50', linewidth=2.2)
ax.semilogx(sizes, v99, 's--', label='verifyMaterial p99', linewidth=2.0, alpha=0.8)
ax.semilogx(sizes, h50, '^-', label='getHistory p50', color='C2', linewidth=2.2)
ax.set_xlabel('Number of registered materials')
ax.set_ylabel('Latency (ms)')
ax.set_title('Verification latency vs. registry size')
ax.set_ylim(0, 80)
legend = ax.legend(frameon=False)
for text in legend.get_texts():
    text.set_fontweight('bold')
ax.grid(True, alpha=0.3)
for label in ax.get_xticklabels() + ax.get_yticklabels():
    label.set_fontweight('bold')
plt.tight_layout()
plt.savefig(base / 'results' / 'state-growth.pdf', dpi=200)
plt.savefig(base / 'results' / 'state-growth.png', dpi=200)
print('Wrote state-growth.{pdf,png}')
