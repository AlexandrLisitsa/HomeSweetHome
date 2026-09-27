#!/bin/sh
# vzdump hook: copy finished backups to Google Drive, encrypted, and apply the
# off-site retention. Runs ON THE PROXMOX HOST, as root, called by vzdump.
#
#   install -m 0755 Proxmox/tools/vzdump-offsite.sh /usr/local/bin/vzdump-offsite.sh
#   then set "Hook script" on both backup jobs (see docs/backups.md)
#
# vzdump calls it as `vzdump-offsite.sh <phase> [<mode> <vmid>]`, with TARGET,
# VMTYPE and DUMPDIR in the environment. It only acts on two phases:
#
#   backup-end  remember the finished archive (TARGET), by guest type
#   job-end     upload what was remembered, then prune the remote
#
# LXC dumps go to weekly/ every run and also to monthly/ on the month's first
# run (day 1-7: the jobs are weekly, on Sundays). The VM dump goes off-site only
# on the month's first run, to monthly-vm/, and replaces the previous one there
# after the upload has succeeded. A host-config tarball goes along with the LXCs.
#
# Any failure exits non-zero, which makes vzdump mark the job as failed.
#
# The remote is an rclone crypt remote (REMOTE, default gdrive-crypt:) over a
# Google Drive remote, configured interactively with `rclone config`; its
# passwords live only in /root/.config/rclone/rclone.conf and the household
# password manager.

set -eu

# vzdump runs hooks with no HOME and a minimal PATH; rclone needs both spelled
# out or it can't find its config (and getent).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="${HOME:-/root}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"

REMOTE="${VZDUMP_OFFSITE_REMOTE:-gdrive-crypt:}"
WEEKLY_MAX_AGE="29d"    # 4 weekly runs
MONTHLY_MAX_AGE="93d"   # 3 monthly runs
QUEUE="/run/vzdump-offsite.queue"
RCLONE="rclone --config $RCLONE_CONFIG --retries 3 --low-level-retries 10 --stats-one-line --stats 60s"

phase="${1:-}"
log() { echo "vzdump-offsite: $*"; }

# The archive's base name without the compression suffix, e.g.
# vzdump-lxc-101-2026_09_27-03_30_00 for vzdump-lxc-101-2026_09_27-03_30_00.tar.zst,
# so the .log and .notes files next to it travel with it.
base_of() {
    b=$(basename "$1")
    echo "${b%%.*}"
}

# `touch /run/vzdump-offsite.force-monthly` makes the next job count as the
# month's first, to test the monthly paths by hand (vzdump doesn't pass its
# environment to hooks, so a variable wouldn't reach here). job-end removes it.
FORCE_MONTHLY="/run/vzdump-offsite.force-monthly"
first_run_of_month() {
    [ -e "$FORCE_MONTHLY" ] || [ "$(date +%-d)" -le 7 ]
}

host_config_tarball() {
    out="$1/pve-host-config-$(date +%Y_%m_%d-%H_%M_%S).tar.zst"
    # /etc/pve holds the guest configs, storage and backup jobs, users and the
    # cluster keys; the rest is what makes this host this host. rclone.conf is
    # left out: it holds the Drive token and the crypt passwords.
    tar --zstd -cf "$out" --ignore-failed-read \
        /etc/pve /etc/network/interfaces /etc/hosts /etc/hostname \
        /etc/vzdump.conf /etc/apt/sources.list.d /usr/local/bin/vzdump-offsite.sh \
        >/dev/null 2>&1
    echo "$out"
}

case "$phase" in
job-start)
    : > "$QUEUE"
    ;;

backup-end)
    # TARGET is the archive just written, VMTYPE is lxc or qemu.
    echo "${VMTYPE:-unknown} ${DUMPDIR:-$(dirname "$TARGET")} $(base_of "$TARGET")" >> "$QUEUE"
    ;;

job-end)
    [ -s "$QUEUE" ] || { log "nothing to upload"; exit 0; }

    lxc_bases=$(awk '$1 == "lxc" { print $3 }' "$QUEUE")
    vm_bases=$(awk '$1 == "qemu" { print $3 }' "$QUEUE")
    dumpdir=$(awk 'NR == 1 { print $2 }' "$QUEUE")

    if [ -n "$lxc_bases" ]; then
        tmp=$(mktemp -d)
        trap 'rm -rf "$tmp"' EXIT
        cfg=$(host_config_tarball "$tmp")

        for dest in weekly $(first_run_of_month && echo monthly); do
            for b in $lxc_bases; do
                log "copy $b -> $dest/"
                $RCLONE copy "$dumpdir" "${REMOTE}$dest/" --include "$b.*"
            done
            log "copy $(basename "$cfg") -> $dest/"
            $RCLONE copy "$cfg" "${REMOTE}$dest/"
        done

        log "prune weekly/ older than $WEEKLY_MAX_AGE, monthly/ older than $MONTHLY_MAX_AGE"
        # mkdir first: rclone delete fails on a folder that doesn't exist yet.
        $RCLONE mkdir "${REMOTE}weekly/"
        $RCLONE mkdir "${REMOTE}monthly/"
        $RCLONE delete "${REMOTE}weekly/" --min-age "$WEEKLY_MAX_AGE"
        $RCLONE delete "${REMOTE}monthly/" --min-age "$MONTHLY_MAX_AGE"
    fi

    if [ -n "$vm_bases" ] && first_run_of_month; then
        keep=""
        for b in $vm_bases; do
            log "copy $b -> monthly-vm/"
            $RCLONE copy "$dumpdir" "${REMOTE}monthly-vm/" --include "$b.*"
            keep="$keep --exclude $b.*"
        done
        # Only now that the new copy is complete: drop the previous month's.
        log "drop older monthly-vm/ copies"
        # shellcheck disable=SC2086
        $RCLONE delete "${REMOTE}monthly-vm/" $keep
    fi

    $RCLONE rmdirs "$REMOTE" --leave-root
    rm -f "$QUEUE" "$FORCE_MONTHLY"
    log "done"
    ;;

job-abort)
    rm -f "$QUEUE"
    ;;
esac

exit 0
