#!/bin/sh
# Create the MeterCam LXC on the Proxmox host. Run once.
#
#   sh MeterCam/deploy/lxc_create.sh          # prints the spec, then asks
#   sh MeterCam/deploy/lxc_create.sh -y       # for a re-run you have thought about
#
# Creating a container is the one genuinely destructive-adjacent step here --
# it allocates an 8 GB logical volume on a host with 43 GB free and takes an
# address on the LAN -- so it prints exactly what it is about to do and waits.
# Everything after this point (provision, deploy) is idempotent and safe to
# repeat; this is not, and it refuses rather than adopting a container that
# already exists under this VMID.
#
# Undo is `pct stop 104 && pct destroy 104` on the host, which also frees the
# volume. Nothing outside the container is touched.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lxc_env.sh"

pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

assume_yes=0
[ "${1:-}" = "-y" ] && assume_yes=1

# --- preflight ------------------------------------------------------------
# Each of these has cost someone an evening somewhere, so they are checked
# before anything is allocated rather than diagnosed after.

printf 'checking hypervisor reachable... '
pve true >/dev/null 2>&1 || {
    echo "FAILED"
    echo "cannot ssh to the Proxmox host." >&2
    echo "see 'The write path' in Proxmox/README.md -- the key has to be" >&2
    echo "installed on the host once, from its own UI shell." >&2
    exit 1
}
echo "ok"

printf 'checking VMID %s is free... ' "$VMID"
if pve "pct status $VMID" >/dev/null 2>&1; then
    echo "NO"
    echo "container $VMID already exists. This script does not adopt or" >&2
    echo "reconfigure it -- run lxc_provision.sh and deploy.sh instead, or" >&2
    echo "destroy it first with: pct stop $VMID && pct destroy $VMID" >&2
    exit 1
fi
echo "ok"

printf 'checking %s is unused... ' "$LXC_IP"
if pve "ping -c1 -W1 $LXC_IP" >/dev/null 2>&1; then
    echo "NO"
    echo "$LXC_IP answers a ping already. Pick another address in" >&2
    echo "deploy/lxc.env (see lxc.env.example)." >&2
    exit 1
fi
echo "ok"

printf 'checking template present... '
pve "pveam list local | grep -q '${LXC_TEMPLATE#local:vztmpl/}'" || {
    echo "NO"
    echo "$LXC_TEMPLATE is not on the host. Download it with:" >&2
    echo "  pveam update && pveam download local ${LXC_TEMPLATE#local:vztmpl/}" >&2
    exit 1
}
echo "ok"

# --- the spec -------------------------------------------------------------

cat <<SPEC

  About to create, on $(pve hostname):

    VMID        $VMID
    hostname    $LXC_HOSTNAME
    address     $LXC_IP/24 via $LXC_GW on $LXC_BRIDGE
    template    $LXC_TEMPLATE
    rootfs      $LXC_STORAGE, ${LXC_DISK} GB
    cores       $LXC_CORES
    memory      ${LXC_MEMORY} MB + ${LXC_SWAP} MB swap
    features    nesting=1,keyctl=1   (unprivileged, Docker needs both)
    onboot      yes

SPEC

if [ "$assume_yes" -eq 0 ]; then
    printf 'proceed? [y/N] '
    read -r reply
    case "$reply" in
        y|Y|yes|YES) ;;
        *) echo "aborted."; exit 1 ;;
    esac
fi

# --- create ---------------------------------------------------------------
#
# unprivileged with nesting=1,keyctl=1 is the combination Docker needs inside
# an LXC: nesting for the mount and cgroup namespaces, keyctl because the
# daemon calls keyctl() at startup and an unprivileged container without it
# fails in a way that reads as a permissions bug in Docker. adguard (101) has
# run exactly this pair for a year, so it is proven on this host.
#
# No --password and no --ssh-public-keys: provisioning and deployment both go
# through `pct exec` from the host, so the container never needs a login of its
# own. One less credential to rotate, and one less service listening.

pve "pct create $VMID $LXC_TEMPLATE \
    --hostname $LXC_HOSTNAME \
    --cores $LXC_CORES \
    --memory $LXC_MEMORY \
    --swap $LXC_SWAP \
    --rootfs ${LXC_STORAGE}:${LXC_DISK} \
    --net0 name=eth0,bridge=${LXC_BRIDGE},firewall=1,gw=${LXC_GW},ip=${LXC_IP}/24,type=veth \
    --features nesting=1,keyctl=1 \
    --unprivileged 1 \
    --onboot 1 \
    --ostype debian \
    --timezone $LXC_TZ \
    --tags metercam \
    --description 'MeterCam -- gas meter OCR. HomeSweetHome/MeterCam. Deployed by MeterCam/deploy/.'"

echo "created. starting..."
pve "pct start $VMID"

# The container is up before its network is, and provisioning's first act is an
# apt update. Waiting here turns a confusing DNS failure into a clear timeout.
printf 'waiting for network'
i=0
while [ "$i" -lt 30 ]; do
    if pve "pct exec $VMID -- getent hosts deb.debian.org" >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    printf '.'
    i=$((i + 1))
    sleep 2
done
[ "$i" -eq 30 ] && { echo " TIMEOUT"; echo "container is up but cannot resolve DNS. Check the bridge." >&2; exit 1; }

echo
echo "container $VMID is up at $LXC_IP."
echo "next:  sh MeterCam/deploy/lxc_provision.sh"
