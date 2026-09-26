"""
Read a meter dial from a photograph: capture, align, crop, infer, assemble, gate.

    python -m service.reader --config config.json --meter gas
    python -m service.reader --config config.json --meter gas --image corpus/x.jpg

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
the new frame back onto it, so a nudged phone or a drifting bracket costs
nothing until it moves far enough that the dial leaves the frame.

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
import urllib.error
import urllib.request

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
# Capture
# ---------------------------------------------------------------------------

def fetch(url, timeout=15, method=None, body=None):
    """Call a URL and return the body. stdlib only, matching dtek_poll.py.

    A GET unless asked otherwise, because that is what a phone's control
    endpoints answer to. ESPHome does not: its REST API acts on POST and
    ignores a GET, so the torch on an ESP32-CAM node cannot be switched
    without this. See `_call` and the camera block in config.example.json.
    """
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(
        url, data=data, method=method, headers={"User-Agent": "MeterCam/1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _call(entry, timeout):
    """One entry from `prepare_urls`, or a torch URL.

    A bare string is a GET, which is every URL this config has ever held. An
    object is the way to say otherwise:

        {"url": "http://cam/light/gas_cam_flash/turn_on?brightness=128",
         "method": "POST"}

    Kept to those two shapes on purpose. The moment this grows headers and
    auth it stops being a camera config and starts being an HTTP client
    somebody has to document.
    """
    if isinstance(entry, dict):
        url = entry.get("url")
        if not url:
            return None
        return fetch(url, timeout=timeout,
                     method=entry.get("method"), body=entry.get("body"))
    return fetch(entry, timeout=timeout)


def capture(cam):
    """Trigger a fresh photo and return the JPEG bytes.

    The torch is switched on around the shot rather than left on, because a
    phone LED run continuously cooks the battery and washes the dial out for
    anyone standing there. `torch_settle_ms` exists because the sensor needs a
    moment to re-expose after the light appears -- shoot too early and the frame
    is the dark one.

    `/photoaf.jpg` rather than `/shot.jpg`: shot.jpg hands back whatever the
    preview stream last had, which on this phone is a 7 KB 720x480 frame. The
    photo endpoint runs an autofocus pass and returns the full sensor.
    """
    torch_on = cam.get("torch_on_url")
    torch_off = cam.get("torch_off_url")
    timeout = cam.get("timeout_s", 15)

    # Applied before every shot rather than once by hand. IP Webcam resets its
    # settings when the phone reboots or the app restarts, and the failure that
    # causes is not an error -- it is a quietly softer, darker frame that reads
    # a digit wrong every so often. Cheap to re-assert, expensive to debug.
    for entry in cam.get("prepare_urls") or []:
        try:
            _call(entry, timeout)
        except (urllib.error.URLError, OSError):
            pass

    if torch_on:
        try:
            _call(torch_on, timeout)
            time.sleep(cam.get("torch_settle_ms", 400) / 1000.0)
        except (urllib.error.URLError, OSError):
            pass  # a missing torch is not a reason to skip the photo
    try:
        return fetch(cam["snapshot_url"], timeout=timeout)
    finally:
        if torch_off:
            try:
                _call(torch_off, timeout)
            except (urllib.error.URLError, OSError):
                pass


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

    A front-facing phone camera hands back a mirrored image, and that breaks
    this pipeline twice over rather than once:

      * the digits are mirrored, and the networks were trained on real drums.
        Only 0, 1 and 8 survive a mirror; 2, 4, 6, 9 become shapes the model has
        never seen and will guess at confidently.

      * the ORDER reverses. The leftmost drum becomes the rightmost, so the
        number assembles backwards -- and digits.resolve() decides each drum
        against the one to its RIGHT, so the carry rule runs the wrong way too.

    Fixed here rather than left to the capture device, because this is the one
    place it can be written down, tested and kept in git. Some apps mirror the
    preview but save the still un-mirrored, some do neither consistently, and an
    ESP32-CAM on a bracket may well end up rotated as well. `transform` is null
    by default, which costs nothing when the frame is already the right way up.

    Everything downstream lives in this corrected space: the alignment
    reference, the ROI coordinates and the annotated frame. There is no second
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


def capture_frame(meter, aligned=False):
    """Capture and correct in one step. The only way frames should be acquired.

    `aligned=True` additionally warps onto the stored reference, which is what
    the ROI editor needs: ROI coordinates live in the reference's space, so a
    box drawn on an unaligned frame is a box in the wrong coordinate system.
    Silent, and indistinguishable from a broken model when the camera later
    drifts. Falls back to the unaligned frame when there is no reference yet --
    the first frame is about to become one.
    """
    img = transform(decode(capture(meter["camera"])), meter.get("transform"))
    if not aligned:
        return img
    cfg = meter.get("align") or {}
    if not cfg.get("enabled") or not cfg.get("reference"):
        return img
    ref = cv2.imread(cfg["reference"])
    if ref is None:
        return img
    warped, _ = align(img, ref, cfg.get("min_matches", 12))
    return warped if warped is not None else img


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


def preprocess(patch, spec):
    """Even out the light on one drum before the network sees it.

    Off by default, and that is not timidity. dig-class100 was trained on
    ordinary colour crops of meter digits; every mode here moves the pixels
    away from that distribution in exchange for contrast, and which way that
    trade lands is a measurement, not an argument. `tools/score.py --preprocess`
    runs a labelled corpus through each mode so the answer comes from frames
    rather than from a plausible story about green light.

    The modes, and what each is for:

      clahe   Contrast Limited Adaptive Histogram Equalisation on L in LAB,
              so only lightness moves and the hues the network was trained on
              survive. This is the one to try first. It fixes a drum that is
              dim because the LED is off to one side, and it is the mildest
              thing here.

      green   Keep the green channel, drop red and blue. White ink has green
              in it and red has almost none, so the three white-on-red drums
              come out as white strokes on near-black -- which is a far easier
              picture than white on mid-red. On the five black-on-white drums
              it is close to a plain greyscale and costs little. Replicated
              back to three channels because the interpreter wants three.

      clahe+green   Both, in that order.

    Per ROI as well as per meter, because this dial is two different problems:
    five drums black on white, three white on red. The same argument the model
    field makes -- and the reason `rois` has carried an override since the
    first commit.

    What NOTHING here can do is recover a specular highlight. A flash reflected
    off the meter's glass saturates the sensor, and a saturated pixel has no
    information left to stretch. That is fixed by moving the light, which is
    what two LEDs off to the sides are for.
    """
    if not spec:
        return patch
    mode = spec if isinstance(spec, str) else (spec.get("mode") or "none")
    if not mode or mode == "none":
        return patch

    clip, grid = 2.0, 8
    if isinstance(spec, dict):
        clip = float(spec.get("clip", clip))
        grid = max(1, int(spec.get("grid", grid)))

    out = patch
    if "clahe" in mode:
        lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
        light, a, b = cv2.split(lab)
        light = cv2.createCLAHE(clipLimit=clip,
                                tileGridSize=(grid, grid)).apply(light)
        out = cv2.cvtColor(cv2.merge((light, a, b)), cv2.COLOR_LAB2BGR)
    if "green" in mode:
        # BGR, so index 1. Three channels back out: the interpreter's input
        # shape is not negotiable and a single channel is a silent reshape
        # error at best.
        green = out[:, :, 1]
        out = cv2.merge((green, green, green))
    return out


def prep_for(meter, roi):
    """The preprocessing this drum gets: its own, else the meter's."""
    if roi is not None and roi.get("preprocess") is not None:
        return roi.get("preprocess")
    return (meter or {}).get("preprocess")


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


