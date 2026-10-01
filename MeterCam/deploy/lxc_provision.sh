#!/bin/sh
# Install Docker and the frame-retention timer inside the MeterCam LXC.
#
#   sh MeterCam/deploy/lxc_provision.sh
#
# Idempotent: safe to re-run after changing a retention day count, or to repair
# a container someone has poked at. It installs no application code -- that is
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
# `pct exec 104 -- sh -c '...'` through ssh means the script survives two
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
mkdir -p "$APP_DIR/data"

echo "== frame retention =="
# app.py's archive() writes a full-sensor JPEG on every read and deletes
# nothing -- deliberately, because a rejected frame is the only evidence of a
# failure that nobody watched happen. At 0.6 MB a frame and HA's five-minute
# poll that is 175 MB/day, so somebody has to delete them and it should not be
# a person remembering to.
#
# Rejected frames outlive accepted ones by a wide margin. An accepted frame is
# corroborated by the reading that came out of it; a rejected one is the whole
# record of why.
cat > /usr/local/bin/metercam-prune <<'PRUNE'
#!/bin/sh
set -eu
images="__APP_DIR__/data/images"
cap=\$((__MAX_MB__ * 1024 * 1024))
[ -d "\$images" ] || exit 0

# 1. AGE. Rejected frames outlive accepted ones by a wide margin: an accepted
#    frame is corroborated by the reading that came out of it, a rejected one
#    is the whole record of why.
find "\$images" -type f -path '*/raw/*'      -mtime +__KEEP_RAW__      -delete
find "\$images" -type f -path '*/rejected/*' -mtime +__KEEP_REJECTED__ -delete

# 2. SIZE, as a hard ceiling. The age rules say what is worth keeping; this
#    says what there is room for, and they are not the same question. Seven
#    days of raw frames is already ~1.2 GB, and the rejected tree holds 90 days
#    -- so a camera that has drifted out of alignment, refusing every read,
#    fills it at the full poll rate for a quarter of a year.
used=\$(find "\$images" -type f -printf '%s\n' 2>/dev/null | awk '{s+=\$1} END {print s+0}')
if [ "\$used" -gt "\$cap" ]; then
    need=\$((used - cap))
    # Oldest first, and RAW before REJECTED -- the same ordering the retention
    # numbers already express. Rejected frames are only touched once deleting
    # every raw frame still leaves the archive over the ceiling.
    { find "\$images" -type f -path '*/raw/*'      -printf '%T@\t%s\t%p\n' 2>/dev/null | sort -n
      find "\$images" -type f -path '*/rejected/*' -printf '%T@\t%s\t%p\n' 2>/dev/null | sort -n
    } | awk -F'\t' -v need="\$need" 'freed >= need { exit } { freed += \$2; print \$3 }' \
      | while IFS= read -r victim; do
            rm -f "\$victim"
            # The .txt carries the rejection reason. A frame without it is an
            # unexplained picture, so the pair goes together.
            case "\$victim" in *.jpg) rm -f "\${victim%.jpg}.txt" ;; esac
        done
fi

# Frames are foldered by date, so ageing them out leaves the day's directory
# behind -- empty, and a year of those is a year of noise in a listing whose
# whole purpose is being browsed. mindepth 3 is <meter>/<class>/<date>, so only
# the date folders are candidates; raw/ and rejected/ stay either way.
find "\$images" -mindepth 3 -type d -empty -delete
PRUNE
sed -i "s|__APP_DIR__|$APP_DIR|; s|__KEEP_RAW__|$KEEP_RAW_DAYS|; s|__KEEP_REJECTED__|$KEEP_REJECTED_DAYS|; s|__MAX_MB__|$MAX_ARCHIVE_MB|" \
    /usr/local/bin/metercam-prune
chmod +x /usr/local/bin/metercam-prune

cat > /etc/systemd/system/metercam-prune.service <<'UNIT'
[Unit]
Description=MeterCam archived frame retention

[Service]
Type=oneshot
ExecStart=/usr/local/bin/metercam-prune
UNIT

cat > /etc/systemd/system/metercam-prune.timer <<'UNIT'
[Unit]
Description=MeterCam archived frame retention (hourly)

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now metercam-prune.timer

echo
echo "provisioned."
docker --version
docker compose version
echo "retention: raw $KEEP_RAW_DAYS days, rejected $KEEP_REJECTED_DAYS days, cap ${MAX_ARCHIVE_MB} MB"
INNER

echo "pushing provisioning script into $VMID..."
pve "cat > /tmp/metercam-provision.sh" < "$tmp"
pve "pct push $VMID /tmp/metercam-provision.sh /tmp/metercam-provision.sh --perms 755"
pve "pct exec $VMID -- sh /tmp/metercam-provision.sh"

echo
echo "next:  sh MeterCam/deploy/deploy.sh"
