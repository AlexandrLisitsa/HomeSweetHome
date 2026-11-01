#!/bin/sh
# Run vzdump-offsite.sh's job-end and job-abort against a fake Drive, a fake
# Proxmox and a fake Home Assistant, in a throwaway Debian container.
#
#   sh Proxmox/tools/test_vzdump_offsite.sh          (needs Docker)
#
# The hook deletes off-site copies, so what it does when an upload fails is
# the part worth pinning: every other upload still happens, a folder that
# missed an upload is not pruned, the old VM copy survives a failed new one,
# and the household hears about it. Nothing here touches a real host.
#
# The hook sets its own PATH with /usr/local/bin first, so fakes installed
# there stand in for rclone, pct, curl, zstd and `date +%-d`.
set -eu

if [ "${1:-}" != "--inside" ]; then
    here=$(cd "$(dirname "$0")" && pwd)
    exec env MSYS_NO_PATHCONV=1 docker run --rm -v "$here:/t:ro" debian:stable-slim \
        sh /t/test_vzdump_offsite.sh --inside
fi

HOOK=/t/vzdump-offsite.sh
W=/work
LOG=$W/calls.log
mkdir -p $W/dump /etc/default /run
export LOG

# --- fakes --------------------------------------------------------------------
cat > /usr/local/bin/rclone <<'EOF'
#!/bin/sh
# Logs every call. FAIL_RE: an extended regex; a call whose arguments match
# it exits 1. LANDED: "1" makes lsf list the VM archive it was asked about.
args="$*"
echo "rclone $args" >> "$LOG"
if [ -n "${FAIL_RE:-}" ] && echo "$args" | grep -Eq "$FAIL_RE"; then exit 1; fi
case "$args" in
    *" lsf "*)
        [ "${LANDED:-1}" = 1 ] && echo "$args" | sed -n 's/.*--include \([^ ]*\)\.\*.*/\1.vma.zst/p'
        ;;
    *" about "*)
        printf '{\n\t"total": 16106127360,\n\t"used": 1,\n\t"free": %s\n}\n' "${FREE:-8131510272}"
        ;;
esac
exit 0
EOF
cat > /usr/local/bin/pct <<'EOF'
#!/bin/sh
# STOPPED: a VMID that is not running.
case "$1" in
    status) [ "$2" = "${STOPPED:-none}" ] && echo "status: stopped" || echo "status: running" ;;
    exec)
        d=$(mktemp -d); : > "$d/.env"; mkdir -p "$d/data/telegram"
        tar -C "$d" -cf - .env data
        ;;
esac
EOF
cat > /usr/local/bin/curl <<'EOF'
#!/bin/sh
echo "curl $*" >> "$LOG"
EOF
cat > /usr/local/bin/zstd <<'EOF'
#!/bin/sh
# Compression is not under test: pass bytes through.
for a; do case "$a" in -d*c|-dc) shift; exec cat "$@" ;; esac; done
exec cat
EOF
cat > /usr/local/bin/date <<'EOF'
#!/bin/sh
[ "$*" = "+%-d" ] && { echo "${DAY:-15}"; exit 0; }
exec /bin/date "$@"
EOF
chmod +x /usr/local/bin/*

# --- harness ------------------------------------------------------------------
fails=0
n=0
check() {   # check <name> <command...>
    name=$1; shift
    n=$((n + 1))
    if "$@"; then echo "  ok   $name"; else echo "  FAIL $name"; fails=$((fails + 1)); fi
}
has() { grep -Eq -- "$1" "$LOG"; }
hasnt() { ! grep -Eq -- "$1" "$LOG"; }

# run <queue lines>: a job-end with this queue; sets $rc.
run() {
    : > "$LOG"
    printf '%s\n' "$@" > /run/vzdump-offsite.queue
    set +e
    sh "$HOOK" job-end > $W/out.log 2>&1
    rc=$?
    set -e
}

LXC="lxc $W/dump vzdump-lxc-101-x
lxc $W/dump vzdump-lxc-102-x
lxc $W/dump vzdump-lxc-103-x"
VM="qemu $W/dump vzdump-qemu-100-x"
echo 'HA_WEBHOOK_URL=http://ha.test/api/webhook/abc' > /etc/default/vzdump-offsite

echo "a normal weekly run"
export DAY=15 FAIL_RE="" STOPPED=none FREE=8131510272 LANDED=1
run "$LXC"
check "exits 0" [ "$rc" -eq 0 ]
check "every LXC to weekly/" sh -c 'for g in 101 102 103; do grep -q "copy $0 gdrive-crypt:weekly/ --include vzdump-lxc-$g-x" "$LOG" || exit 1; done' "$W/dump"
check "host config and both state archives to weekly/" sh -c \
    'for f in pve-host-config metercam-state meterbots-state; do grep -Eq "copy /tmp/[^ ]*/$f-[^ ]* gdrive-crypt:weekly/" "$LOG" || exit 1; done'
