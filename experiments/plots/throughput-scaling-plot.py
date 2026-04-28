from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt

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


def load_latest_multi_account():
    latest_by_accounts = {}
    for path in sorted((RESULTS / "multi-account").glob("multi-account-throughput-*.json")):
        payload = json.loads(path.read_text())
        accounts = int(payload["summary"]["accounts"])
        latest_by_accounts[accounts] = payload
    return dict(sorted(latest_by_accounts.items()))


def load_latest_multi_signer():
    latest_by_signers = {}
    for path in sorted((RESULTS / "multi-signer").glob("multi-signer-scaling-s*.json")):
        payload = json.loads(path.read_text())
        signers = int(payload["signers"])
        latest_by_signers[signers] = payload
    return dict(sorted(latest_by_signers.items()))


def main():
    multi_account = load_latest_multi_account()
    multi_signer = load_latest_multi_signer()

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), constrained_layout=True)
    y_max = 5.0

    ax = axes[0]
    ks = list(multi_account.keys())
    ops = [multi_account[k]["summary"]["aggregateOpsPerSec"] for k in ks]
    ax.plot(ks, ops, marker="o", linewidth=2.2, color="#1f77b4")
    ax.set_title("PureChain Multi-Account Scaling")
    ax.set_xlabel("Concurrent Issuer Accounts (K)")
    ax.set_ylabel("Aggregate Throughput (ops/s)")
    ax.set_xticks(ks)
    ax.set_ylim(0, y_max)
    ax.grid(True, alpha=0.3)
    for k, ops_per_s in zip(ks, ops):
        ax.annotate(
            f"{ops_per_s:.2f} ops/s",
            (k, ops_per_s),
            textcoords="offset points",
            xytext=(0, 8),
            ha="center",
            fontsize=9,
            fontweight="bold",
        )
    for label in ax.get_xticklabels() + ax.get_yticklabels():
        label.set_fontweight("bold")

    ax = axes[1]
    palette = ["#d62728", "#2ca02c", "#9467bd", "#ff7f0e"]
    signers = list(multi_signer.keys())
    concurrency_levels = sorted(
        {int(result["concurrency"]) for payload in multi_signer.values() for result in payload["results"]}
    )
    for idx, concurrency in enumerate(concurrency_levels):
        ops = []
        for signer in signers:
            results = multi_signer[signer]["results"]
            match = next(item for item in results if int(item["concurrency"]) == concurrency)
            ops.append(match["opsPerSec"])
        ax.plot(
            signers,
            ops,
            marker="o",
            linewidth=2.0,
            color=palette[idx % len(palette)],
            label=f"C={concurrency}",
        )
    ax.set_title("Besu Clique Multi-Signer Scaling")
    ax.set_xlabel("Validator Signers (N)")
    ax.set_ylabel("Aggregate Throughput (ops/s)")
    ax.set_xticks(signers)
    ax.set_ylim(0, y_max)
    ax.grid(True, alpha=0.3)
    legend = ax.legend(frameon=False, ncol=2)
    for text in legend.get_texts():
        text.set_fontweight("bold")
    for label in ax.get_xticklabels() + ax.get_yticklabels():
        label.set_fontweight("bold")

    out_pdf = RESULTS / "throughput-scaling-combined.pdf"
    out_png = RESULTS / "throughput-scaling-combined.png"
    fig.savefig(out_pdf, dpi=300, bbox_inches="tight")
    fig.savefig(out_png, dpi=300, bbox_inches="tight")
    print(f"wrote {out_pdf}")
    print(f"wrote {out_png}")


if __name__ == "__main__":
    main()