# ---------------------------------------------------------------------------
# Annotation -- the tuning loop
# ---------------------------------------------------------------------------

def _fit_score(img, model, rois, prep=None):
    """How good is this set of boxes? -1 if unusable.

    Three terms, and the second two exist because confidence alone is a trap.
    Asked only to maximise confidence, the search happily slid onto the blank
    dark band above the digits, where the network reports "7" at 97% for every
    drum -- eight identical digits, perfectly confident, completely wrong. A
    CNN has no way to say "there is nothing here"; it only ranks the classes it
    was given.

    So:

      confidence  -- mean, plus a bonus on the worst drum, because the gate
                     rejects on the minimum and that is what has to be good.
      ink         -- is there actually a digit in the box? Measured as contrast
                     against a blurred copy of the crop, which answers "are
                     there strokes here" without caring whether they are light
                     on dark or dark on light.
      variety     -- eight drums showing the same digit is a 1-in-10-million
                     coincidence and an everyday symptom of a degenerate fit.
    """
    values, confidences, inks = [], [], []
    for roi in rois:
        try:
            patch = crop(img, roi)
        except ValueError:
            return -1.0, [], []
        if patch.size == 0:
            return -1.0, [], []
        value, conf = model.predict(preprocess(patch, prep))
        if value is None:
            return -1.0, [], []
        values.append(value)
        confidences.append(0.0 if conf is None else conf)

        # Ink is measured on the ORIGINAL crop, never the preprocessed one.
        # Every mode above raises local contrast -- that is what they are for --
        # so scoring ink after them would hand the fit a better mark for the
        # same box and quietly move a guardrail the gate depends on.
        grey = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype(np.float32)
        strokes = np.abs(grey - cv2.GaussianBlur(grey, (0, 0), max(patch.shape[:2]) / 6.0))
        inks.append(min(float(strokes.mean()) / 12.0, 1.0))

    if not confidences:
        return -1.0, [], []

    confidence = sum(confidences) / len(confidences) + 0.5 * min(confidences)
    ink = sum(inks) / len(inks) + 0.5 * min(inks)
    variety = len({int(round(v)) % 10 for v in values}) / float(len(values))

    return confidence + 1.5 * ink + 1.5 * variety, values, confidences


