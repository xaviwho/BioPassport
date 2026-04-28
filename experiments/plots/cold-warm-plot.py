import glob
import json
import matplotlib.pyplot as plt
import numpy as np

latest = sorted(glob.glob('experiments/results/upgraded/bench-upgraded-*.json'))[-1]
data = json.load(open(latest))

ops = list(data['report'].keys())
cold = [data['report'][o]['coldOnly']['meanMs'] for o in ops]
warm = [data['report'][o]['warmOnly']['meanMs'] for o in ops]

x = np.arange(len(ops))
w = 0.35
fig, ax = plt.subplots(figsize=(8, 4))
ax.bar(x - w / 2, cold, w, label='Cold (first 20)')
ax.bar(x + w / 2, warm, w, label='Warm (steady-state)')
ax.set_xticks(x)
ax.set_xticklabels(ops, rotation=20, ha='right')
ax.set_ylabel('Mean latency (ms)')
ax.set_title('Cold-start vs. steady-state per operation')
ax.legend()
plt.tight_layout()
plt.savefig('experiments/results/cold-vs-warm.pdf', dpi=200)
plt.savefig('experiments/results/cold-vs-warm.png', dpi=200)
print('Wrote cold-vs-warm.{pdf,png}')
