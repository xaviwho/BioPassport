#!/usr/bin/env python3
"""
Generate publication-quality plots from BioPassport benchmark results.
Outputs PDF figures suitable for IEEE papers.
"""

import json
import csv
import os
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# Set publication style
plt.rcParams.update({
    'font.family': 'serif',
    'font.size': 10,
    'axes.labelsize': 11,
    'axes.titlesize': 12,
    'legend.fontsize': 9,
    'xtick.labelsize': 9,
    'ytick.labelsize': 9,
    'figure.figsize': (6, 4),
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
})

RESULTS_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(RESULTS_DIR, 'results', 'figures')
os.makedirs(OUTPUT_DIR, exist_ok=True)

def load_report():
    with open(os.path.join(RESULTS_DIR, 'results', 'benchmark-report.json')) as f:
        return json.load(f)

def load_scaling():
    data = {'materials': [], 'verify': [], 'query': []}
    with open(os.path.join(RESULTS_DIR, 'results', 'scaling.csv')) as f:
        reader = csv.DictReader(f)
        for row in reader:
            data['materials'].append(int(row['materials']))
            data['verify'].append(float(row['verify_latency_ms']))
            data['query'].append(float(row['query_latency_ms']))
    return data

def plot_confusion_matrix_heatmap(report):
    """Plot confusion matrix F1 scores as grouped bar chart."""
    fig, ax = plt.subplots(figsize=(8, 4))
    
    anomalies = []
    onchain_f1 = []
    full_f1 = []
    
    for item in report['confusionMatrices']['onChain']:
        anomalies.append(item['anomalyType'].replace('_', '\n'))
        onchain_f1.append(item['confusionMatrix']['f1Score'] * 100)
    
    for item in report['confusionMatrices']['full']:
        full_f1.append(item['confusionMatrix']['f1Score'] * 100)
    
    x = np.arange(len(anomalies))
    width = 0.35
    
    bars1 = ax.bar(x - width/2, onchain_f1, width, label='On-Chain Only', color='#4A90D9', edgecolor='black', linewidth=0.5)
    bars2 = ax.bar(x + width/2, full_f1, width, label='Full Verification', color='#2ECC71', edgecolor='black', linewidth=0.5)
    
    ax.set_ylabel('F1 Score (%)')
    ax.set_xlabel('Anomaly Type')
    ax.set_title('Detection Accuracy by Anomaly Type')
    ax.set_xticks(x)
    ax.set_xticklabels(anomalies)
    ax.set_ylim(0, 110)
    ax.legend(loc='upper right')
    ax.axhline(y=100, color='gray', linestyle='--', alpha=0.5, linewidth=0.5)
    
    # Add value labels
    for bar in bars1:
        height = bar.get_height()
        if height > 0:
            ax.annotate(f'{height:.0f}',
                        xy=(bar.get_x() + bar.get_width() / 2, height),
                        xytext=(0, 3), textcoords="offset points",
                        ha='center', va='bottom', fontsize=7)
    for bar in bars2:
        height = bar.get_height()
        if height > 0:
            ax.annotate(f'{height:.0f}',
                        xy=(bar.get_x() + bar.get_width() / 2, height),
                        xytext=(0, 3), textcoords="offset points",
                        ha='center', va='bottom', fontsize=7)
    
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'confusion_f1_scores.pdf'))
    plt.savefig(os.path.join(OUTPUT_DIR, 'confusion_f1_scores.png'))
    print(f"  Saved: confusion_f1_scores.pdf/png")
    plt.close()

def plot_scaling(scaling_data):
    """Plot O(1) scaling verification."""
    fig, ax = plt.subplots(figsize=(6, 4))
    
    materials = scaling_data['materials']
    verify = scaling_data['verify']
    query = scaling_data['query']
    
    ax.plot(materials, verify, 'o-', label='Verify Material', color='#4A90D9', markersize=8, linewidth=2)
    ax.plot(materials, query, 's--', label='Get History', color='#E74C3C', markersize=8, linewidth=2)
    
    # Add O(n) reference line for comparison
    max_verify = max(verify)
    o_n_line = [max_verify * (m / materials[0]) for m in materials]
    ax.plot(materials, o_n_line, ':', label='O(n) reference', color='gray', linewidth=1, alpha=0.7)
    
    ax.set_xlabel('Number of Materials on Chain')
    ax.set_ylabel('Latency (ms)')
    ax.set_title('Verification Latency vs Chain Size')
    ax.legend(loc='upper left')
    ax.set_xscale('log')
    ax.set_xticks(materials)
    ax.set_xticklabels([str(m) for m in materials])
    ax.set_ylim(0, max(o_n_line) * 1.1)
    ax.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'scaling_o1.pdf'))
    plt.savefig(os.path.join(OUTPUT_DIR, 'scaling_o1.png'))
    print(f"  Saved: scaling_o1.pdf/png")
    plt.close()

