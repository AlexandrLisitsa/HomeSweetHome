"""
Read a meter dial from photographs: align, crop, infer, assemble, confirm, gate.

    python -m service.reader --config config.json --meter gas a.jpg b.jpg

No HTTP and no globals live here. `app.py` owns the routes; this module owns the
arithmetic, so every step is reachable from a test that hands it a JPEG off disk
and never touches the network.

---------------------------------------------------------------------------
Why a digit CNN and not an OCR engine

A mechanical drum caught between positions is not a character. Tesseract and the
general OCR engines are trained on type, so a drum halfway between 6 and 7 comes
back as a confident 6, a confident 7, or nothing -- and it is precisely those
frames that decide whether the reading is right, because on an 8-drum index the
last drum is mid-transition most of the time.

jomjol's `dig-class100` models answer the question the drum actually poses. They
emit 100 classes, one per tenth, so that half-rolled drum reads 6.4 and the
fraction is signal rather than noise. `dig-class11` answers 0-9 plus an explicit
"cannot tell", which is also useful, just coarser. Both are supported below and
the choice is a filename in the config.

---------------------------------------------------------------------------
The carry rule and the gate live next door

`assemble()` and `gate()` are in digits.py, which imports nothing third-party.
That is deliberate: they are the two functions whose failure mode is
irreversible -- a misread that comes out as a DECREASE is taken by Home
Assistant as a meter reset, and correcting the value afterwards does not repair
it -- so they must be testable without OpenCV, numpy or a TFLite runtime
installed. digits.py carries the reasoning; this file only imports them.

---------------------------------------------------------------------------
Alignment

Every ROI is a fixed rectangle, which assumes the camera has not moved. It will
have. `align()` matches ORB features against a stored reference frame and warps
the new frame back onto it, so a nudged bracket costs nothing until it moves
far enough that the dial leaves the frame.

If alignment is enabled and fails, the default is to REJECT rather than fall
back to raw coordinates. Reading the wrong rectangles produces a confident
wrong number, which is worse than no number at all.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import cv2
import numpy as np

# The arithmetic lives in digits.py, which imports nothing third-party, so the
# tests that guard the irreversible failures run on a bare workstation.
from .digits import (align_gate, assemble, confirm_samples, gate,  # noqa: F401  (re-exported)
                     reported_decimals, resolve, truncate)


# ---------------------------------------------------------------------------
# TFLite runtime.
#
# Google renamed TFLite to LiteRT, so the import path depends on which package
# the image ended up with. Try them in order of preference and smallest first;
# full tensorflow works but is a ~600 MB dependency for a 200 KB model.
# ---------------------------------------------------------------------------

def _interpreter_class():
    try:
        from ai_edge_litert.interpreter import Interpreter
        return Interpreter
    except ImportError:
        pass
    try:
        from tflite_runtime.interpreter import Interpreter
        return Interpreter
    except ImportError:
        pass
    try:
        from tensorflow.lite import Interpreter
        return Interpreter
    except ImportError as exc:
        raise RuntimeError(
            "No TFLite runtime found. Install one of: ai-edge-litert, "
            "tflite-runtime, tensorflow"
        ) from exc


# ---------------------------------------------------------------------------
# Decode and orient
# ---------------------------------------------------------------------------

def decode(jpeg_bytes):
    img = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not a decodable image")
    return img


_FLIPS = {"horizontal": 1, "vertical": 0, "both": -1}
_ROTATIONS = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}


def transform(img, cfg):
    """Un-mirror and rotate a frame into reading orientation. Flip, then rotate.

    A mirrored image breaks this pipeline twice over rather than once:

      * the digits are mirrored, and the networks were trained on real drums.
        Only 0, 1 and 8 survive a mirror; 2, 4, 6, 9 become shapes the model has
        never seen and will guess at confidently.

      * the ORDER reverses. The leftmost drum becomes the rightmost, so the
        number assembles backwards -- and digits.resolve() decides each drum
        against the one to its RIGHT, so the carry rule runs the wrong way too.

    Fixed here rather than in the firmware, because this is the one place it
    can be written down, tested and kept in git, and a camera on a bracket may
    well end up rotated. `transform` is null by default, which costs nothing
    when the frame is already the right way up.

    Everything downstream lives in this corrected space: the alignment
    reference and the ROI coordinates. There is no second
    orientation anywhere in the system to get confused about.
    """
    if not cfg:
        return img

    flip = (cfg.get("flip") or "none").lower()
    if flip in _FLIPS:
        img = cv2.flip(img, _FLIPS[flip])
    elif flip != "none":
        raise ValueError("transform.flip %r: expected one of none, %s"
                         % (flip, ", ".join(sorted(_FLIPS))))

    rotate = int(cfg.get("rotate") or 0) % 360
    if rotate:
        if rotate not in _ROTATIONS:
            raise ValueError("transform.rotate %r: expected 0, 90, 180 or 270"
                             % rotate)
        img = cv2.rotate(img, _ROTATIONS[rotate])

    # Fine levelling, separate from `rotate` because it answers a different
    # question. `rotate` is "the camera is mounted sideways" and turns the
    # canvas; `deskew` is "the row of drums is not level in the frame" and
    # keeps it.
    #
    # This matters more than it sounds. Every ROI is an axis-aligned rectangle,
    # so a tilted strip cannot be fitted by any set of them -- a box wide enough
    # to hold a drum at the left is too high for the drum at the right. On the
    # first real frame off this meter the row ran about 3.5 degrees out of
    # level, which put every drum's digit at a different height inside its box,
    # and the model reads height as PHASE: the same digit sitting low reads as
    # "not yet arrived", a fifth of a turn short. It came back uniformly 0.2-0.4
    # low across all eight drums, which looks like a calibration error and is
    # really just a crooked photograph.
    #
    # Positive is counter-clockwise. Level the strip here, then draw the boxes.
    deskew = float(cfg.get("deskew") or 0.0)
    if deskew:
        if not -45.0 <= deskew <= 45.0:
            raise ValueError("transform.deskew %r: expected -45 to 45 degrees; "
                             "use rotate for quarter turns" % deskew)
        h, w = img.shape[:2]
        matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), deskew, 1.0)
        img = cv2.warpAffine(img, matrix, (w, h), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_REPLICATE)

    return img


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def align(img, ref, min_matches=12, max_features=2000):
    """Warp `img` onto `ref` using ORB features. Returns (warped, info)."""
    g1 = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(max_features)
    k1, d1 = orb.detectAndCompute(g1, None)
    k2, d2 = orb.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < min_matches or len(k2) < min_matches:
        return None, {"ok": False, "reason": "too few features"}

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = sorted(matcher.match(d2, d1), key=lambda m: m.distance)
    if len(matches) < min_matches:
        return None, {"ok": False, "reason": "too few matches",
                      "matches": len(matches)}

    src = np.float32([k2[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([k1[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)

    # Partial affine: translation, rotation and uniform scale. A full homography
    # has the freedom to fold a flat dial into a trapezoid on a bad match set,
    # and a camera on a bracket does not need that freedom.
    matrix, inliers = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0
    )
    if matrix is None:
        return None, {"ok": False, "reason": "no transform"}

    n_in = int(inliers.sum()) if inliers is not None else 0
    if n_in < min_matches:
        return None, {"ok": False, "reason": "too few inliers", "inliers": n_in}

    h, w = ref.shape[:2]
    warped = cv2.warpAffine(img, matrix, (w, h), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_REPLICATE)
    dx, dy = float(matrix[0, 2]), float(matrix[1, 2])
    rot = math.degrees(math.atan2(float(matrix[1, 0]), float(matrix[0, 0])))
    return warped, {"ok": True, "inliers": n_in, "matches": len(matches),
                    "dx": round(dx, 1), "dy": round(dy, 1),
                    "rotation_deg": round(rot, 2)}


def crop(img, roi):
    h, w = img.shape[:2]
    x = max(0, int(roi["x"]))
    y = max(0, int(roi["y"]))
    x2 = min(w, x + int(roi["w"]))
    y2 = min(h, y + int(roi["h"]))
    if x2 <= x or y2 <= y:
        raise ValueError("ROI %r lies outside the %dx%d frame" % (roi, w, h))
    return img[y:y2, x:x2]


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------

class DigitModel:
    """One tflite digit classifier, told apart by its filename.

    Input geometry and dtype are read off the interpreter rather than
    hardcoded, because jomjol's families differ (32x20 for the class models,
    32x32 for some others) and a silently mis-sized crop is a silently wrong
    reading.
    """

    def __init__(self, path):
        self.path = path
        name = os.path.basename(path).lower()
        if "class100" in name:
            self.kind = "class100"
        elif "class11" in name:
            self.kind = "class11"
        elif "cont" in name:
            self.kind = "cont"
        else:
            raise ValueError(
                "cannot tell the model family from %r -- expected class100, "
                "class11 or cont in the filename" % name
            )

        self.interp = _interpreter_class()(model_path=path)
        self.interp.allocate_tensors()
        self.inp = self.interp.get_input_details()[0]
        self.out = self.interp.get_output_details()[0]
        _, self.height, self.width, _ = self.inp["shape"]

        # Refuse a model whose output does not match what predict() knows how
        # to decode. Without this the mismatch is silent: a decoder reading two
        # values out of a ten-value tensor returns a number, and a wrong number
        # from a confident-looking pipeline is the worst failure this service
        # has. dig-cont in particular emits 10, not the sin/cos pair its name
        # suggests -- which is exactly how this check earned its place.
        expected = {"class100": 100, "class11": 11, "cont": 10}[self.kind]
        self.outputs = int(self.out["shape"][-1])
        if self.outputs != expected:
            raise ValueError(
                "%s looks like a %s model but emits %d outputs, not %d -- "
                "refusing rather than guessing at the decoding"
                % (name, self.kind, self.outputs, expected)
            )

    def predict(self, bgr):
        """Return (value in [0,10), confidence in [0,1]).

        For class11 an "unreadable" answer comes back as (None, confidence).
        """
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (int(self.width), int(self.height)),
                             interpolation=cv2.INTER_AREA)

        if self.inp["dtype"] == np.float32:
            data = resized.astype(np.float32)
            # jomjol's networks are trained on raw 0-255 floats, not 0-1.
            arr = np.expand_dims(data, 0)
        else:
            scale, zero = self.inp["quantization"]
            arr = resized.astype(np.float32)
            if scale:
                arr = arr / scale + zero
            arr = np.expand_dims(arr.astype(self.inp["dtype"]), 0)

        self.interp.set_tensor(self.inp["index"], arr)
        self.interp.invoke()
        raw = self.interp.get_tensor(self.out["index"])[0].astype(np.float32)

        if self.out["dtype"] != np.float32:
            scale, zero = self.out["quantization"]
            if scale:
                raw = (raw - zero) * scale

        probs = _softmax_if_needed(raw)

        if self.kind == "cont":
            # Ten outputs, one per digit, decoded as a CIRCULAR mean rather than
            # an argmax -- a drum is a wheel, so 9 and 0 are neighbours and
            # averaging them on a line would give 4.5 instead of 9.5.
            #
            # The resultant length falls out as a real confidence: 1 means the
            # distribution is concentrated, 0 means it is spread all the way
            # round and the model has no idea.
            #
            # Inferred from the output shape, not read off jomjol's decoder. If
            # a cont model reads consistently wrong while class100 reads right,
            # this is the first place to look -- which is why class100 is the
            # documented default and this is the alternative.
            x = sum(float(p) * math.cos(2 * math.pi * i / 10.0)
                    for i, p in enumerate(probs))
            y = sum(float(p) * math.sin(2 * math.pi * i / 10.0)
                    for i, p in enumerate(probs))
            value = (math.atan2(y, x) / (2 * math.pi) * 10.0) % 10.0
            return value, min(math.hypot(x, y), 1.0)
        idx = int(np.argmax(probs))

        if self.kind == "class11":
            if idx == 10:
                return None, float(probs[idx])
            return float(idx), float(probs[idx])

        # class100: neighbouring classes are neighbouring drum positions, and
        # class 99 touches class 0. A frame whose mass is split between 99 and 0
        # is a confident reading of "just about to roll over", so confidence is
        # summed over a small circular window rather than taken from one bin.
        window = 2
        conf = float(sum(probs[(idx + k) % 100] for k in range(-window, window + 1)))
        return idx / 10.0, min(conf, 1.0)


def _softmax_if_needed(vec):
    total = float(vec.sum())
    if 0.99 <= total <= 1.01 and float(vec.min()) >= 0.0:
        return vec  # already a distribution
    shifted = vec - vec.max()
    exp = np.exp(shifted)
    return exp / exp.sum()


def to_jpeg(img, quality=85):
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buf.tobytes()


# ---------------------------------------------------------------------------
# The whole read
# ---------------------------------------------------------------------------

class ModelCache(dict):
    """Interpreters are expensive to build and cheap to keep."""

    def get_model(self, path):
        if path not in self:
            self[path] = DigitModel(path)
        return self[path]


def read_once(meter, models, image_bytes, prevalue=None):
    """Interpret ONE frame. No confirmation, no gate.

    Everything up to and including a number: transform, align, crop, infer,
    assemble. Whether to believe that number is `read()`'s business, because
    that decision needs several frames and this one has seen one.
    """
    started = time.time()
    result = {
        # `value` is what Home Assistant is asked to believe and every guard
        # judges; `dial` is the whole index the drums showed. They differ
        # whenever report_decimals stops short of the dial -- see
        # digits.truncate().
        "value": None,
        "dial": None,
        "accepted": False,
        "reason": None,
        "digits": None,
        "raw": None,
        "prevalue": prevalue,
        "delta": None,
        "align": None,
        "confidence": None,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "duration_ms": None,
    }
    # The bytes exactly as the camera sent them, for the archive. Re-encoding
    # the decoded frame would cost a generation of JPEG loss, and archiving it
    # AFTER transform() and the warp would hand anything that re-reads the
    # frame later an image that gets rotated a second time.
    result["_jpeg"] = image_bytes

    # Corrected before anything else looks at it, so the reference frame and
    # the ROI coordinates share one orientation.
    img = transform(decode(image_bytes), meter.get("transform"))
    result["frame_size"] = [int(img.shape[1]), int(img.shape[0])]

    align_cfg = meter.get("align") or {}
    if align_cfg.get("enabled"):
        ref_path = align_cfg.get("reference")
        ref = cv2.imread(ref_path) if ref_path else None
        if ref is None:
            # No reference is a refusal, never a fallback to raw coordinates.
            # Every ROI is a pixel rectangle in the reference's space; read
            # against an unaligned frame they give a confident wrong number,
            # which is worse than none.
            result["align"] = {"ok": False,
                               "reason": "reference missing or unreadable"}
            if align_cfg.get("on_failure", "reject") == "reject":
                result["reason"] = ("align: reference missing or unreadable at %s"
                                    % ref_path)
                return _finish(result, started, img)
        else:
            warped, info = align(img, ref, align_cfg.get("min_matches", 12))
            result["align"] = info

            # Producing a transform and producing a TRUSTWORTHY one are
            # different bars. A frame can match on 21 of 147 features, warp
            # 800 px, and arrive sharp, confident and completely wrong -- see
            # align_gate's docstring.
            ok, why = align_gate(info, align_cfg)
            if not ok:
                info["ok"] = False
                info["reason"] = why
                if align_cfg.get("on_failure", "reject") == "reject":
                    result["reason"] = "align: %s" % why
                    return _finish(result, started, img)
            if warped is not None:
                img = warped

    rois = meter.get("rois") or []
    if not rois:
        result["reason"] = "no ROIs configured"
        return _finish(result, started, img)

    # One model for the whole row by default, overridable per ROI: the first
    # drums are black on white and the last are white on red, which are
    # different enough that they may not want the same network.
    default_model = meter["model"]
    values, confidences = [], []
    for roi in rois:
        model = models.get_model(roi.get("model") or default_model)
        val, conf = model.predict(crop(img, roi))
        values.append(val)
        confidences.append(conf)

    result["confidence"] = {
        "per_drum": [None if c is None else round(c, 3) for c in confidences],
        "min": None,
    }
    result["_confidences"] = confidences
    # What each drum read BEFORE rounding. The fraction is where a box sitting
    # low shows up (reads 5.7 for a 6), which no whole-reading check can see.
    result["drums"] = [None if v is None else round(float(v), 2) for v in values]
    known = [c for c in confidences if c is not None]
    if known:
        result["confidence"]["min"] = round(min(known), 3)

    decimals = meter.get("decimals", 0)
    report = reported_decimals(meter)
    try:
        dial, digits, raw_string = assemble(
            values, decimals, meter.get("counter_type", "continuous"),
            last_down=bool(meter.get("round_last_drum_down")))
        # Every drum is read. The fast ones simply stop deciding anything:
        # they are the drums that made a burst disagree with itself while the
        # boiler was firing, and they resolve their neighbour's phase whether
        # or not they are published.
        value = truncate(dial, decimals, report)
        result["dial"] = dial
        result["value"] = value
        result["digits"] = digits
        result["raw"] = raw_string
        if prevalue is not None:
            result["delta"] = round(value - prevalue, report + 1)
    except ValueError as exc:
        result["reason"] = "assemble: %s" % exc

    return _finish(result, started, img)


def _sample_summary(samples, wanted):
    return {
        "wanted": wanted,
        "taken": len(samples),
        "values": [s.get("value") for s in samples],
    }


def read(meter, models, frames, prevalue=None, elapsed_s=None):
    """Read every frame of one wake, require agreement, then gate. One answer.

        read_once  x N   ->  confirm_samples  ->  gate  ->  accepted
        (each aligned)       (do they agree?)     (is it plausible?)

    `frames` is what the camera pushed in one wake, oldest first. Several
    frames exist because one can be wrong in ways that leave no trace in the
    number -- a flicker, sensor noise, a drum caught mid-tick. Those do not
    repeat, so demanding that the frames agree removes them. It does NOT
    remove a systematic error: misplaced ROIs give the same wrong answer every
    time, confidently. align_gate() is what stands against that.

    Fails fast. A frame that produced no number -- refused alignment, no ROIs
    -- will not do better on the second one, so the burst stops there.

    One frame is still read and archived, but refused while `confirm.samples`
    asks for more than one (`allow_unconfirmed_push: true` accepts it). The
    camera falls back to one frame when a grab fails, and anything on the LAN
    can POST one; neither may skip the agreement check.
    """
    # Compare like with like. A prevalue may carry the whole dial while what
    # is published stops at report_decimals. Untruncated, a 2246.916 prevalue
    # against a 2246.91 reading is a 0.006 DECREASE and tolerance_down is 0.0,
    # so the gate would refuse every frame until the meter passed .92.
    prevalue = truncate(prevalue, meter.get("decimals", 0),
                        reported_decimals(meter))

    confirm_cfg = meter.get("confirm") or {}
    frames = list(frames or [])
    if not frames:
        raise ValueError("no frames to read")
    wanted = len(frames)

    samples = []
    for blob in frames:
        one = read_once(meter, models, blob, prevalue=prevalue)
        samples.append(one)
        if one.get("reason") is not None or one.get("value") is None:
            one["samples"] = _sample_summary(samples, wanted)
            return one

    result = samples[-1]
    result["samples"] = _sample_summary(samples, wanted)

    if wanted > 1:
        ok, why, value = confirm_samples(
            [s.get("value") for s in samples],
            reported_decimals(meter), confirm_cfg)
        if not ok:
            result["accepted"] = False
            result["reason"] = why
            # Every frame of a disagreement is the evidence: which sample
            # differed and what it saw. app.py archives all of them for this
            # case alone.
            result["_frames"] = [s.get("_frame") for s in samples]
            return result
        result["value"] = value
    else:
        result["unconfirmed"] = "single frame supplied; not sampled"
        asked = confirm_cfg.get("samples", 2) or 1
        if asked > 1 and not confirm_cfg.get("allow_unconfirmed_push", False):
            result["accepted"] = False
            result["reason"] = ("unconfirmed: 1 frame pushed, confirm.samples "
                                "asks for %d" % asked)
            return result

    digits = result.get("digits") or []
    accepted, reason = gate(
        result["value"], prevalue, meter.get("gate") or {},
        len(digits), len(meter.get("rois") or []),
        result.get("_confidences") or [], elapsed_s,
    )
    result["accepted"] = accepted
    result["reason"] = reason
    return result


def _finish(result, started, img):
    result["duration_ms"] = int((time.time() - started) * 1000)
    result["_frame"] = img
    return result


# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--meter", default="gas")
    ap.add_argument("--prevalue", type=float)
    ap.add_argument("images", nargs="+", help="the frames of one wake")
    args = ap.parse_args(argv)

    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)
    meter = cfg["meters"][args.meter]

    frames = []
    for path in args.images:
        with open(path, "rb") as fh:
            frames.append(fh.read())

    out = read(meter, ModelCache(), frames, prevalue=args.prevalue)
    out = {k: v for k, v in out.items() if not k.startswith("_")}
    print(json.dumps(out, indent=2))
    return 0 if out["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
