#!/bin/sh
# Install Docker inside the MeterBots LXC.
#
#   sh MeterBots/deploy/lxc_provision.sh
#
# Idempotent: safe to re-run, or to repair a container someone has poked at. It installs no application code -- that is
# deploy.sh, which can then be run as often as you like.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

pve "pct status $VMID" >/dev/null 2>&1 || {
    echo "container $VMID does not exist. Run lxc_create.sh first." >&2
    exit 1
}
pve "pct status $VMID" | grep -q running || pve "pct start $VMID"

# Provisioning goes in as a FILE rather than as a quoted string.
#
# `pct exec 105 -- sh -c '...'` through ssh means the script survives two
# rounds of shell quoting, and the failure mode is not a syntax error -- it is
# a script that runs with half its quotes eaten and does something adjacent to
# what was intended. Writing it to the host, pushing it in and executing it by
# path costs one extra hop and removes the whole class of problem. It also
# leaves the thing that ran sitting in /tmp inside the container, which is
# worth a great deal at 2am.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" <<INNER
#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive

echo "== base packages =="
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg jq

echo "== docker =="
if command -v docker >/dev/null 2>&1; then
    echo "already installed: \$(docker --version)"
else
    # get.docker.com rather than Debian's docker.io: it pulls docker-ce with
    # the compose V2 plugin, which is what docker-compose.yml assumes when it
    # says 'docker compose' rather than 'docker-compose'. Debian's package
    # ships neither the plugin nor a recent daemon.
    curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# overlay2 needs unprivileged overlayfs, which arrived in kernel 5.11 and this
# host is on 7.0. If Docker has fallen back to vfs, every layer is a full copy
# and the 8 GB rootfs will not survive a rebuild -- so say so loudly rather
# than letting it be discovered as a disk-full three weeks from now.
driver=\$(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown)
echo "storage driver: \$driver"
if [ "\$driver" = "vfs" ]; then
    echo "WARNING: Docker fell back to the vfs storage driver." >&2
    echo "  Every image layer becomes a full copy. Check that the container has" >&2
    echo "  features nesting=1,keyctl=1 and that overlay is loadable." >&2
fi

echo "== application directory =="
mkdir -p "$APP_DIR/data/telegram"
chmod 700 "$APP_DIR/data/telegram"

echo
echo "provisioned."
docker --version
docker compose version
INNER

echo "pushing provisioning script into $VMID..."
pve "cat > /tmp/meterbots-provision.sh" < "$tmp"
pve "pct push $VMID /tmp/meterbots-provision.sh /tmp/meterbots-provision.sh --perms 755"
pve "pct exec $VMID -- sh /tmp/meterbots-provision.sh"

echo
echo "next:  write $APP_DIR/.env (see .env.example), then sh MeterBots/deploy/deploy.sh"
