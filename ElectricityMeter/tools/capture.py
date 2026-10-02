#!/usr/bin/env python3
"""
Record a golden capture: every raw sample the board takes, straight to CSV.

    python ElectricityMeter/tools/capture.py --host <board-ip> --label boiler --minutes 20

Stop early by creating the stop file the tool names when it starts (or with
Ctrl+C); either way the footer is written and the file is complete.

Changes nothing: it only reads the board's /samples endpoint and, when
HomeAssistant/secrets.env is there, a few of Home Assistant's power sensors.

WHAT IT WRITES, into ElectricityMeter/data/golden/:

  <date>-<time>-<label>.csv      seq,value -- one row per sample, in order.
                                  Sample n was taken n * interval_ms after
                                  the first. '#' lines are metadata: a header,
                                  a note wherever the board reports a missed
                                  slot (so the row before and after it are
                                  NOT one interval apart), and a footer.
  <date>-<time>-<label>.ha.csv   wall_time,<entity>,... -- Home Assistant's
                                  power readings every few seconds, for
                                  cross-checking the blink rate. Only covers
                                  what the inverter sees, which need not be
                                  the whole meter.

Read it with pandas.read_csv(path, comment='#').

The tool refuses to paper over loss. A hole in the sequence it receives (the
board's ring overwrote samples before we fetched them) and a slot the board
itself missed are both written into the file where they happened and counted
in the footer.
"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / 'ElectricityMeter' / 'data' / 'golden'
HA_ENV = ROOT / 'HomeAssistant' / 'secrets.env'
HA_ENTITIES = [
    'sensor.powmr_inverter_grid_real_power_calculated',
    'sensor.powmr_inverter_ac_output_power',
]
HA_EVERY_S = 5
POLL_S = 0.25


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec='milliseconds')


def fetch(host, since):
    with urllib.request.urlopen(f'http://{host}/samples?since={since}', timeout=5) as r:
        return json.load(r)


def ha_reader():
    """Return a function that reads HA_ENTITIES, or None if there is no token."""
    if not HA_ENV.exists():
        return None
    env = {}
    for line in HA_ENV.read_text(encoding='utf-8').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"\'')
    url, token = env.get('HA_URL'), env.get('HA_TOKEN')
    if not url or not token:
        return None

    def read():
        values = []
        for entity in HA_ENTITIES:
            req = urllib.request.Request(f'{url}/api/states/{entity}',
                                         headers={'Authorization': f'Bearer {token}'})
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    values.append(json.load(r)['state'])
            except Exception:
                values.append('')
        return values

    return read


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--host', required=True, help="the board's IP address")
    ap.add_argument('--label', required=True, help='what is going on, e.g. boiler, idle')
    ap.add_argument('--minutes', type=float, default=30)
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = dt.datetime.now().strftime('%Y-%m-%d-%H%M') + '-' + args.label
    csv_path = OUT_DIR / f'{stem}.csv'
    ha_path = OUT_DIR / f'{stem}.ha.csv'
    stop_path = OUT_DIR / f'{stem}.stop'

    # Start from what the board is sampling now, not from its ring's past.
    # The board's web server answers one client at a time, so with a phone
    # watching the first request can time out; keep asking for a while.
    for attempt in range(20):
        try:
            j = fetch(args.host, 10**12)
            break
        except Exception as e:
            print(f'board not answering yet ({e}), retrying', file=sys.stderr, flush=True)
            time.sleep(1)
    else:
        sys.exit('board did not answer; is the address right?')
    seq = j['total']
    interval = j['interval']
    missed_at_start = j['missed']
    missed = j['missed']

    read_ha = ha_reader()
    ha_file = None
    if read_ha:
        ha_file = open(ha_path, 'w', encoding='utf-8', newline='\n')
        ha_file.write('wall_time,' + ','.join(HA_ENTITIES) + '\n')
    next_ha = 0.0

    holes = 0
    rows = 0
    errors = 0
    deadline = time.monotonic() + args.minutes * 60
    print(f'recording to {csv_path}', flush=True)
    print(f'stop early with: type nul > "{stop_path}"   (or Ctrl+C)', flush=True)

    with open(csv_path, 'w', encoding='utf-8', newline='\n') as out:
        out.write('# electricity-meter golden capture\n')
        out.write(f'# label: {args.label}\n')
        out.write(f'# started: {now_iso()}  (wall clock, about the first row)\n')
        out.write(f'# interval_ms: {interval}\n')
        out.write(f'# board_seq_at_start: {seq}  board_uptime_ms: {j["up"]}  rssi_dbm: {j["rssi"]}\n')
        out.write(f'# board_missed_before_start: {missed_at_start}\n')
        out.write('seq,value\n')
        try:
            while time.monotonic() < deadline and not stop_path.exists():
                if read_ha and time.monotonic() >= next_ha:
                    next_ha = time.monotonic() + HA_EVERY_S
                    ha_file.write(now_iso() + ',' + ','.join(read_ha()) + '\n')
                    ha_file.flush()
                try:
                    j = fetch(args.host, seq)
                except Exception as e:
                    errors += 1
                    out.write(f'# {now_iso()} request failed: {e}\n')
                    time.sleep(POLL_S)
                    continue
                if j['total'] < seq:
                    out.write(f'# {now_iso()} BOARD RESTARTED, capture stops here\n')
                    print('board restarted; stopping', file=sys.stderr)
                    break
                if j['from'] != seq:
                    holes += j['from'] - seq
                    out.write(f'# HOLE: seq {seq}..{j["from"] - 1} lost before it was fetched\n')
                if j['missed'] != missed:
                    out.write(f'# MISSED: board skipped {j["missed"] - missed} slot(s) '
                              f'somewhere before seq {j["seq"]}\n')
                    missed = j['missed']
                first = j['from']
                out.write(''.join(f'{first + i},{v}\n' for i, v in enumerate(j['v'])))
                rows += len(j['v'])
                seq = j['seq']
                out.flush()
                if j['seq'] >= j['total']:
                    time.sleep(POLL_S)
        except KeyboardInterrupt:
            pass
        out.write(f'# ended: {now_iso()}\n')
        out.write(f'# rows: {rows}  seconds: {rows * interval / 1000:.1f}\n')
        out.write(f'# board_missed_during_capture: {missed - missed_at_start}\n')
        out.write(f'# holes_in_sequence: {holes}  request_errors: {errors}\n')
        out.write(f'# board_longest_gap_since_boot_ms: {j["gap"] / 1000:.2f}\n')

    if ha_file:
        ha_file.close()
    if stop_path.exists():
        stop_path.unlink()
    print(f'{rows} samples ({rows * interval / 1000:.0f} s), '
          f'missed {missed - missed_at_start}, holes {holes}, request errors {errors}')


if __name__ == '__main__':
    main()
