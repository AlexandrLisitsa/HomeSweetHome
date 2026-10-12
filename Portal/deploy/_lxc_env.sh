# Sourced by the deploy scripts. The container's specification, in one place,
# so no two scripts can disagree about which container they are working on.
#
# Nothing here is secret -- it is a LAN address, a size and two versions.

# 100 is haos17-1, 101 adguard, 102 tailscale, 103 cloudflare, 104 metercam,
# 105 meterbots. 106 is this one; 107 is next.
VMID=106
LXC_HOSTNAME=portal

# Pick a free address in the house's static block (root README, "Network");
# lxc_create.sh refuses one that already answers a ping. These two are
# documentation placeholders (RFC 5737): put the real ones in deploy/lxc.env,
# which is git-ignored and overrides everything in this file.
LXC_IP=192.0.2.11
LXC_GW=192.0.2.1
LXC_BRIDGE=vmbr0

LXC_TEMPLATE=local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst
LXC_STORAGE=local-lvm

# The house defaults. Node is ~120 MB on disk, the Homepage build ~150 MB, and
# Homepage's server sits at ~100 MB of RAM. No Docker, so no image layers.
LXC_DISK=2
LXC_CORES=1
LXC_MEMORY=512
LXC_SWAP=512

LXC_TZ=Europe/Kyiv

# What runs. Homepage is built on the workstation by tools/build_homepage.sh
# (the host has no RAM to spare for a Next.js build) and runs on the official
# Node tarball, the same major version Homepage's own image is built on.
# Bumping either is a change here plus `deploy.sh`.
HOMEPAGE_VERSION=v2.4.0
NODE_VERSION=v22.23.3

APP_DIR=/opt/portal

# Local overrides -- the real LXC_IP and LXC_GW.
if [ -f "$here/lxc.env" ]; then
    . "$here/lxc.env"
fi
