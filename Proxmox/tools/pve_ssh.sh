#!/bin/sh
# Run a command on the Proxmox host as root, over SSH.
#
#   sh Proxmox/tools/pve_ssh.sh pveversion
#   sh Proxmox/tools/pve_ssh.sh pct list
#   sh Proxmox/tools/pve_ssh.sh 'pct exec 104 -- docker ps'
#
# This is the WRITE path, and it is separate from pve_get.sh on purpose.
#
# The key behind it is a GENERAL ADMINISTRATIVE key for this host, not a
# per-project one: root@pam, able to create and destroy guests, edit configs,
# read every disk and reboot the box. MeterCam's container is its first
# consumer and will not be its last, so treat anything run through here as
# what it is rather than as deployment plumbing.
#
# The module's README used to say there was deliberately no write helper, and
# that was right while the only question was "how much CPU is the HA guest
# using". Needing a container changed the question. It did not change the
# reasoning: the API token stays PVEAuditor, so nothing that merely reads the
# hypervisor can alter it, and everything that alters it comes through here --
# where it is a root shell, looks like a root shell, and gets the caution a
# root shell is due.
#
# That split makes intent legible, not capability limited. It stops a metrics
# script from writing; it does not stop this one from doing anything at all.
#
# It is SSH rather than a second, write-capable token because provisioning is
# not one call. `pct create` has an API equivalent; `pct exec` does not -- the
# API offers a websocket terminal, which is not something a shell script should
# be driving. Half the job would be REST and half would be SSH, so it is all SSH.
set -eu

. "$(dirname "$0")/_pve_env.sh"
_pve_ssh_env_load

if [ "$#" -eq 0 ]; then
    echo "usage: pve_ssh.sh <command> [args...]" >&2
    echo "       pve_ssh.sh 'pct exec 104 -- docker ps'" >&2
    exit 1
fi

# BatchMode: fail with an error instead of hanging on a password prompt. A
# script that stops dead waiting for input it cannot receive looks like a
# network problem and is really a missing key.
exec ssh -i "$PVE_SSH_KEY" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 \
    "${PVE_SSH_USER}@${PVE_SSH_HOST}" "$@"