def autofit(img, model, bbox, count=8, prep=None):
    """Fit `count` evenly pitched ROIs inside a rough bounding box.

    `prep` is the meter's preprocessing, and it is here so the search is
    scored through the same pixels the reader will use. Fitting boxes on raw
    crops and then reading them through CLAHE is fitting one problem and
    solving another.

    Placing eight rectangles by hand on a blurry, slightly tilted row of drums
    is genuinely difficult, and the failure is quiet: a box a few pixels off
    centre clips its digit, the model's confidence collapses, and the reading
    is refused by the gate for reasons that look like a model problem. On the
    first real meter here one drum sat hard against the right edge of its box
    and came back at 0.32 while its neighbours were at 1.00.

    The drums are on one shaft, so their pitch is exactly uniform -- which
    makes this a five-parameter fit (pitch, offset, box size, height, tilt)
    rather than 32 independent numbers, and the model's own confidence is the
    right thing to maximise. Nobody can eyeball what a CNN finds legible.

    Staged rather than brute-forced: each stage holds the others still, so this
    is a few hundred inferences and about a second, not a combinatorial sweep.
    """
    x0, y0 = float(bbox["x"]), float(bbox["y"])
    width, height = float(bbox["w"]), float(bbox["h"])

    pitch = width / count
    first = x0 + pitch / 2.0
    box_w = pitch * 0.75
    box_h = height
    top = y0
    tilt = 0.0                      # pixels of y drop across the whole strip

    def build(first_c, pitch_v, w_v, h_v, top_v, tilt_v):
        span = pitch_v * (count - 1) or 1.0
        return [{"x": int(round(first_c + i * pitch_v - w_v / 2.0)),
                 "y": int(round(top_v + tilt_v * (i * pitch_v) / span)),
                 "w": int(round(w_v)), "h": int(round(h_v))}
                for i in range(count)]

    def best_over(candidates):
        out = None
        for cand in candidates:
            rois = build(*cand)
            score = _fit_score(img, model, rois, prep)[0]
            if out is None or score > out[0]:
                out = (score, cand)
        return out

    # 1. vertical placement first: everything else is judged through it
    _, (first, pitch, box_w, box_h, top, tilt) = best_over(
        (first, pitch, box_w, h, t, tilt)
        for h in (height * f for f in (0.6, 0.75, 0.9, 1.0, 1.15))
        for t in (y0 + height * o for o in (-0.15, -0.05, 0.0, 0.05, 0.15, 0.25)))

    # 2. pitch and offset -- a half-drum error here is the usual mistake
    _, (first, pitch, box_w, box_h, top, tilt) = best_over(
        (x0 + width / 2.0 - (count - 1) * p / 2.0 + d, p, box_w, box_h, top, tilt)
        for p in (width / count * f for f in (0.92, 0.96, 1.0, 1.04, 1.08))
        for d in (-pitch * 0.4, -pitch * 0.2, 0.0, pitch * 0.2, pitch * 0.4))

    # 3. tilt: the row is rarely level, and a tilted row cannot be fitted by
    #    axis-aligned boxes sharing one y
    _, (first, pitch, box_w, box_h, top, tilt) = best_over(
        (first, pitch, box_w, box_h, top, t)
        for t in (-40, -30, -20, -12, -6, 0, 6, 12, 20, 30, 40))

    # 4. box size last, now that it is centred on something real
    _, (first, pitch, box_w, box_h, top, tilt) = best_over(
        (first, pitch, pitch * fw, box_h * fh, top, tilt)
        for fw in (0.55, 0.65, 0.75, 0.85, 0.95)
        for fh in (0.85, 0.95, 1.0, 1.1))

    rois = build(first, pitch, box_w, box_h, top, tilt)
    score, values, confidences = _fit_score(img, model, rois, prep)
    return rois, {
        "score": round(score, 3),
        "pitch": round(pitch, 1),
        "tilt_px": round(tilt, 1),
        "box": [int(round(box_w)), int(round(box_h))],
        "min_confidence": round(min(confidences), 3) if confidences else None,
        "values": [round(v, 1) for v in values],
    }


