#!/bin/sh
# Install Caddy and Node inside the Portal LXC, and switch off what it does not
# need.
#
#   sh Portal/deploy/lxc_provision.sh
#
# Idempotent: safe to re-run, or to repair a container someone has poked at. It
# installs no Homepage build and no configuration -- that is deploy.sh.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

pve "pct status $VMID" >/dev/null 2>&1 || {
    echo "container $VMID does not exist. Run lxc_create.sh first." >&2
    exit 1
}
pve "pct status $VMID" | grep -q running || pve "pct start $VMID"

# Pushed in as a file and run by path, as MeterBots' provisioning does: two
# rounds of shell quoting through ssh and pct exec eat quotes silently.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" <<INNER
#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive

echo "== base packages =="
apt-get update -qq
# caddy from Debian: 2.6, security-patched by Debian, and a plain systemd unit.
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils caddy

echo "== node $NODE_VERSION =="
if [ "\$(/opt/node/bin/node -v 2>/dev/null || true)" = "$NODE_VERSION" ]; then
    echo "already installed"
else
    # The official tarball, checked against nodejs.org's SHASUMS256. Debian's
    # nodejs is 20.x; Homepage's own image runs 22, so this does too.
    cd /tmp
    name=node-$NODE_VERSION-linux-x64.tar.xz
    curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/\$name"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " \$name\\\$" | sha256sum -c -
    rm -rf /opt/node
    mkdir -p /opt/node
    tar xJf "\$name" -C /opt/node --strip-components=1 --no-same-owner
    rm -f "\$name"
fi
/opt/node/bin/node -v

echo "== user and directories =="
id portal >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin portal
mkdir -p "$APP_DIR/config" "$APP_DIR/homepage"
chown root:portal "$APP_DIR/config"
chmod 750 "$APP_DIR/config"

echo "== idle trim =="
# Nothing in this container may wake up on its own while nobody is looking at
# the dashboard. postfix's pickup and qmgr poll every minute; ssh is never
# used (everything arrives through pct exec from the host). The daily apt,
# logrotate and man-db timers stay: once a day is not idle load.
for unit in postfix.service ssh.service ssh.socket; do
    systemctl disable --now "\$unit" 2>/dev/null || true
done

echo
echo "provisioned."
caddy version
INNER

echo "pushing provisioning script into $VMID..."
pve "cat > /tmp/portal-provision.sh" < "$tmp"
pve "pct push $VMID /tmp/portal-provision.sh /tmp/portal-provision.sh --perms 755"
pve "pct exec $VMID -- sh /tmp/portal-provision.sh"
pve "rm -f /tmp/portal-provision.sh" || true

echo
echo "next:  write $APP_DIR/.env (see Portal/.env.example), then sh Portal/deploy/deploy.sh"