def plot_latency_distribution(report):
    """Plot latency distribution boxplot."""
    fig, ax = plt.subplots(figsize=(8, 4))
    
    operations = []
    p50_vals = []
    p95_vals = []
    p99_vals = []
    
    for op_name, stats in report['latency'].items():
        if isinstance(stats, dict) and 'p50' in stats:
            # Clean up operation name
            name = op_name.replace('registerMaterial', 'Register')\
                         .replace('issueCredential', 'Issue Cred')\
                         .replace('initiateTransfer', 'Init Transfer')\
                         .replace('acceptTransfer', 'Accept Transfer')\
                         .replace('verifyMaterialOnChain', 'Verify (Chain)')\
                         .replace('verifyMaterialFull', 'Verify (Full)')
            operations.append(name)
            p50_vals.append(stats['p50'])
            p95_vals.append(stats['p95'])
            p99_vals.append(stats['p99'])
    
    x = np.arange(len(operations))
    width = 0.25
    
    bars1 = ax.bar(x - width, p50_vals, width, label='p50', color='#2ECC71')
    bars2 = ax.bar(x, p95_vals, width, label='p95', color='#F39C12')
    bars3 = ax.bar(x + width, p99_vals, width, label='p99', color='#E74C3C')
    
    ax.set_ylabel('Latency (ms)')
    ax.set_xlabel('Operation')
    ax.set_title('Operation Latency Distribution')
    ax.set_xticks(x)
    ax.set_xticklabels(operations, rotation=45, ha='right')
    ax.legend()
    ax.grid(True, axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'latency_distribution.pdf'))
    plt.savefig(os.path.join(OUTPUT_DIR, 'latency_distribution.png'))
    print(f"  Saved: latency_distribution.pdf/png")
    plt.close()

def plot_baseline_comparison(report):
    """Plot baseline comparison bar chart."""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))
    
    names = []
    latencies = []
    throughputs = []
    security = []
    
    for baseline in report['baselines']:
        name = baseline['name'].replace(' [theoretical]', '*')
        names.append(name)
        latencies.append(baseline['latencyMs']['p50'])
        throughputs.append(baseline['throughputOps'])
        security.append(baseline['securityScore'])
    
    colors = ['#95A5A6', '#F39C12', '#2ECC71']
    
    # Latency comparison
    bars1 = ax1.barh(names, latencies, color=colors, edgecolor='black', linewidth=0.5)
    ax1.set_xlabel('p50 Latency (ms)')
    ax1.set_title('Latency Comparison')
    ax1.invert_yaxis()
    for i, bar in enumerate(bars1):
        ax1.annotate(f'{latencies[i]:.1f}ms',
                    xy=(bar.get_width(), bar.get_y() + bar.get_height()/2),
                    xytext=(3, 0), textcoords="offset points",
                    ha='left', va='center', fontsize=9)
    
    # Security score comparison
    bars2 = ax2.barh(names, security, color=colors, edgecolor='black', linewidth=0.5)
    ax2.set_xlabel('Security Score (%)')
    ax2.set_title('Security Comparison')
    ax2.set_xlim(0, 100)
    ax2.invert_yaxis()
    for i, bar in enumerate(bars2):
        ax2.annotate(f'{security[i]}%',
                    xy=(bar.get_width(), bar.get_y() + bar.get_height()/2),
                    xytext=(3, 0), textcoords="offset points",
                    ha='left', va='center', fontsize=9)
    
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'baseline_comparison.pdf'))
    plt.savefig(os.path.join(OUTPUT_DIR, 'baseline_comparison.png'))
    print(f"  Saved: baseline_comparison.pdf/png")
    plt.close()

