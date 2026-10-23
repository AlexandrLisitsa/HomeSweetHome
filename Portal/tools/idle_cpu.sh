#!/bin/sh
# Measure what the Portal LXC costs the host while nobody is looking.
#
#   sh Portal/tools/idle_cpu.sh            # 600 s
#   sh Portal/tools/idle_cpu.sh 120
#
# Close every tab with home.lan open first, or this measures the tab.
#
# Reads the container's cgroup cpu.stat on the host before and after: every
# process in the guest, its kernel time included, in microseconds. The
# acceptance line (Portal/README.md, "Idle") is under 0.005 cores.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/../deploy/_lxc_env.sh"
pve() { sh "$here/../../Proxmox/tools/pve_ssh.sh" "$@"; }

secs=${1:-600}
stat=/sys/fs/cgroup/lxc/$VMID/cpu.stat

a=$(pve "awk '/^usage_usec/ {print \$2}' $stat")
echo "CT $VMID: measuring for $secs s..."
sleep "$secs"
b=$(pve "awk '/^usage_usec/ {print \$2}' $stat")

awk -v a="$a" -v b="$b" -v s="$secs" 'BEGIN {
    cores = (b - a) / 1e6 / s
    printf "%.5f cores (%.3f%% of one core) -- %s\n", cores, cores * 100,
        (cores < 0.005 ? "PASS" : "FAIL: over 0.005")
}'
