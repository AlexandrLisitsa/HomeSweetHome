#!/bin/sh
# Ship the Portal's configuration (and Homepage, when its version changed) into
# the LXC, restart, health-check.
#
#   sh Portal/deploy/deploy.sh
#
# Idempotent, and the normal way to push a change to a card or a name.
#
# CONFIG ONLY, plus the Homepage build. The box owns /opt/portal/.env (the
# upstream addresses and the widgets' credentials; template Portal/.env.example)
# and a deploy never touches it.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

[ $# -eq 0 ] || { echo "usage: sh Portal/deploy/deploy.sh" >&2; exit 1; }

# --- preflight ------------------------------------------------------------

pve "pct status $VMID" 2>/dev/null | grep -q running || {
    echo "container $VMID is not running. lxc_create.sh / lxc_provision.sh first." >&2
    exit 1
}

pve "pct exec $VMID -- test -f $APP_DIR/.env" || {
    echo "the box has no $APP_DIR/.env, which a deploy does not ship." >&2
    echo "see Portal/README.md, 'First setup'." >&2
    exit 1
}

# Homepage goes in only when the box runs a different version: the build is
# ~50 MB and the config is a few KB.
have=$(pve "pct exec $VMID -- cat $APP_DIR/homepage/VERSION" 2>/dev/null || true)
app=""
if [ "$have" != "$HOMEPAGE_VERSION" ]; then
    echo "box runs Homepage '${have:-none}', want $HOMEPAGE_VERSION."
    sh "$root/tools/build_homepage.sh"
    app="$root/.build/homepage-$HOMEPAGE_VERSION.tar.gz"
fi

# --- pack -----------------------------------------------------------------
#
# --owner/--group/--numeric-owner: built on Windows, where every file is uid
# 197609, which an unprivileged LXC cannot represent (see MeterBots' deploy).

tarball=$(mktemp)
inner=$(mktemp)
trap 'rm -f "$tarball" "$inner"' EXIT

tar czf - -C "$root" --owner=0 --group=0 --numeric-owner \
    caddy homepage systemd > "$tarball"

cat > "$inner" <<INNER
#!/bin/sh
set -eu
cd /tmp
rm -rf portal-deploy && mkdir portal-deploy
tar xzf portal-deploy.tar.gz -C portal-deploy --no-same-owner
src=/tmp/portal-deploy

if [ -f /tmp/portal-homepage.tar.gz ]; then
    echo "== homepage $HOMEPAGE_VERSION =="
    systemctl stop homepage 2>/dev/null || true
    rm -rf "$APP_DIR/homepage.new"
    mkdir "$APP_DIR/homepage.new"
    tar xzf /tmp/portal-homepage.tar.gz -C "$APP_DIR/homepage.new" --no-same-owner
    rm -rf "$APP_DIR/homepage"
    mv "$APP_DIR/homepage.new" "$APP_DIR/homepage"
    rm -f /tmp/portal-homepage.tar.gz
fi
# .next is the one place Homepage writes (the unit is ProtectSystem=strict): its
# cache, and the prerendered page it regenerates when the config changes. The
# build bakes in Homepage's sample config, so that regeneration is what puts
# ours on the page.
mkdir -p "$APP_DIR/homepage/.next/cache"
chown -R portal:portal "$APP_DIR/homepage/.next"

echo "== config =="
# Replaced whole, so a file deleted in git is deleted here too. Readable by
# Homepage, writable by nobody but root.
rm -rf "$APP_DIR/config"
mkdir "$APP_DIR/config"
cp "\$src"/homepage/* "$APP_DIR/config/"
chown -R root:portal "$APP_DIR/config"
chmod 750 "$APP_DIR/config"
chmod 640 "$APP_DIR/config"/*
cp "\$src/caddy/Caddyfile" "$APP_DIR/Caddyfile"
chmod 644 "$APP_DIR/Caddyfile"
chown root:root "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

mkdir -p /etc/systemd/system/caddy.service.d
cp "\$src/systemd/caddy-portal.conf" /etc/systemd/system/caddy.service.d/portal.conf
cp "\$src/systemd/homepage.service" /etc/systemd/system/homepage.service
systemctl daemon-reload

echo "== validate Caddyfile =="
( set -a; . "$APP_DIR/.env"; set +a
  caddy validate --config "$APP_DIR/Caddyfile" --adapter caddyfile )

echo "== restart =="
systemctl enable homepage caddy >/dev/null 2>&1
systemctl restart homepage caddy
rm -rf "\$src" /tmp/portal-deploy.tar.gz
INNER

echo "shipping..."
pve "cat > /tmp/portal-deploy.tar.gz" < "$tarball"
pve "pct push $VMID /tmp/portal-deploy.tar.gz /tmp/portal-deploy.tar.gz"
if [ -n "$app" ]; then
    echo "  + Homepage $HOMEPAGE_VERSION ($(du -h "$app" | cut -f1))"
    pve "cat > /tmp/portal-homepage.tar.gz" < "$app"
    pve "pct push $VMID /tmp/portal-homepage.tar.gz /tmp/portal-homepage.tar.gz"
fi
pve "cat > /tmp/portal-deploy.sh" < "$inner"
pve "pct push $VMID /tmp/portal-deploy.sh /tmp/portal-deploy.sh --perms 755"
status=0
pve "pct exec $VMID -- sh /tmp/portal-deploy.sh" || status=$?
pve "rm -f /tmp/portal-deploy.tar.gz /tmp/portal-homepage.tar.gz /tmp/portal-deploy.sh; pct exec $VMID -- rm -f /tmp/portal-deploy.sh" || true
[ "$status" -eq 0 ] || exit "$status"

# --- verify ---------------------------------------------------------------
#
# Through Caddy, with the Host header a browser sends, so this checks the name,
# the proxy and Homepage's host allow-list at once.

printf 'waiting for home.lan'
i=0
while [ "$i" -lt 30 ]; do
    if pve "pct exec $VMID -- curl -fsS -H 'Host: home.lan' http://127.0.0.1/api/healthcheck" >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    printf '.'
    i=$((i + 1))
    sleep 2
done

if [ "$i" -eq 30 ]; then
    echo " FAILED"
    pve "pct exec $VMID -- journalctl -u homepage -u caddy -n 40 --no-pager" >&2 || true
    exit 1
fi

for name in ha pve adguard meter; do
    code=$(pve "pct exec $VMID -- curl -s -o /dev/null -w '%{http_code}' -H 'Host: $name.lan' http://127.0.0.1/" || true)
    echo "  $name.lan -> $code"
done
