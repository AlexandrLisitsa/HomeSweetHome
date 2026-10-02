#!/bin/sh
# Prove the TFLite runtime actually executes on this hypervisor's CPU.
#
#   sh MeterCam/deploy/probe_cpu.sh
#
# WHY THIS EXISTS, and why it runs before anyone trusts a reading:
#
# The host is an Intel Celeron J4105 -- Goldmont Plus -- and it has SSE4.2 but
# NO AVX, no AVX2, no FMA, no F16C. That is unusual enough in 2026 that a lot
# of numeric wheels no longer bother supporting it, and the way they fail is
# the problem: TensorFlow's own pip wheels have required AVX since 1.6 and
# abort with SIGILL -- "Illegal instruction" -- on the first kernel that needs
# it. No Python traceback, no import error, just a dead process.
#
# reader.py falls back ai-edge-litert -> tflite-runtime -> tensorflow, which
# looks like three chances and is really two: the tensorflow tier is dead on
# arrival on this CPU, so if litert will not run, tflite-runtime is the whole
# of the remaining plan.
#
# An ImportError would be caught by the fallback chain. SIGILL is not an
# exception and cannot be caught, so it has to be provoked deliberately, here,
# against the real model file -- not merely imported, INVOKED. An interpreter
# that constructs and then dies on the first invoke() is exactly the shape of
# this bug.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" <<'INNER'
import ctypes, glob, sys

flags = set()
with open("/proc/cpuinfo") as fh:
    for line in fh:
        if line.startswith("flags"):
            flags = set(line.split(":", 1)[1].split())
            break

print("CPU")
for f in ("sse2", "ssse3", "sse4_1", "sse4_2", "avx", "avx2", "fma", "f16c"):
    print("  %-7s %s" % (f, "yes" if f in flags else "NO"))

print("\nruntime")
tiers = [
    ("ai_edge_litert", "ai_edge_litert.interpreter"),
    ("tflite_runtime", "tflite_runtime.interpreter"),
    ("tensorflow",     "tensorflow.lite"),
]
chosen = None
for name, module in tiers:
    try:
        mod = __import__(module, fromlist=["Interpreter"])
        Interpreter = mod.Interpreter
    except Exception as exc:
        print("  %-16s absent (%s)" % (name, type(exc).__name__))
        continue
    print("  %-16s imported" % name)
    if chosen is None:
        chosen = (name, Interpreter)

if chosen is None:
    print("\nFAIL: no TFLite runtime importable at all")
    sys.exit(1)

name, Interpreter = chosen
print("\nreader.py will use: %s" % name)

models = sorted(glob.glob("/models/*.tflite"))
if not models:
    print("FAIL: no /models/*.tflite mounted")
    sys.exit(1)

# Invoke, do not merely construct. Delegate kernels are selected and JITted at
# the first invoke(), which is where an unsupported instruction actually gets
# executed.
import numpy as np
for path in models:
    try:
        interp = Interpreter(model_path=path)
        interp.allocate_tensors()
        inp = interp.get_input_details()[0]
        shape = [1 if d < 1 else int(d) for d in inp["shape"]]
        dtype = inp["dtype"]
        if np.issubdtype(dtype, np.integer):
            data = np.zeros(shape, dtype=dtype)
        else:
            data = np.zeros(shape, dtype=dtype)
        interp.set_tensor(inp["index"], data)
        interp.invoke()
        out = interp.get_tensor(interp.get_output_details()[0]["index"])
        print("  OK   %-42s in=%s out=%s" % (path.split("/")[-1], tuple(shape), out.shape))
    except Exception as exc:
        print("  FAIL %-42s %s: %s" % (path.split("/")[-1], type(exc).__name__, exc))
        sys.exit(1)

print("\nOpenCV")
import cv2
print("  version %s" % cv2.__version__)
# ORB is what align() uses on every frame. It is plain SSE and should be fine,
# but it costs nothing to prove it here alongside everything else.
img = np.zeros((480, 640), dtype=np.uint8)
cv2.randu(img, 0, 255)
kp, des = cv2.ORB_create(500).detectAndCompute(img, None)
print("  ORB  %d keypoints on a noise frame" % len(kp))

print("\nPASS -- the runtime executes on this CPU.")
INNER

echo "probing inside container $VMID..."
pve "cat > /tmp/metercam-probe.py" < "$tmp"
pve "pct push $VMID /tmp/metercam-probe.py /tmp/metercam-probe.py"

# Run inside the running service container, so this tests the exact image and
# the exact mounted model files that /read uses -- not a lookalike.
pve "pct exec $VMID -- sh -c 'cd $APP_DIR && docker compose cp /tmp/metercam-probe.py metercam:/tmp/probe.py && docker compose exec -T metercam python /tmp/probe.py'"
