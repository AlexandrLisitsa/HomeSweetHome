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
# A failed upload does not stop the others: every guest, the host config and
# the state archives are tried, a remote folder that missed an upload is not
# pruned, and the job then exits non-zero, which makes vzdump mark it failed.
# Failures, an aborted job and a Drive past DRIVE_WARN_PCT % also go to Home
# Assistant (notify.household) when /etc/default/vzdump-offsite sets
# HA_WEBHOOK_URL (HomeAssistant/config/packages/backup_alerts.yaml). The
# vzdump job's own red row in the UI was the only sign before.
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

# Host-local settings, not in git: HA_WEBHOOK_URL=http://<ha-ip>:8123/api/webhook/<id>
HA_WEBHOOK_URL=""
DRIVE_WARN_PCT=90
[ -r /etc/default/vzdump-offsite ] && . /etc/default/vzdump-offsite

phase="${1:-}"
log() { echo "vzdump-offsite: $*"; }

# One line to Home Assistant, best effort: a backup must never fail because
# the alert could not be sent. Quotes and backslashes are dropped rather than
# escaped, so the JSON stays valid whatever the message holds.
alert() {
    log "ALERT: $*"
    [ -n "$HA_WEBHOOK_URL" ] || return 0
    msg=$(printf '%s' "$*" | tr -d '"\\' | tr '\n' ' ')
    curl -s -m 15 -X POST -H 'Content-Type: application/json' \
        -d "{\"message\": \"$msg\"}" "$HA_WEBHOOK_URL" >/dev/null 2>&1 || true
}

# Everything that went wrong this run, for the summary at the end.
FAILED=""
failed() { FAILED="$FAILED; $*"; log "ERROR: $*"; }

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

# MeterCam (LXC 104) is not dumped: ~400 MB a copy for what is mostly a Docker
# image that rebuilds from git, on a Drive that is already near its 15 GB.
# What cannot be rebuilt is this, a few MB, carried in the same encrypted
# upload as the LXC dumps:
#
#   .env              the HA token and MeterCam's own token
#   config.json       the meter's ROIs (matched to data/ref)
#   data/ref          the alignment reference frame
#   data/firmware     what the camera is offered over OTA
#   models            the digit models (no licence to re-download from git)
#
# Not data/images: the archived photographs are the bulk and are disposable.
METERCAM_VMID="${METERCAM_VMID:-104}"
METERCAM_DIR="/opt/metercam"
metercam_tarball() {
    out="$1/metercam-state-$(date +%Y_%m_%d-%H_%M_%S).tar.zst"
    pct status "$METERCAM_VMID" 2>/dev/null | grep -q running || return 1
    pct exec "$METERCAM_VMID" -- tar -C "$METERCAM_DIR" -cf - --ignore-failed-read \
        .env config.json docker-compose.yml data/ref data/firmware models \
        2>/dev/null | zstd -q -19 > "$out" || return 1
    # A tar that found nothing still writes a valid, tiny archive.
    [ "$(zstd -dc "$out" | tar -tf - | grep -c -E '^(\./)?\.env$')" -ge 1 ] || return 1
    chmod 600 "$out"
    echo "$out"
}

# MeterBots (LXC 105) is not dumped either, for the same reason: its image
# rebuilds from git. Its state is a few KB, and it is the most sensitive thing
# on the host -- a logged-in Telegram account -- so it only ever travels inside
# this encrypted upload:
#
#   .env              the Telegram api_id/api_hash, the bots' tokens and
#                     account numbers
#   data/telegram     the Telegram session
#
# The session may legitimately be missing (logged out), so only .env is
# required for the archive to count.
METERBOTS_VMID="${METERBOTS_VMID:-105}"
METERBOTS_DIR="/opt/meterbots"
meterbots_tarball() {
    out="$1/meterbots-state-$(date +%Y_%m_%d-%H_%M_%S).tar.zst"
    pct status "$METERBOTS_VMID" 2>/dev/null | grep -q running || return 1
    pct exec "$METERBOTS_VMID" -- tar -C "$METERBOTS_DIR" -cf - --ignore-failed-read \
        .env docker-compose.yml data/telegram \
        2>/dev/null | zstd -q -19 > "$out" || return 1
    [ "$(zstd -dc "$out" | tar -tf - | grep -c -E '^(\./)?\.env$')" -ge 1 ] || return 1
    chmod 600 "$out"
    echo "$out"
}

case "$phase" in
metercam-state)
    # By hand: `vzdump-offsite.sh metercam-state /tmp` writes the archive
    # and prints its path, to check what goes off-site without a backup run.
    metercam_tarball "${2:-/tmp}" || { log "ERROR: MeterCam state archive failed"; exit 1; }
    ;;

