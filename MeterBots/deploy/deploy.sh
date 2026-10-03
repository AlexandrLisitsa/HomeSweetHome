#!/bin/sh
# Ship MeterBots' code into the LXC, rebuild the image, restart, health-check.
#
#   sh MeterBots/deploy/deploy.sh
#
# Idempotent, and the normal way to push a code change.
#
# CODE ONLY. The box owns what is private and not in git, and a deploy never
# touches it:
#
#   .env                         the API credentials, the bots' tokens and
#                                account numbers (template: .env.example)
#   data/telegram/               the logged-in Telegram session
#
# Setting those up the first time is in docs/deployment.md.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

[ $# -eq 0 ] || { echo "usage: sh MeterBots/deploy/deploy.sh" >&2; exit 1; }

# --- preflight ------------------------------------------------------------

pve "pct status $VMID" 2>/dev/null | grep -q running || {
    echo "container $VMID is not running. lxc_create.sh / lxc_provision.sh first." >&2
    exit 1
}

missing=$(pve "pct exec $VMID -- sh -c 'cd $APP_DIR 2>/dev/null || { echo $APP_DIR; exit; }
    [ -f .env ] || echo .env'")
[ -z "$missing" ] || {
    echo "the box is missing what a deploy does not ship:" >&2
    echo "$missing" | sed 's/^/  /' >&2
    echo "see MeterBots/docs/deployment.md, 'First setup'." >&2
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
# here too instead of lingering in the image.
rm -rf service tests
tar xzf /tmp/meterbots-deploy.tar.gz -C "$APP_DIR" --no-same-owner
rm -f /tmp/meterbots-deploy.tar.gz
mkdir -p data/telegram
chmod 700 data/telegram
echo "== build =="
docker compose build
echo "== up =="
docker compose up -d --force-recreate
INNER

echo "shipping..."
pve "cat > /tmp/meterbots-deploy.tar.gz" < "$tarball"
pve "pct push $VMID /tmp/meterbots-deploy.tar.gz /tmp/meterbots-deploy.tar.gz"
pve "cat > /tmp/meterbots-deploy.sh" < "$inner"
pve "pct push $VMID /tmp/meterbots-deploy.sh /tmp/meterbots-deploy.sh --perms 755"
status=0
pve "pct exec $VMID -- sh /tmp/meterbots-deploy.sh" || status=$?
pve "rm -f /tmp/meterbots-deploy.tar.gz /tmp/meterbots-deploy.sh; pct exec $VMID -- rm -f /tmp/meterbots-deploy.tar.gz /tmp/meterbots-deploy.sh" || true
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
echo "  sh Proxmox/tools/pve_ssh.sh \"pct exec $VMID -- docker exec meterbots python tests/test_gasbot.py\""