def annotate(img, rois, values, confidences, digits=None):
    """Draw ROI boxes and what each one was read as.

    Without this, tuning ROI coordinates is guesswork against a number. With
    it, a wrong reading shows you immediately whether the box is off the drum,
    the crop is blurred, or the model simply disagrees.
    """
    out = img.copy()
    for i, roi in enumerate(rois):
        x, y = int(roi["x"]), int(roi["y"])
        w, h = int(roi["w"]), int(roi["h"])
        val = values[i] if i < len(values) else None
        conf = confidences[i] if i < len(confidences) else None

        if val is None:
            colour = (0, 0, 255)
        elif conf is None or conf >= 0.5:
            colour = (0, 200, 0)
        else:
            colour = (0, 165, 255)

        cv2.rectangle(out, (x, y), (x + w, y + h), colour, 2)
        label = "?" if val is None else "%.1f" % val
        if digits is not None and i < len(digits):
            label += " -> %d" % digits[i]
        if conf is not None:
            label += " %.0f%%" % (conf * 100)
        cv2.putText(out, label, (x, max(14, y - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)
    return out


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


def read_once(meter, models, image_bytes=None, prevalue=None,
              rois_override=None):
    """Capture and interpret ONE frame. No confirmation, no gate.

    Everything up to and including a number: capture, transform, align, crop,
    infer, assemble. Whether to believe that number is `read()`'s business,
    because that decision needs several frames and this one has seen one.

    `image_bytes` skips the camera, which is what the tests and `POST /read`
    use. `rois_override` lets the ROI editor try a rectangle set without
    writing the config first.
    """
    started = time.time()
    result = {
        # `value` is what Home Assistant is asked to believe and every guard
        # judges; `dial` is the whole index the drums showed, kept for the eye
        # and for tools/score.py. They differ whenever report_decimals stops
        # short of the dial -- see digits.truncate().
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
        "captured_at": None,
        "duration_ms": None,
    }

    if image_bytes is None:
        image_bytes = capture(meter["camera"])
    result["captured_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")

    # Corrected before anything else looks at it, so the reference frame, the
    # ROI coordinates and the annotated output all share one orientation.
    img = transform(decode(image_bytes), meter.get("transform"))
    result["frame_size"] = [int(img.shape[1]), int(img.shape[0])]

    align_cfg = meter.get("align") or {}
    if align_cfg.get("enabled"):
        ref_path = align_cfg.get("reference")
        ref = cv2.imread(ref_path) if ref_path else None

        # os.path.exists, not "imread came back empty". imread returns None
        # for a file it cannot decode as well as one that is not there, and a
        # file being written at that instant reads as both. That is how this
        # container silently replaced a good reference with a fresh capture
        # mid-deploy on 2026-09-05 -- the ROIs and the reference stopped being
        # the matched pair everything downstream assumes, with no error.
        #
        # Adopting a missing reference is still right: without one the ROIs are
        # read against raw pixel coordinates, which cost four sessions to
        # diagnose. Adopting an unreadable one is not.
        if (ref is None and ref_path and not os.path.exists(ref_path)
                and align_cfg.get("auto_reference", True)):
            # Adopt the first frame as the reference rather than waiting to be
            # told. Requiring a button press was a footgun: without a reference
            # the ROIs are read from raw pixel coordinates, so the camera drifts
            # a few tens of pixels, every drum reads wrong, and it looks exactly
            # like a broken model. That cost four sessions here before anyone
            # compared two frames side by side.
            #
            # Safe to adopt automatically because the frame being read is, by
            # definition, the frame the ROIs are being drawn or checked against
            # -- which is precisely the space the ROI coordinates live in. Move
            # the camera and redraw, and POST /reference replaces it.
            try:
                os.makedirs(os.path.dirname(ref_path) or ".", exist_ok=True)
                cv2.imwrite(ref_path, img)
                ref = img
                result["align"] = {"ok": True, "adopted": True,
                                   "reason": "reference created from this frame"}
            except OSError as exc:
                result["align"] = {"ok": False,
                                   "reason": "cannot write reference: %s" % exc}

        if ref is None:
            existing = bool(ref_path) and os.path.exists(ref_path)
            result.setdefault("align", {
                "ok": False,
                "reason": ("reference unreadable" if existing
                           else "reference image missing"),
            })
            if align_cfg.get("on_failure", "reject") == "reject":
                result["reason"] = "align: reference image missing at %s" % ref_path
                return _finish(result, started, img, [], [], [])
        elif not (result.get("align") or {}).get("adopted"):
            # Skipped when the reference was just adopted from this very frame:
            # aligning an image to itself is an identity warp that costs a
            # hundred milliseconds and would overwrite the "adopted" flag the
            # caller needs to see.
            warped, info = align(img, ref, align_cfg.get("min_matches", 12))
            result["align"] = info

            # Producing a transform and producing a TRUSTWORTHY one are
            # different bars, and only the first used to be checked. A frame
            # can match on 21 of 147 features, warp 800 px, and arrive sharp,
            # confident and completely wrong -- see align_gate's docstring.
            ok, why = align_gate(info, align_cfg)
            if not ok:
                info["ok"] = False
                info["reason"] = why
                if align_cfg.get("on_failure", "reject") == "reject":
                    result["reason"] = "align: %s" % why
                    return _finish(result, started, img, [], [], [])
            if warped is not None:
                img = warped

    rois = rois_override if rois_override is not None else meter.get("rois") or []
    if not rois:
        result["reason"] = ("no ROIs configured -- open /roi to draw them over "
                            "the current frame")
        return _finish(result, started, img, [], [], [])

    # One model for the whole row by default, overridable per ROI. This meter's
    # first five drums are black on white and its last three are white on red,
    # which are different enough that they may not want the same network. Being
    # able to say so per drum is cheap now and awkward to retrofit later.
    default_model = meter["model"]
    values, confidences = [], []
    for roi in rois:
        patch = crop(img, roi)
        model = models.get_model(roi.get("model") or default_model)
        val, conf = model.predict(preprocess(patch, prep_for(meter, roi)))
        values.append(val)
        confidences.append(conf)

    result["confidence"] = {
        "per_drum": [None if c is None else round(c, 3) for c in confidences],
        "min": None,
    }
    result["_confidences"] = confidences
    known = [c for c in confidences if c is not None]
    if known:
        result["confidence"]["min"] = round(min(known), 3)

    decimals = meter.get("decimals", 0)
    report = reported_decimals(meter)
    digits = None
    try:
        dial, digits, raw_string = assemble(
            values, decimals, meter.get("counter_type", "continuous"))
        # Every drum is read and every drum is drawn on the annotated frame.
        # The fast ones simply stop deciding anything: they are the drums that
        # made a burst disagree with itself while the boiler was firing, and
        # they resolve their neighbour's phase whether or not they are
        # published.
        value = truncate(dial, decimals, report)
        result["dial"] = dial
        result["value"] = value
        result["digits"] = digits
        result["raw"] = raw_string
        if prevalue is not None:
            result["delta"] = round(value - prevalue, report + 1)
    except ValueError as exc:
        result["reason"] = "assemble: %s" % exc
        return _finish(result, started, img, rois, values, confidences, digits)

    return _finish(result, started, img, rois, values, confidences, digits)


def _sample_summary(samples, wanted):
    return {
        "wanted": wanted,
        "taken": len(samples),
        "values": [s.get("value") for s in samples],
    }


def read(meter, models, image_bytes=None, prevalue=None, elapsed_s=None,
         rois_override=None):
    """Read the dial several times, require agreement, then gate. One answer.

    The shape of the whole thing:

        read_once  x N   ->  confirm_samples  ->  gate  ->  accepted
        (each aligned)       (do they agree?)     (is it plausible?)

    Sampling exists because one frame can be wrong in ways that leave no trace
    in the number -- a flicker, sensor noise, a drum caught mid-tick. Those do
    not repeat, so demanding that several frames agree removes them. It does
    NOT remove a systematic error: misplaced ROIs give the same wrong answer
    every time, confidently. align_gate() is what stands against that, and
    tools/score.py is the only thing that proves either.

    Fails fast. A frame that produced no number -- refused alignment, no ROIs
    -- will not do better on the second attempt, so the burst stops there
    rather than spending ten seconds confirming a refusal.

    `image_bytes` may be one frame or a list of them, and that distinction is
    the whole of how a pushed read keeps its guarantees.

    A camera in deep sleep cannot be polled, so the frames arrive together or
    not at all. One frame is one frame: the result says `unconfirmed` rather
    than quietly claiming a check that never ran. Several frames go through
    exactly the path a pulled burst does -- every one read, all of them
    required to agree -- because the defence was never about who triggered the
    shutter, it was about a flicker or a drum caught mid-tick not surviving a
    second look.

    Nothing sleeps between pushed frames. They were taken seconds ago on the
    other side of the wire, and `gap_ms` is about spacing captures, which is
    not this process's job any more.
    """
    # Compare like with like. Home Assistant's input_number holds whatever a
    # human last typed, which is the whole dial to 0.001, while what we publish
    # stops at report_decimals. Untruncated, a 2246.916 prevalue against a
    # 2246.91 reading is a 0.006 DECREASE and tolerance_down is 0.0, so the
    # gate would refuse every frame until the meter passed .92 -- twenty
    # minutes of nothing, once, for an arithmetic mismatch.
    prevalue = truncate(prevalue, meter.get("decimals", 0),
                        reported_decimals(meter))

    confirm_cfg = meter.get("confirm") or {}
    frames = list(image_bytes) if isinstance(image_bytes, (list, tuple))         else ([image_bytes] if image_bytes else [])
    pushed = bool(frames)

    if pushed:
        # However many arrived. The node decides how many it can afford to
        # take while it is awake with the lights on, and this side does not
        # get to want more than exists.
        wanted = len(frames)
    else:
        wanted = confirm_cfg.get("samples", 2)
        if wanted is None or wanted <= 1:
            wanted = 1
    gap_s = max(0.0, float(confirm_cfg.get("gap_ms", 300)) / 1000.0)

    samples = []
    for i in range(wanted):
        if i and not pushed:
            # Long enough to decorrelate sensor noise between frames, short
            # enough that the last drum is unlikely to move. A long gap would
            # only invite the disagreement this is trying to detect.
            time.sleep(gap_s)
        one = read_once(meter, models,
                        image_bytes=frames[i] if pushed else None,
                        prevalue=prevalue, rois_override=rois_override)
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
            # case alone -- doing it always would be five frames a poll.
            result["_frames"] = [s.get("_frame") for s in samples]
            return result
        result["value"] = value
    elif pushed:
        result["unconfirmed"] = "single frame supplied; not sampled"

    digits = result.get("digits") or []
    rois = rois_override if rois_override is not None else meter.get("rois") or []
    accepted, reason = gate(
        result["value"], prevalue, meter.get("gate") or {},
        len(digits), len(rois), result.get("_confidences") or [], elapsed_s,
    )
    result["accepted"] = accepted
    result["reason"] = reason
    return result


def _finish(result, started, img, rois, values, confidences, digits=None):
    result["duration_ms"] = int((time.time() - started) * 1000)
    result["_frame"] = img
    result["_annotated"] = annotate(img, rois, values, confidences, digits) \
        if rois else img
    return result


# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--meter", default="gas")
    ap.add_argument("--image", help="read this file instead of the camera")
    ap.add_argument("--prevalue", type=float)
    ap.add_argument("--save-annotated", help="write the annotated frame here")
    args = ap.parse_args(argv)

    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)
    meter = cfg["meters"][args.meter]

    blob = None
    if args.image:
        with open(args.image, "rb") as fh:
            blob = fh.read()

    out = read(meter, ModelCache(), image_bytes=blob, prevalue=args.prevalue)
    annotated = out.pop("_annotated", None)
    out.pop("_frame", None)
    if args.save_annotated and annotated is not None:
        with open(args.save_annotated, "wb") as fh:
            fh.write(to_jpeg(annotated))
    print(json.dumps(out, indent=2))
    return 0 if out["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
