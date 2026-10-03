# Sourced by the deploy scripts. The container's specification, in one place,
# so no two scripts can disagree about which container they are working on.
#
# Nothing here is secret -- it is a LAN address and a size. The credentials for
# reaching the hypervisor live in Proxmox/secrets.env and arrive via
# Proxmox/tools/pve_ssh.sh.

# 100 is haos17-1, 101 adguard, 102 tailscale, 103 cloudflare, 104 metercam.
# 105 is this one; 106 is next.
VMID=105
LXC_HOSTNAME=meterbots

# Pick a free address in the house's static block (root README, "Network");
# lxc_create.sh refuses one that already answers a ping. These two are
# documentation placeholders (RFC 5737): put the real ones in deploy/lxc.env,
# which is git-ignored and overrides everything in this file.
LXC_IP=192.0.2.10
LXC_GW=192.0.2.1
LXC_BRIDGE=vmbr0

# Debian 13 = trixie, the same userland python:3.12-slim is built on.
LXC_TEMPLATE=local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst
LXC_STORAGE=local-lvm

# The house defaults. The image is python:3.12-slim plus flask and telethon,
# about 200 MB; the only state is a session file and .env. MeterCam needed
# 8 GB and 1 GB for OpenCV and its frames; nothing here does.
LXC_DISK=2
LXC_CORES=1
LXC_MEMORY=512
LXC_SWAP=512

LXC_TZ=Europe/Kyiv

# Where the MeterBots tree lands inside the container. docker-compose.yml
# uses a relative bind mount, so compose must run from this directory.
APP_DIR=/opt/meterbots

# Local overrides -- the real LXC_IP and LXC_GW.
if [ -f "$here/lxc.env" ]; then
    . "$here/lxc.env"
fi
