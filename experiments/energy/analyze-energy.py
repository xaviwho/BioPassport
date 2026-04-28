"""
Compute energy per attestation from a USB power meter CSV log.

Expected CSV columns: timestamp_ms, voltage_v, current_a, power_w
"""
import argparse
import csv

ap = argparse.ArgumentParser()
ap.add_argument('--log', required=True)
ap.add_argument('--iterations', type=int, required=True)
ap.add_argument('--workload-start', type=int, required=True)
ap.add_argument('--workload-end', type=int, required=True)
args = ap.parse_args()

idle_pre, workload, idle_post = [], [], []
with open(args.log) as f:
    for row in csv.DictReader(f):
        ts = int(row['timestamp_ms'])
        p_w = float(row['power_w'])
        if ts < args.workload_start:
            idle_pre.append(p_w)
        elif ts <= args.workload_end:
            workload.append(p_w)
        else:
            idle_post.append(p_w)

if not workload:
    raise SystemExit('No workload samples found in the requested time window')
if not idle_pre and not idle_post:
    raise SystemExit('No idle samples found before or after the workload window')

idle_avg = (sum(idle_pre) + sum(idle_post)) / (len(idle_pre) + len(idle_post))
workload_avg = sum(workload) / len(workload)
duration_s = (args.workload_end - args.workload_start) / 1000.0
total_energy_j = workload_avg * duration_s
idle_energy_j = idle_avg * duration_s
attestation_energy_j = (total_energy_j - idle_energy_j) / args.iterations

print(f"Idle power:        {idle_avg * 1000:.1f} mW")
print(f"Workload power:    {workload_avg * 1000:.1f} mW")
print(f"Duration:          {duration_s:.1f} s")
print(f"Total energy:      {total_energy_j:.2f} J ({total_energy_j * 1000:.0f} mJ)")
print(f"Idle baseline:     {idle_energy_j:.2f} J")
print(f"Per attestation:   {attestation_energy_j * 1000:.2f} mJ ({attestation_energy_j * 1000000:.0f} uJ)")

mAh_capacity = 10000
mAh_used_per_attestation = attestation_energy_j / 5.0 / 3.6
attestations_per_battery = mAh_capacity / mAh_used_per_attestation
print(f"\n10000 mAh battery: {attestations_per_battery:.0f} attestations")
print(f"At 1/hour: {attestations_per_battery / 24:.0f} days of operation")
