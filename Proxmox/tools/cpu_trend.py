"""Print the HA guest's CPU trend from Proxmox RRD, against a recorded baseline.

    python Proxmox/tools/cpu_trend.py            # weekly, the whole year
    python Proxmox/tools/cpu_trend.py day        # per-hour, the last day

Reads through tools/pve_get.sh, so it needs Proxmox/secrets.env.

The point of the baseline table is that any measurement taken while somebody is
working on the box measures that person: restarts, log pulls and API polling all
land on the same graph. Compare quiet days with quiet days.
"""
import datetime
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

VMID = 100          # haos17-1
NODE = 'proxmox'

# Weekly means measured 2026-08-28. Steps, not drift - flat plateaus between.
BASELINE = """
  week of 03-30   0.93%   baseline, before the inverter
  week of 04-27   1.59%   +0.60  ESPHome inverter added 04-24 (disk steps too)
  week of 06-22   2.03%   +0.34  CPU up, disk flat - work that never reaches the recorder
  week of 08-24   2.43%   +0.22  IR Bridge energy package, deployed 08-23 (+ my own activity)
"""

# Derived 2026-08-28: CPU tracks state-change rate at ~0.025pp per 1000 writes/h,
# whether or not those changes are recorded to disk. ESPHome 21886/h -> +0.60pp
# and the shims 14291/h -> +0.34pp agree to within 15%.
PREDICTION = """
  Removed 11,262 writes/h on 2026-08-28 (shims 14,291 -> 3,029/h).
  Model predicts -0.28pp, so a quiet day should read ~2.15% against 2.43%.
  Holds   -> the model is good; halving ESPHome telemetry is worth ~0.55pp.
  Doesn't -> the model is wrong and the cost is somewhere not yet measured.
"""


def fetch(timeframe):
    here = Path(__file__).resolve().parent
    out = subprocess.run(
        ['sh', str(here / 'pve_get.sh'),
         f'/nodes/{NODE}/qemu/{VMID}/rrddata?timeframe={timeframe}&cf=AVERAGE'],
        capture_output=True, text=True, encoding='utf-8')
    if out.returncode != 0:
        sys.exit(f"pve_get.sh failed: {out.stderr.strip() or out.stdout.strip()}")
    return [r for r in json.loads(out.stdout)['data'] if r.get('cpu') is not None]


def main(timeframe='year'):
    rows = fetch(timeframe)
    fmt = '%m-%d %H:00' if timeframe in ('day', 'hour') else '%m-%d'
    buckets = defaultdict(list)
    for r in rows:
        t = datetime.datetime.fromtimestamp(r['time'])
        if timeframe in ('day', 'hour'):
            key = t.strftime(fmt)
        else:                                    # week starting Monday
            key = (t - datetime.timedelta(days=t.weekday())).strftime(fmt)
        buckets[key].append((r['cpu'] * 100, (r.get('diskwrite') or 0) / 1024))

    print(f"  {'bucket':13s} {'cpu%':>6s} {'delta':>7s} {'write KB/s':>11s}")
    prev = None
    for k in sorted(buckets):
        v = buckets[k]
        cpu = sum(x[0] for x in v) / len(v)
        dw = sum(x[1] for x in v) / len(v)
        delta = '' if prev is None else f"{cpu - prev:+6.2f}"
        flag = ' <<< STEP' if prev is not None and abs(cpu - prev) > 0.20 else ''
        print(f"  {k:13s} {cpu:5.2f}% {delta:>7s} {dw:10.1f}{flag}")
        prev = cpu

    print("\n-- baseline measured 2026-08-28 --")
    print(BASELINE.rstrip())
    print("\n-- open prediction --")
    print(PREDICTION.rstrip())


if __name__ == '__main__':
    main(*sys.argv[1:2])