def plot_ablation_study(report):
    """Plot ablation study results."""
    fig, ax = plt.subplots(figsize=(7, 4))
    
    names = []
    baseline_rates = []
    ablated_rates = []
    
    for ablation in report['ablations']:
        names.append(ablation['name'])
        baseline_rates.append(ablation['baselinePassRate'] * 100)
        ablated_rates.append(ablation['ablatedPassRate'] * 100)
    
    x = np.arange(len(names))
    width = 0.35
    
    bars1 = ax.bar(x - width/2, baseline_rates, width, label='Full BioPassport', color='#2ECC71', edgecolor='black', linewidth=0.5)
    bars2 = ax.bar(x + width/2, ablated_rates, width, label='Feature Disabled', color='#E74C3C', edgecolor='black', linewidth=0.5)
    
    # Add delta annotations
    for i, (base, ablated) in enumerate(zip(baseline_rates, ablated_rates)):
        delta = ablated - base
        ax.annotate(f'+{delta:.1f}%\nfalse accepts',
                    xy=(x[i] + width/2, ablated),
                    xytext=(0, 5), textcoords="offset points",
                    ha='center', va='bottom', fontsize=8, color='#E74C3C', fontweight='bold')
    
    ax.set_ylabel('Pass Rate (%)')
    ax.set_xlabel('Security Feature')
    ax.set_title('Ablation Study: Impact of Disabling Security Features')
    ax.set_xticks(x)
    ax.set_xticklabels(names)
    ax.legend(loc='upper left')
    ax.set_ylim(0, 60)
    ax.grid(True, axis='y', alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'ablation_study.pdf'))
    plt.savefig(os.path.join(OUTPUT_DIR, 'ablation_study.png'))
    print(f"  Saved: ablation_study.pdf/png")
    plt.close()

def plot_throughput(report):
    """Plot throughput vs concurrency."""
    fig, ax = plt.subplots(figsize=(6, 4))
    
    concurrency = []
    ops_per_sec = []
    
    for item in report['throughput']:
        concurrency.append(item['concurrency'])
        ops_per_sec.append(item['opsPerSecond'])
    
    ax.plot(concurrency, ops_per_sec, 'o-', color='#4A90D9', markersize=10, linewidth=2)
    ax.fill_between(concurrency, ops_per_sec, alpha=0.2, color='#4A90D9')
    
    ax.set_xlabel('Concurrent Clients')
    ax.set_ylabel('Operations per Second')
    ax.set_title('Throughput vs Concurrency')
    ax.set_xticks(concurrency)
    ax.grid(True, alpha=0.3)
    
    # Annotate peak
    max_idx = np.argmax(ops_per_sec)
    ax.annotate(f'Peak: {ops_per_sec[max_idx]:.1f} ops/s',
                xy=(concurrency[max_idx], ops_per_sec[max_idx]),
                xytext=(10, 10), textcoords="offset points",
                fontsize=9, fontweight='bold',
                arrowprops=dict(arrowstyle='->', color='gray'))
    
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'throughput.pdf'))
    plt.savefig(os.path.join(OUTPUT_DIR, 'throughput.png'))
    print(f"  Saved: throughput.pdf/png")
    plt.close()

def main():
    print("=" * 60)
    print("  BIOPASSPORT BENCHMARK PLOT GENERATOR")
    print("=" * 60)
    
    print("\nLoading data...")
    report = load_report()
    scaling = load_scaling()
    
    print(f"\nGenerating plots to: {OUTPUT_DIR}")
    
    plot_confusion_matrix_heatmap(report)
    plot_scaling(scaling)
    plot_latency_distribution(report)
    plot_baseline_comparison(report)
    plot_ablation_study(report)
    plot_throughput(report)
    
    print("\n" + "=" * 60)
    print("  PLOTS GENERATED")
    print("=" * 60)
    print(f"\nOutput directory: {OUTPUT_DIR}")
    print("\nGenerated files:")
    print("  - confusion_f1_scores.pdf/png")
    print("  - scaling_o1.pdf/png")
    print("  - latency_distribution.pdf/png")
    print("  - baseline_comparison.pdf/png")
    print("  - ablation_study.pdf/png")
    print("  - throughput.pdf/png")
    print("\nInclude in LaTeX with:")
    print("  \\includegraphics[width=\\columnwidth]{figures/scaling_o1.pdf}")

if __name__ == '__main__':
    main()
