#!/bin/sh
# Pull the live Home Assistant /config into HomeAssistant/config, so that every
# later change is a reviewable git diff instead of a hand edit on the box.
#
#   sh HomeAssistant/tools/ha_pull.sh
#   sh HomeAssistant/tools/ha_pull.sh --force   # overwrite local edits anyway
#
# Read-only against the box: it runs one `tar czf -` over the SSH pipe. Nothing
# is written to /config.
#
# Override the host with HA_SSH=<alias> if the `ha` alias in ~/.ssh/config is
# not the one you want.
set -eu

force=0
for arg in "$@"; do
    case "$arg" in
        --force) force=1 ;;
        *) echo "unknown option: $arg" >&2; exit 1 ;;
    esac
done

mod_dir=$(cd "$(dirname "$0")/.." && pwd)
dest="$mod_dir/config"
state="$mod_dir/.state"
tmp="$state/pull-tmp"
host=${HA_SSH:-ha}

# The mirror is also where changes are MADE -- the cards in config/www, the
# packages, dashboards/ written by FloorPlan's make_dashboard.py -- and both
# swaps below replace the whole directory. So before a swap, list every file
# git says is changed or new under it, and refuse if the incoming copy would
# drop or differ from it: that is an edit made here and not yet on the box,
# and the swap would delete it with no way back. A file the incoming copy
# matches is fine, so pulling twice in a row still works.
lost_edits() {  # lost_edits <subdir of HomeAssistant> <incoming dir>
    command -v git >/dev/null 2>&1 || return 0
    top=$(git -C "$mod_dir" rev-parse --show-toplevel 2>/dev/null) || return 0
    prefix=$(git -C "$mod_dir" rev-parse --show-prefix)
    git -C "$mod_dir" status --porcelain --untracked-files=all -- "$1" |
    while IFS= read -r line; do
        path=${line#???}
        case "$path" in *" -> "*) path=${path##* -> } ;; esac
        path=${path#\"}; path=${path%\"}
        [ -f "$top/$path" ] || continue          # a local deletion: git still has it
        incoming="$2/${path#"$prefix$1/"}"
        if [ ! -f "$incoming" ] || ! cmp -s "$top/$path" "$incoming"; then
            echo "$path"
        fi
    done
}

guard() {  # guard <subdir> <incoming dir>
    [ "$force" = 1 ] && return 0
    lost=$(lost_edits "$1" "$2")
    [ -z "$lost" ] && return 0
    echo "REFUSING: these local changes are not on the box and the pull would" >&2
    echo "overwrite or delete them:" >&2
    echo "$lost" | sed 's/^/  /' >&2
    echo "Push or commit them first, or rerun with --force to discard them." >&2
    return 1
}

mkdir -p "$state"
rm -rf "$tmp"
mkdir -p "$tmp"

# Built one line at a time rather than as a backslash-continued tar invocation,
# so each exclusion can say why it is there. Single quotes around the globs are
# literal in this variable and are stripped by the remote shell, which keeps it
# from glob-expanding them against its own cwd.
ex=""
# Secrets. Every one of these would be a credential leak in a git commit.
ex="$ex --exclude=./secrets.yaml"          # every credential the config references
ex="$ex --exclude=./google_key.json"       # a GCP service-account private key
ex="$ex --exclude=./.storage"              # `auth` = every session token; core.config_entries = integration passwords
ex="$ex --exclude=./zigbee2mqtt"           # its configuration.yaml holds the MQTT password AND the Zigbee network key
# Bulk that is not config.
ex="$ex --exclude=./custom_components"     # 52 MB, HACS-managed (hacs, midea_ac_lan), reinstallable
ex="$ex --exclude=./deps"
ex="$ex --exclude=./tts"
ex="$ex --exclude=./.cloud"
ex="$ex --exclude=./backups"
ex="$ex --exclude=./image"
ex="$ex --exclude=./media"
ex="$ex --exclude='*.db'"
ex="$ex --exclude='*.db-shm'"
ex="$ex --exclude='*.db-wal'"
ex="$ex --exclude='*.log'"
ex="$ex --exclude='*.log.*'"
ex="$ex --exclude='*.tar'"
ex="$ex --exclude=__pycache__"
ex="$ex --exclude=./.cache"                # HA's downloaded brand-icon cache; pure noise
ex="$ex --exclude=./.ha_run.lock"          # runtime lock
ex="$ex --exclude=./dtek/.cache.json"      # dtek_poll.py session cookie + last good payload; regenerates itself
ex="$ex --exclude=./.irbridge-last-backup" # pointer written by ha_deploy.sh
# Backups of config, which are not loaded and would double every diff.
ex="$ex --exclude='./irbridge-backup-*'"   # rollback points ha_deploy.sh leaves behind
ex="$ex --exclude='./rename*-backup-*'"    # rollback points from the entity-id rename procedure (README); each holds a full core.entity_registry
ex="$ex --exclude='*.bak-*'"               # stray hand-made backups

echo "pulling /config from $host ..." >&2
ssh -o BatchMode=yes "$host" "tar czf - -C /config $ex ." | tar xzf - -C "$tmp"

# A pull that produced no configuration.yaml went wrong; keep the old mirror.
if [ ! -f "$tmp/configuration.yaml" ]; then
    echo "FAILED: no configuration.yaml in the pull - mirror left untouched" >&2
    exit 1
fi

# Refuse to install a mirror containing anything from the secrets list above.
for leaked in secrets.yaml google_key.json .storage zigbee2mqtt; do
    if [ -e "$tmp/$leaked" ]; then
        echo "REFUSING: '$leaked' made it into the pull" >&2
        exit 1
    fi
done

guard config "$tmp" || { rm -rf "$tmp"; exit 1; }

# Swap rather than extract-over, so files deleted on the box show up as
# deletions in git instead of lingering in the mirror forever.
rm -rf "$dest"
mv "$tmp" "$dest"

# The three registries, named explicitly. core.config_entries is NOT pulled: it
# carries integration credentials. Audit inputs only; .state is gitignored.
for reg in core.entity_registry core.device_registry core.area_registry; do
    if ssh -o BatchMode=yes "$host" "cat /config/.storage/$reg" > "$state/$reg.json" 2>/dev/null; then
        echo "  registry: $reg.json" >&2
    else
        rm -f "$state/$reg.json"
        echo "  registry: $reg MISSING" >&2
    fi
done

# Dashboards. Also out of .storage, but unlike the registries these ARE
# committed, in their own directory rather than in the gitignored .state.
#
# The reason for the split: a registry is derived state, regenerated by HA from
# the devices it finds, and mostly noise in a diff. A Lovelace layout is the
# opposite — hand-built, reproducible from nothing else in this repo, and lost
# for good if the box dies. It is the one thing here that was genuinely
# unbacked. They carry no credentials: entity ids and card options, which
# configuration.yaml already commits by the hundred.
#
# Discovered by prefix rather than named, so a dashboard added later starts
# being mirrored without touching this script. HA writes .storage
# pretty-printed, so these land verbatim and still produce a readable diff, and
# a file copied back is valid input — json.loads does not care about the
# whitespace HA would have written.
dash="$mod_dir/dashboards"
dash_tmp="$state/dash-tmp"
rm -rf "$dash_tmp"
mkdir -p "$dash_tmp"

# `.bak-` is filtered for the same reason the tar exclude list drops '*.bak-*':
# a hand-made rollback copy is not a dashboard HA serves, and mirroring one
# puts a stale layout in git looking exactly like a live one.
#
# The listing is taken on its own and checked. Inside `for f in $(ssh ...)` a
# failed ssh is not an error under set -e: the loop just runs zero times,
# dash_ok stays 1, and the "clean sweep" below swapped in an EMPTY directory.
dash_ok=1
if ! listing=$(ssh -o BatchMode=yes "$host" "ls /config/.storage/"); then
    echo "  dashboards: could not list /config/.storage" >&2
    dash_ok=0
    listing=""
fi
dashboards=$(printf '%s\n' "$listing" | grep '^lovelace' | grep -v '\.bak-' || true)
if [ "$dash_ok" = 1 ] && [ -z "$dashboards" ]; then
    echo "  dashboards: none found on the box - not replacing the mirror with nothing" >&2
    dash_ok=0
fi
for f in $dashboards; do
    if ssh -o BatchMode=yes "$host" "cat /config/.storage/$f" > "$dash_tmp/$f.json" 2>/dev/null; then
        echo "  dashboard: $f.json" >&2
    else
        echo "  dashboard: $f FAILED" >&2
        dash_ok=0
    fi
done

# Swap only on a clean sweep. A half-failed pull must not silently delete a
# dashboard from the mirror — that would read as "the user removed it" in the
# diff, and the backup would be gone at the moment it was needed.
if [ "$dash_ok" = 1 ] && ! guard dashboards "$dash_tmp"; then
    dash_ok=0
fi
if [ "$dash_ok" = 1 ]; then
    rm -rf "$dash"
    mv "$dash_tmp" "$dash"
else
    rm -rf "$dash_tmp"
    echo "  dashboards: pull incomplete - mirror left untouched" >&2
fi

echo >&2
echo "mirrored $(find "$dest" -type f | wc -l | tr -d ' ') files into HomeAssistant/config" >&2
echo "now: git status --short" >&2