check "nothing copied to monthly/ mid-month" hasnt "copy .* gdrive-crypt:monthly/"
check "weekly/ pruned at 29 days" has "delete gdrive-crypt:weekly/ --min-age 29d"
check "monthly/ pruned at 93 days every run, as before" has "delete gdrive-crypt:monthly/ --min-age 93d"
check "no alert" hasnt "^curl"

echo "one LXC upload fails"
export FAIL_RE="copy .* --include vzdump-lxc-102-x"
run "$LXC"
check "exits 1, so vzdump marks the job failed" [ "$rc" -eq 1 ]
check "the guest after it is still uploaded" has "--include vzdump-lxc-103-x"
check "the state archives are still uploaded" has "meterbots-state-.* gdrive-crypt:weekly/"
check "weekly/ is not pruned" hasnt "delete gdrive-crypt:weekly/"
check "monthly/ (nothing failed there) still is" has "delete gdrive-crypt:monthly/ --min-age 93d"
check "Home Assistant hears which upload failed" has '^curl .*upload vzdump-lxc-102-x -> weekly/'
check "the alert goes to the configured webhook" has "^curl .*http://ha.test/api/webhook/abc"

echo "the month's first run, monthly/ fails"
export DAY=3 FAIL_RE="copy .*pve-host-config.* gdrive-crypt:monthly/"
run "$LXC"
check "exits 1" [ "$rc" -eq 1 ]
check "monthly/ gets the guests" has "--include vzdump-lxc-101-x"
check "weekly/ is still pruned (it got everything)" has "delete gdrive-crypt:weekly/ --min-age 29d"
check "monthly/ is not pruned" hasnt "delete gdrive-crypt:monthly/"

echo "the month's first run, all fine"
export FAIL_RE=""
run "$LXC"
check "exits 0" [ "$rc" -eq 0 ]
check "monthly/ pruned at 93 days" has "delete gdrive-crypt:monthly/ --min-age 93d"

echo "MeterCam is not running"
export DAY=15 STOPPED=104
run "$LXC"
check "exits 1" [ "$rc" -eq 1 ]
check "no MeterCam archive goes up" hasnt "metercam-state"
check "MeterBots' archive and the guests still do" sh -c 'grep -q meterbots-state "$LOG" && grep -q vzdump-lxc-103-x "$LOG"'
check "and the alert names it" has '^curl .*MeterCam state archive'
export STOPPED=none

echo "the VM, month's first run"
export DAY=2 LANDED=1
run "$VM"
check "exits 0" [ "$rc" -eq 0 ]
check "copied to monthly-vm/" has "copy $W/dump gdrive-crypt:monthly-vm/ --include vzdump-qemu-100-x"
check "older copies dropped, the new one kept" has "delete gdrive-crypt:monthly-vm/ --exclude-from"

echo "the VM upload fails and nothing lands"
export FAIL_RE="copy .*monthly-vm/" LANDED=0
run "$VM"
check "exits 1" [ "$rc" -eq 1 ]
check "the previous month's copy is NOT deleted" hasnt "delete gdrive-crypt:monthly-vm/"
check "the alert says the old copies were kept" has '^curl .*kept the old copies'

echo "the VM copy errors but the archive did land"
export LANDED=1
run "$VM"
check "the landed copy counts: exits 0" [ "$rc" -eq 0 ]
check "and the old copy is dropped" has "delete gdrive-crypt:monthly-vm/ --exclude-from"

echo "the VM mid-month: not uploaded at all"
export DAY=15 FAIL_RE="" LANDED=1
run "$VM"
check "exits 0, no copy" sh -c '[ "$0" -eq 0 ] && ! grep -q monthly-vm "$LOG"' "$rc"

echo "Drive nearly full"
export FREE=1000000000
run "$LXC"
check "still exits 0" [ "$rc" -eq 0 ]
check "Home Assistant is told how full" has '^curl .*Google Drive is 93% full'
export FREE=8131510272

echo "rclone about fails"
export FAIL_RE=" about "
run "$LXC"
check "no Drive figure is not an error" [ "$rc" -eq 0 ]
export FAIL_RE=""

echo "no webhook configured"
rm /etc/default/vzdump-offsite
export FAIL_RE="copy .* --include vzdump-lxc-101-x"
run "$LXC"
check "still exits 1" [ "$rc" -eq 1 ]
check "and sends nothing" hasnt "^curl"
echo 'HA_WEBHOOK_URL=http://ha.test/api/webhook/abc' > /etc/default/vzdump-offsite
export FAIL_RE=""

echo "an aborted job"
: > "$LOG"
sh "$HOOK" job-abort > $W/out.log 2>&1
check "Home Assistant hears it" has '^curl .*aborted'

echo "the alert body is one JSON object"
export FAIL_RE='copy .* --include vzdump-lxc-101-x'
run 'lxc /work/dump vzdump-lxc-101-x'
check "a single {\"message\": ...} with no stray quote" sh -c \
    'grep "^curl" "$LOG" | sed "s/.*-d //; s/ http.*//" | grep -q "^{\"message\": \"[^\"]*\"}$"'
export FAIL_RE=""

echo
echo "$((n - fails)) of $n checks passed"
[ "$fails" -eq 0 ]
