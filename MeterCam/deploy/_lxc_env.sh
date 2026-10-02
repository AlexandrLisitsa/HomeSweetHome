# Sourced by the deploy scripts. The container's specification, in one place,
# because three scripts each holding their own idea of the VMID is how you end
# up provisioning one container and deploying into another.
#
# Nothing here is secret -- it is a LAN address and a size. The credentials for
# reaching the hypervisor live in Proxmox/secrets.env and arrive via
# Proxmox/tools/pve_ssh.sh.

# 100 is haos17-1, 101 adguard, 102 tailscale, 103 cloudflare. 104 is next.
VMID=104
LXC_HOSTNAME=metercam

# Pick a free address outside your router's DHCP pool; lxc_create.sh refuses one
# that already answers a ping. These two are documentation placeholders
# (RFC 5737): put your real ones in deploy/lxc.env, which is git-ignored and
# overrides everything in this file (see lxc.env.example).
LXC_IP=192.0.2.8
LXC_GW=192.0.2.1
LXC_BRIDGE=vmbr0

# The only template on the host. Debian 13 = trixie, which is also what
# python:3.12-slim is built on, so the container and the image inside it are
# the same userland -- handy when something only fails on one of them.
LXC_TEMPLATE=local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst

# local-lvm, matching every other guest. It had ~43 GB free when this was
# written, so 8 GB is affordable; `local` is the directory store and holds
# templates and backups, not rootfs.
LXC_STORAGE=local-lvm

# 8 GB where the house convention is 2, and the two reasons are additive:
#
#   - the image. python:3.12-slim plus opencv-python-headless, numpy and the
#     litert runtime measures 640 MB -- a third of adguard's whole rootfs --
#     and the build cache and intermediate layers roughly double that.
#   - the frames. app.py archives every read and prunes nothing: a full-sensor
#     JPEG off this phone is 0.6 MB, and at HA's five-minute poll that is
#     175 MB/day, 5.1 GB/month, forever. lxc_provision.sh installs a retention
#     timer for exactly this reason -- see metercam-prune.timer.
LXC_DISK=8

# Two cores of a four-core Celeron J4105. ORB alignment and eight model
# invocations on a 5 MP frame is a real second or two of arithmetic, and it
# runs at most once every five minutes, so it can afford to be greedy while it
# is running. Leaving two for the host and the HA guest is the point.
LXC_CORES=2

# 1024 against the house's 512, and this is the number to revisit FIRST if the
# host starts swapping. reader.py holds a 2592x1944x3 frame -- 15 MB -- several
# times over through warp and crop, and the Docker daemon wants ~100 MB before
# the service starts.
#
# The host is tight: 3.9 GB total with ~640 MB free and 850 MB of swap already
# in use when this container was specified. LXC memory is a cgroup ceiling and
# not a reservation, so this does not fail to start -- it just means the box
# has no slack, and MeterCam is the newest thing on it.
LXC_MEMORY=1024
LXC_SWAP=1024

LXC_TZ=Europe/Kyiv

# Where the MeterCam tree lands inside the container. docker-compose.yml uses
# relative bind mounts, so the compose file must run from this directory.
APP_DIR=/opt/metercam

# Retention for the archived frames, in days. Rejected frames outlive accepted
# ones by a wide margin: an accepted frame is corroborated by the number that
# came out of it, while a rejected one is the only evidence of a failure nobody
# was watching for.
KEEP_RAW_DAYS=7
KEEP_REJECTED_DAYS=90

# A HARD CEILING on the whole archive, in MB, enforced after the age rules.
#
# Age alone does not bound this and it is worth seeing why. Seven days of raw
# frames at 175 MB/day is already 1.2 GB, and that is the quiet case: the
# rejected tree keeps frames for 90 days, so a misaimed camera -- where every
# single read is refused, which is exactly the state this container is in --
# fills the rejected side at the full poll rate for three months. The age rules
# express what is WORTH keeping; this expresses what there is ROOM for, and on
# an 8 GB rootfs shared with a 640 MB image the second question has an answer
# whether or not anyone asked it.
#
# Over the cap, metercam-prune deletes oldest-first, raw before rejected, for
# the same reason the retention numbers differ.
MAX_ARCHIVE_MB=1024

# Local overrides -- the real LXC_IP and LXC_GW, and anything else above.
if [ -f "$here/lxc.env" ]; then
    . "$here/lxc.env"
fi
