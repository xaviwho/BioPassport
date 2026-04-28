from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

plt.rcParams.update(
    {
        "font.size": 11,
        "font.weight": "bold",
        "axes.labelweight": "bold",
        "axes.titleweight": "bold",
        "axes.titlesize": 13,
        "axes.labelsize": 11,
        "legend.fontsize": 10,
        "xtick.labelsize": 10,
        "ytick.labelsize": 10,
    }
)


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"


def format_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes // (1024 * 1024)} MB"
    if num_bytes >= 1024:
        return f"{num_bytes // 1024} KB"
    return f"{num_bytes} B"


def main():
    latest = sorted((RESULTS / "e2e-latency").glob("e2e-latency-*.json"))[-1]
    payload = json.loads(latest.read_text())
    scenarios = payload["scenarios"]

    rtts = sorted({int(item["rttMs"]) for item in scenarios})
    sizes = sorted({int(item["artifactBytes"]) for item in scenarios})
    x_positions = np.arange(len(rtts))

    fig, ax = plt.subplots(figsize=(6.8, 4.8), constrained_layout=True)
    palette = ["#1f77b4", "#ff7f0e", "#2ca02c"]
    for idx, size in enumerate(sizes):
        totals = []
        for rtt in rtts:
            match = next(item for item in scenarios if int(item["artifactBytes"]) == size and int(item["rttMs"]) == rtt)
            totals.append(match["p50"]["total"])
        ax.plot(
            x_positions,
            totals,
            marker="o",
            linewidth=2.4,
            color=palette[idx % len(palette)],
            label=format_size(size),
        )
    ax.set_title("verifyFullE2E p50 vs RTT")
    ax.set_xlabel("Injected RTT (ms)")
    ax.set_ylabel("Total p50 Latency (ms)")
    ax.set_xticks(x_positions)
    ax.set_xticklabels([str(rtt) for rtt in rtts])
    ax.grid(True, alpha=0.3)
    legend = ax.legend(frameon=False)
    for text in legend.get_texts():
        text.set_fontweight("bold")
    for label in ax.get_xticklabels() + ax.get_yticklabels():
        label.set_fontweight("bold")

    out_pdf = RESULTS / "e2e-latency" / "e2e-latency-summary.pdf"
    out_png = RESULTS / "e2e-latency" / "e2e-latency-summary.png"
    fig.savefig(out_pdf, dpi=300, bbox_inches="tight")
    fig.savefig(out_png, dpi=300, bbox_inches="tight")
    print(f"wrote {out_pdf}")
    print(f"wrote {out_png}")


if __name__ == "__main__":
    main()
