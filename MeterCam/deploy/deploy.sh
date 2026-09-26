#!/bin/sh
# Ship the MeterCam tree into the LXC and bring the stack up.
#
#   sh MeterCam/deploy/deploy.sh              # push, build, restart, check
#   sh MeterCam/deploy/deploy.sh --no-build   # code-only change, skip the build
#   sh MeterCam/deploy/deploy.sh --force-ref  # also replace the alignment reference
#
# Idempotent, and the normal way to push a change. Run it as often as you like.
#
# It deploys the WORKING TREE, not a git ref, and that is not laziness. Three
# things the service cannot start without are gitignored on purpose:
# config.json (holds the camera's LAN address), models/*.tflite (jomjol's
# weights, no stated licence) and .env (the auth token). A deploy from a clean
# clone would produce a container that builds and then cannot read a meter.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

do_build=1
force_ref=0
for arg in "$@"; do
    case "$arg" in
        --no-build) do_build=0 ;;
        --force-ref) force_ref=1 ;;
        *) echo "unknown option: $arg" >&2; exit 1 ;;
    esac
done

# --- preflight ------------------------------------------------------------

pve "pct status $VMID" 2>/dev/null | grep -q running || {
    echo "container $VMID is not running. lxc_create.sh / lxc_provision.sh first." >&2
    exit 1
}

[ -f "$root/config.json" ] || {
    echo "no MeterCam/config.json." >&2
    echo "  cp service/config.example.json config.json  -- and set the camera URL." >&2
    exit 1
}
python -c "import json,sys; json.load(open(sys.argv[1]))" "$root/config.json" 2>/dev/null || {
    echo "MeterCam/config.json is not valid JSON. Fix it before shipping it." >&2
    exit 1
}

models=$(find "$root/models" -name '*.tflite' 2>/dev/null | wc -l)
[ "$models" -gt 0 ] || {
    echo "no models/*.tflite -- run 'sh models/fetch.sh' first." >&2
    exit 1
}

rois=$(python -c "
import json,sys
c=json.load(open(sys.argv[1]))
print(sum(len(m.get('rois') or []) for m in c.get('meters',{}).values()))
" "$root/config.json")
[ "$rois" -gt 0 ] || echo "note: config.json has no ROIs yet -- /read will not produce digits." >&2

# --- pack -----------------------------------------------------------------
#
# data/images is excluded: those are the container's own archived frames and a
# deploy must not post the workstation's debugging leftovers over them.
#
# firmware/*/.pio is excluded because it is 44 MB of ESP32 toolchain output
# that belongs to whoever last ran `pio run`, and nothing in the container has
# any use for it. The firmware SOURCE ships -- it is small, and the node's
# build is the thing the OTA endpoint will eventually hand out.
#
# data/ref is INCLUDED, and it is the subtle one. Every ROI is a pixel
# rectangle in the reference frame, so the reference and the ROI list are one
# matched pair -- shipping config.json without the ref it was drawn against
# gives the container eight rectangles in a coordinate space it has never seen.
# With auto_reference true it would then adopt its own first frame as the
# reference and read those rectangles against it: a confident, wrong number,
# and no error anywhere.
#
# But only as a SEED. Once the container is live, its /roi editor writes the
# reference and the container is the source of truth; clobbering that from a
# workstation copy on every deploy would undo an aiming session. So it goes in
# only if the container has none, unless --force-ref says otherwise.

tarball=$(mktemp)
inner=$(mktemp)
trap 'rm -f "$tarball" "$inner"' EXIT

echo "packing..."
# --owner/--group/--numeric-owner: the archive is built on Windows, where every
# file is uid 197609. An unprivileged LXC maps only 0-65535 into its namespace,
# so extracting that as root fails on EVERY file with "Cannot change ownership
# ... Invalid argument" -- which reads like a permissions problem on the
# container and is really the workstation's uid being unrepresentable there.
# Record root:root going in, and refuse to restore ownership coming out.
tar czf - -C "$root/.." \
    --owner=0 --group=0 --numeric-owner \
    --exclude='MeterCam/data/images' \
    --exclude='MeterCam/corpus' \
    --exclude='MeterCam/deploy' \
    --exclude='MeterCam/firmware/*/.pio' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.git' \
    MeterCam > "$tarball"

size=$(du -h "$tarball" | cut -f1)
echo "  $size"

echo "shipping..."
pve "cat > /tmp/metercam-deploy.tar.gz" < "$tarball"
pve "pct push $VMID /tmp/metercam-deploy.tar.gz /tmp/metercam-deploy.tar.gz"

# --- unpack and run -------------------------------------------------------


cat > "$inner" <<INNER
#!/bin/sh
set -eu
cd "$APP_DIR"

# Preserve the container's own reference before unpacking over the tree.
had_ref=0
[ -f "$APP_DIR/data/ref/gas.jpg" ] && had_ref=1
if [ "\$had_ref" -eq 1 ]; then
    mkdir -p /tmp/metercam-ref-keep
    cp -a "$APP_DIR/data/ref/." /tmp/metercam-ref-keep/
fi

tar xzf /tmp/metercam-deploy.tar.gz -C "$APP_DIR" --strip-components=1 --no-same-owner

if [ "\$had_ref" -eq 1 ] && [ "$force_ref" -eq 0 ]; then
    mkdir -p "$APP_DIR/data/ref"
    cp -a /tmp/metercam-ref-keep/. "$APP_DIR/data/ref/"
    echo "kept the container's existing alignment reference"
elif [ "\$had_ref" -eq 1 ]; then
    echo "REPLACED the container's alignment reference (--force-ref)"
else
    echo "seeded the alignment reference from the workstation"
fi
rm -rf /tmp/metercam-ref-keep

mkdir -p "$APP_DIR/data/images"

if [ "$do_build" -eq 1 ]; then
    echo "== build =="
    # The J4105 has no AVX and 1 GB of RAM here: this is minutes, not seconds,
    # and it is almost all unpacking the opencv and litert wheels.
    docker compose build
fi

echo "== up =="
docker compose up -d
INNER

echo "deploying..."
pve "cat > /tmp/metercam-deploy.sh" < "$inner"
pve "pct push $VMID /tmp/metercam-deploy.sh /tmp/metercam-deploy.sh --perms 755"
pve "pct exec $VMID -- sh /tmp/metercam-deploy.sh"

# --- verify ---------------------------------------------------------------
#
# HEALTHCHECK has a 20 s start-period and waitress is not instant, so the first
# poll after `up -d` is expected to fail. Poll rather than sleep-and-hope.

printf 'waiting for health'
i=0
while [ "$i" -lt 30 ]; do
    if pve "pct exec $VMID -- curl -fsS http://localhost:8770/health" >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    printf '.'
    i=$((i + 1))
    sleep 2
done

if [ "$i" -eq 30 ]; then
    echo " FAILED"
    echo "--- container logs ---" >&2
    pve "pct exec $VMID -- sh -c 'cd $APP_DIR && docker compose logs --tail=40'" >&2 || true
    exit 1
fi

echo
pve "pct exec $VMID -- curl -fsS http://localhost:8770/health"
echo
echo "MeterCam is up:  http://${LXC_IP}:8770/health"
echo "                 http://${LXC_IP}:8770/roi"
echo
echo "verify the runtime works on this CPU:  sh MeterCam/deploy/probe_cpu.sh"