meterbots-state)
    # By hand, the same for MeterBots: `vzdump-offsite.sh meterbots-state /tmp`.
    meterbots_tarball "${2:-/tmp}" || { log "ERROR: MeterBots state archive failed"; exit 1; }
    ;;

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
        # A failed archive or upload must not cost the others their off-site
        # copy: try everything, then fail the job at the end.
        mcs=$(metercam_tarball "$tmp") || { mcs=""; \
            failed "MeterCam state archive (is LXC $METERCAM_VMID running?)"; }
        mbs=$(meterbots_tarball "$tmp") || { mbs=""; \
            failed "MeterBots state archive (is LXC $METERBOTS_VMID running?)"; }

        missed=""   # remote folders an upload to failed this run
        for dest in weekly $(first_run_of_month && echo monthly); do
            for b in $lxc_bases; do
                log "copy $b -> $dest/"
                $RCLONE copy "$dumpdir" "${REMOTE}$dest/" --include "$b.*" \
                    || { missed="$missed $dest"; failed "upload $b -> $dest/"; }
            done
            for f in "$cfg" $mcs $mbs; do
                log "copy $(basename "$f") -> $dest/"
                $RCLONE copy "$f" "${REMOTE}$dest/" \
                    || { missed="$missed $dest"; failed "upload $(basename "$f") -> $dest/"; }
            done
        done

        # Both folders are pruned every run, by age -- except one this run
        # could not fill: that would trade an old copy for nothing.
        for dest in weekly monthly; do
            case " $missed " in
            *" $dest "*) log "not pruning $dest/: an upload to it failed"; continue ;;
            esac
            [ "$dest" = weekly ] && age="$WEEKLY_MAX_AGE" || age="$MONTHLY_MAX_AGE"
            log "prune $dest/ older than $age"
            # mkdir first: rclone delete fails on a folder that doesn't exist yet.
            { $RCLONE mkdir "${REMOTE}$dest/" \
                && $RCLONE delete "${REMOTE}$dest/" --min-age "$age"; } \
                || failed "prune $dest/"
        done
    fi

    if [ -n "$vm_bases" ] && first_run_of_month; then
        # The excludes go through a file, not the command line: an unquoted
        # "--exclude $b.*" is a shell glob, expanded against whatever the
        # hook's working directory happens to hold.
        keep=$(mktemp)
        vm_ok=1
        for b in $vm_bases; do
            log "copy $b -> monthly-vm/"
            $RCLONE copy "$dumpdir" "${REMOTE}monthly-vm/" --include "$b.*" \
                || log "rclone copy of $b reported an error; checking what landed"
            # Proof, not rclone's exit status: `copy --include` that matches
            # nothing transfers nothing and still exits 0. If this name is not
            # on the remote now, deleting "everything else" would delete every
            # off-site copy of the VM and put nothing in its place.
            if ! $RCLONE lsf "${REMOTE}monthly-vm/" --include "$b.*" | grep -q "^$b\.vma"; then
                vm_ok=0
                failed "$b is not in monthly-vm/ after the copy; kept the old copies"
                continue
            fi
            printf '%s.*\n' "$b" >> "$keep"
        done
        # Only once every new copy is confirmed: drop the previous month's.
        if [ "$vm_ok" -eq 1 ]; then
            log "drop older monthly-vm/ copies"
            $RCLONE delete "${REMOTE}monthly-vm/" --exclude-from "$keep" \
                || failed "drop older monthly-vm/ copies"
        fi
        rm -f "$keep"
    fi

    $RCLONE rmdirs "$REMOTE" --leave-root || log "rmdirs failed (empty folders left, harmless)"
    rm -f "$QUEUE" "$FORCE_MONTHLY"

    # The Drive is shared with Gmail and Photos, and full means no off-site
    # copies at all from the next run on. Say so while there is room left.
    # Used = total - free: Drive counts Gmail and Photos against the same
    # quota, and rclone files only some of that under "used".
    drive=$(echo "$REMOTE" | sed 's/-crypt:$/:/')
    about=$($RCLONE about "$drive" --json 2>/dev/null | tr -d ' \t\r\n') || about=""
    total=$(echo "$about" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')
    free=$(echo "$about" | sed -n 's/.*"free":\([0-9]*\).*/\1/p')
    pct_used=$(awk -v t="${total:-0}" -v f="${free:-x}" \
        'BEGIN { if (t > 0 && f ~ /^[0-9]+$/) printf "%d", (t - f) * 100 / t }')
    if [ -n "$pct_used" ] && [ "$pct_used" -ge "$DRIVE_WARN_PCT" ]; then
        alert "Google Drive is ${pct_used}% full; off-site backups stop when it is full"
    fi

    if [ -n "$FAILED" ]; then
        alert "Off-site backup finished with errors:${FAILED#;}"
        exit 1
    fi
    log "done${pct_used:+, Drive ${pct_used}% used}"
    ;;

job-abort)
    rm -f "$QUEUE"
    alert "A vzdump backup job was aborted; nothing went off-site this run"
    ;;
esac

exit 0
