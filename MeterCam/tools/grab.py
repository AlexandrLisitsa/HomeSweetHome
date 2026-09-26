#!/usr/bin/env python3
"""
Collect frames from the camera into a corpus, for tuning and for tests.

    python tools/grab.py --config config.json --meter gas --every 300 --count 288
    python tools/grab.py --config config.json --meter gas --once

Point it at the meter and leave it running for a day. The value is in the
frames you would not have thought to take: dusk, the hour the kitchen light is
on, the morning sun across the dial. Those are the frames that decide whether
this works in February, and they cannot be reconstructed later.

Files land in corpus/<meter>/<timestamp>.jpg. Write the true dial reading into
the matching .txt and tests/test_reader.py will check against it -- that is the
only way a corpus becomes a test rather than a pile of pictures.

Stdlib plus the service's own capture(), so this runs on the workstation
without installing the container's dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from service.reader import capture  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--meter", default="gas")
    ap.add_argument("--out", default="corpus")
    ap.add_argument("--every", type=float, default=300.0, help="seconds")
    ap.add_argument("--count", type=int, default=0, help="0 means forever")
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)

    with open(args.config, encoding="utf-8") as fh:
        cam = json.load(fh)["meters"][args.meter]["camera"]

    directory = pathlib.Path(args.out) / args.meter
    directory.mkdir(parents=True, exist_ok=True)

    limit = 1 if args.once else args.count
    taken = 0
    while True:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = directory / ("%s.jpg" % stamp)
        try:
            blob = capture(cam)
            with open(path, "wb") as fh:
                fh.write(blob)
            taken += 1
            print("%s  %7d B  %s" % (stamp, len(blob), path))
        except Exception as exc:        # noqa: BLE001
            # A grab loop that dies overnight on one timeout has collected
            # nothing by morning, which is the one outcome that wastes a day.
            print("%s  FAILED  %s: %s" % (stamp, type(exc).__name__, exc),
                  file=sys.stderr)

        if limit and taken >= limit:
            break
        try:
            time.sleep(args.every)
        except KeyboardInterrupt:
            break

    print("\n%d frames in %s" % (taken, directory))
    print("Write the true reading into <name>.txt beside each frame you want "
          "tests/test_reader.py to check.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
