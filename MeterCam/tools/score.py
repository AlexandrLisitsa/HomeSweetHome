#!/usr/bin/env python3
"""
Score the labelled corpus. The go/no-go before Home Assistant writes anything.

    python tools/score.py                      # every meter in the corpus
    python tools/score.py --meter gas
    python tools/score.py --min-accept-rate 0  # report only, never fail
    python tools/score.py --preprocess none,clahe,green,clahe+green

Collect frames with tools/grab.py, then write the true dial reading into the
.txt beside each one -- or the word "reject" for a frame that is deliberately
bad and whose right answer is a refusal.

WHY THIS EXISTS

Nothing else here can tell you the readings are correct. The gate proves a
reading is plausible, and confirm_samples proves several frames agree -- but
misplaced ROIs give the same plausible, agreed, confident, WRONG number every
time. Only comparing against a reading a human made can see that, and that is
the whole of this script.

THE THRESHOLD

    wrong among accepted        0     <- not 99%, zero
    deliberately-bad accepted   0
    accept rate                >= 10% (24 of 288 daily polls fills hourly bars)

The asymmetry is total, which is why the first number is not a percentage. A
refused frame costs one polling interval. An accepted wrong one books bad
statistics into a total_increasing sensor, and the repair is Developer tools ->
Statistics -> Adjust sum, by hand. So the accept rate is the number allowed to
be mediocre.

CHOOSING THE PREPROCESSING

--preprocess runs the whole corpus once per mode and prints them side by side.
That is the only way the question gets answered: CLAHE and the green channel
both raise contrast and both move the crops away from the distribution
dig-class100 was trained on, and which of those wins is a property of this
meter, this lens and this lighting. It is report-only and picks nothing --
WRONG has to be 0 before an accept rate is worth reading at all.

WHAT IT DOES NOT MEASURE

Each frame is scored on its own, because that is what a corpus is. The live
service takes five and requires agreement, which can only refuse frames this
script accepted -- never the reverse. So a passing score here is a lower bound
on live precision, and the accept rate measured here is an upper bound on the
live one.

Exits non-zero when the threshold is missed, so it can gate a deploy.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))


def label_of(jpg):
    txt = jpg[:-4] + ".txt"
    if not os.path.exists(txt):
        return None
    with open(txt, encoding="utf-8") as fh:
        return fh.read().strip()


def score_pass(meter, models, pairs, decimals, read):
    """Score every labelled frame once, with whatever `meter` says today.

    Pulled out of main() so a run can be repeated under different settings and
    the results compared -- which is the only honest way to choose one. See
    --preprocess.
    """
    accepted = correct = 0
    wrong = []
    bad_accepted = []
    reasons = collections.Counter()

    # Chronological, and each frame is judged against the last TRUE reading
    # before it -- which is what Home Assistant supplies as prevalue. Using
    # the frame's own label would hand the gate the answer.
    prev = None
    for path, want_raw in pairs:
        with open(path, "rb") as fh:
            blob = fh.read()
        out = read(meter, models, image_bytes=blob, prevalue=prev,
                   elapsed_s=meter.get("gate", {}).get("max_delta_window_s"))
        short = os.path.basename(path)

        if want_raw.lower() == "reject":
            if out.get("accepted"):
                bad_accepted.append((short, out.get("value")))
            else:
                reasons[str(out.get("reason")).split(":")[0]] += 1
            continue

        want = float(want_raw)
        if out.get("accepted"):
            accepted += 1
            # The DIAL, not the published value. Labels are what the drums
            # showed, to the meter's full 0.001, and this is the one place
            # that measures the vision rather than the plumbing -- scoring
            # against a value already trimmed by report_decimals would
            # forgive a wrong fast drum and quietly hide the day it starts
            # dragging its neighbour with it.
            got = out.get("dial")
            if got is None:
                got = out.get("value")
            if got is not None and abs(got - want) < 10.0 ** -(decimals + 1):
                correct += 1
            else:
                wrong.append((short, got, want))
        else:
            reasons[str(out.get("reason")).split(":")[0]] += 1
        prev = want

    return {"accepted": accepted, "correct": correct, "wrong": wrong,
            "bad_accepted": bad_accepted, "reasons": reasons}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--config", default=os.environ.get("METERCAM_CONFIG", "config.json"))
    ap.add_argument("--corpus", default="corpus")
    ap.add_argument("--meter", help="score only this meter")
    ap.add_argument("--min-accept-rate", type=float, default=10.0,
                    help="percent; 0 disables the check")
    ap.add_argument("--preprocess", metavar="MODES",
                    help="compare preprocessing modes instead of scoring once, "
                         "e.g. --preprocess none,clahe,green,clahe+green. "
                         "Report only: it changes nothing and fails nothing.")
    args = ap.parse_args(argv)

    root = pathlib.Path(__file__).resolve().parent.parent
    corpus = pathlib.Path(args.corpus)
    if not corpus.is_absolute():
        corpus = root / corpus

    # Corpus first, and the heavy import last. "There are no frames yet" is
    # the common answer and should not need OpenCV in order to be said.
    meters = []
    if corpus.is_dir():
        meters = sorted(p.name for p in corpus.iterdir() if p.is_dir())
    if args.meter:
        meters = [m for m in meters if m == args.meter]
    if not meters:
        print("no corpus under %s" % corpus)
        print("collect some:  python tools/grab.py --config %s --every 300" % args.config)
        return 1

    if not os.path.exists(args.config):
        print("no %s (copy service/config.example.json)" % args.config)
        return 1
    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)

    try:
        from service.reader import ModelCache, read
    except ImportError as exc:
        print("cannot load the reader: %s" % exc)
        print("Scoring needs OpenCV and a TFLite runtime, which live in the")
        print("image rather than on the workstation. Run it where they are:")
        print("  docker compose exec metercam python tools/score.py")
        return 1
    models = ModelCache()

    failed = False

    for name in meters:
        meter = (cfg.get("meters") or {}).get(name)
        if meter is None:
            print("%s: no such meter in %s -- skipping" % (name, args.config))
            continue

        frames = sorted(glob.glob(str(corpus / name / "*.jpg")))
        pairs = [(f, label_of(f)) for f in frames]
        pairs = [(f, l) for f, l in pairs if l]
        if not pairs:
            print("%s: %d frames, none labelled" % (name, len(frames)))
            print("  write the true reading into the .txt beside each one")
            failed = True
            continue

        decimals = meter.get("decimals", 0)
        readable = [(f, l) for f, l in pairs if l.lower() != "reject"]
        bad = [(f, l) for f, l in pairs if l.lower() == "reject"]

        # Which preprocessing? The only honest answer is the one the frames
        # give, so this runs the whole corpus under each mode and prints them
        # side by side. It deliberately does not pick: the numbers that matter
        # here are WRONG (which must be 0) and then accept rate, and a script
        # that optimised one of those on its own would sooner or later trade
        # the other away.
        if args.preprocess:
            modes = [m.strip() for m in args.preprocess.split(",") if m.strip()]
            print("\n%s -- %d labelled frames, %d mode(s)"
                  % (name, len(pairs), len(modes)))
            print("  %-14s %8s %8s %8s %8s" %
                  ("mode", "accept", "correct", "WRONG", "bad-ok"))
            for mode in modes:
                trial = dict(meter)
                trial["preprocess"] = {"mode": mode}
                # Per-ROI settings would override the mode being tested and
                # quietly compare it against itself.
                trial["rois"] = [{k: v for k, v in roi.items()
                                  if k != "preprocess"}
                                 for roi in (meter.get("rois") or [])]
                st = score_pass(trial, models, pairs, decimals, read)
                rate = (100.0 * st["accepted"] / len(readable)) if readable else 0.0
                print("  %-14s %7.1f%% %8d %8d %8d"
                      % (mode, rate, st["correct"], len(st["wrong"]),
                         len(st["bad_accepted"])))
            print("  WRONG must be 0 before accept rate means anything.")
            continue

        stats = score_pass(meter, models, pairs, decimals, read)
        accepted = stats["accepted"]
        correct = stats["correct"]
        wrong = stats["wrong"]
        bad_accepted = stats["bad_accepted"]
        reasons = stats["reasons"]

        n = len(readable)
        rate = (100.0 * accepted / n) if n else 0.0
        print("\n%s -- %d labelled frames (%d readable, %d deliberately bad)"
              % (name, len(pairs), n, len(bad)))
        print("  accepted            %d/%d  (%.1f%%)" % (accepted, n, rate))
        print("  correct             %d" % correct)
        print("  WRONG               %d" % len(wrong))
        print("  bad-frame accepted  %d" % len(bad_accepted))
        if reasons:
            print("  refusals:")
            for why, count in reasons.most_common():
                print("    %-28s %d" % (why, count))
        for short, got, want in wrong:
            print("    WRONG %s: read %s, dial said %s" % (short, got, want))
        for short, got in bad_accepted:
            print("    ACCEPTED A BAD FRAME %s: read %s" % (short, got))

        ok = True
        if wrong:
            ok = False
            print("  FAIL: %d accepted reading(s) disagree with the dial." % len(wrong))
        if bad_accepted:
            ok = False
            print("  FAIL: %d frame(s) labelled 'reject' were accepted."
                  % len(bad_accepted))
        if args.min_accept_rate > 0 and rate < args.min_accept_rate:
            ok = False
            print("  FAIL: accept rate %.1f%% is below %.1f%% -- too few readings"
                  % (rate, args.min_accept_rate))
            print("        to fill the hourly bars this exists to produce.")
        print("  %s" % ("PASS" if ok else "NOT READY"))
        failed = failed or not ok

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
