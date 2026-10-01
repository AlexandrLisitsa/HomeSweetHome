#!/bin/sh
# Ship MeterCam's code into the LXC, rebuild the image, restart, health-check.
#
#   sh MeterCam/deploy/deploy.sh
#
# Idempotent, and the normal way to push a code change.
#
# CODE ONLY. The box owns everything that describes THIS house and is not in
# git, and a deploy never touches it:
#
#   config.json        the meter, its ROIs, Home Assistant's address
#   .env               METERCAM_TOKEN and METERCAM_HA_TOKEN
#   models/*.tflite    jomjol's weights (no stated licence, so not committed)
#   data/              the alignment reference, refused frames, firmware
#
# A deploy that shipped the workstation's copies would quietly undo a ROI
# change made on the box -- the reference and the ROIs are one matched pair,
# and replacing either alone gives a confident wrong number with no error.
# Setting those up the first time is in docs/deployment.md.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

[ $# -eq 0 ] || { echo "usage: sh MeterCam/deploy/deploy.sh" >&2; exit 1; }

# --- preflight ------------------------------------------------------------

pve "pct status $VMID" 2>/dev/null | grep -q running || {
    echo "container $VMID is not running. lxc_create.sh / lxc_provision.sh first." >&2
    exit 1
}

missing=$(pve "pct exec $VMID -- sh -c 'cd $APP_DIR 2>/dev/null || { echo $APP_DIR; exit; }
    [ -f config.json ] || echo config.json
    [ -f .env ] || echo .env
    ls models/*.tflite >/dev/null 2>&1 || echo models/*.tflite
    [ -f data/ref/gas.jpg ] || echo data/ref/gas.jpg'")
[ -z "$missing" ] || {
    echo "the box is missing what a deploy does not ship:" >&2
    echo "$missing" | sed 's/^/  /' >&2
    echo "see MeterCam/docs/deployment.md, 'First setup'." >&2
    exit 1
}

# --- pack -----------------------------------------------------------------
#
# --owner/--group/--numeric-owner: the archive is built on Windows, where every
# file is uid 197609. An unprivileged LXC maps only 0-65535 into its namespace,
# so extracting that as root fails on EVERY file with "Cannot change ownership
# ... Invalid argument". Record root:root going in, and refuse to restore
# ownership coming out.

tarball=$(mktemp)
inner=$(mktemp)
trap 'rm -f "$tarball" "$inner"' EXIT

echo "packing..."
tar czf - -C "$root" \
    --owner=0 --group=0 --numeric-owner \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    Dockerfile .dockerignore docker-compose.yml requirements.txt service tests \
    > "$tarball"
echo "  $(du -h "$tarball" | cut -f1)"

cat > "$inner" <<INNER
#!/bin/sh
set -eu
cd "$APP_DIR"
# service/ and tests/ are replaced whole, so a file deleted in git is deleted
# here too instead of lingering in the image. tools/, firmware/ and the docs
# are what older deploys shipped; nothing on the box uses them.
rm -rf service tests tools firmware README.md .gitattributes .gitignore
tar xzf /tmp/metercam-deploy.tar.gz -C "$APP_DIR" --no-same-owner
rm -f /tmp/metercam-deploy.tar.gz
mkdir -p data/images data/firmware
echo "== build =="
# The J4105 has no AVX and 1 GB of RAM here: minutes, not seconds, almost all
# of it unpacking the opencv and litert wheels. Cached unless requirements move.
docker compose build
echo "== up =="
docker compose up -d --force-recreate
INNER

echo "shipping..."
pve "cat > /tmp/metercam-deploy.tar.gz" < "$tarball"
pve "pct push $VMID /tmp/metercam-deploy.tar.gz /tmp/metercam-deploy.tar.gz"
pve "cat > /tmp/metercam-deploy.sh" < "$inner"
pve "pct push $VMID /tmp/metercam-deploy.sh /tmp/metercam-deploy.sh --perms 755"
status=0
pve "pct exec $VMID -- sh /tmp/metercam-deploy.sh" || status=$?
pve "rm -f /tmp/metercam-deploy.tar.gz /tmp/metercam-deploy.sh; pct exec $VMID -- rm -f /tmp/metercam-deploy.tar.gz /tmp/metercam-deploy.sh" || true
[ "$status" -eq 0 ] || exit "$status"

# --- verify ---------------------------------------------------------------
#
# HEALTHCHECK has a 20 s start-period and waitress is not instant, so the first
# attempt after `up -d` is expected to fail. Retry rather than sleep-and-hope.

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
echo "tests, against the image just built:"
echo "  sh Proxmox/tools/pve_ssh.sh \"pct exec $VMID -- docker exec metercam python tests/test_reader.py\""
