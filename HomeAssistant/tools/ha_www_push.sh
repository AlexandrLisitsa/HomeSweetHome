#!/bin/sh
# Push HomeAssistant/config/www to /config/www on the box, so a custom Lovelace
# card that lives in git becomes the one Home Assistant serves at /local/.
#
#   sh HomeAssistant/tools/ha_www_push.sh
#
# THIS CHANGES THE HOUSE. ha_pull.sh is the read-only direction; this is not.
#
# www/ is the one part of /config that is deployed rather than pulled. It is not
# in ha_pull.sh's exclude list, so whatever ends up on the box comes straight
# back into git on the next pull -- including anything HACS drops in
# www/community/, which is why this pushes the tree instead of named files.
#
# TWO THINGS THAT WILL WASTE YOUR AFTERNOON
#
#   1. /local/ is registered as a static route at startup, and only if
#      /config/www exists at that moment. The first ever run of this script
#      therefore needs `ha core restart` after it or every /local/ URL 404s.
#      Runs after that need no restart.
#   2. The browser caches an ES module hard. The Lovelace resource URL carries a
#      ?v= for exactly that reason -- the card's own VERSION, X.Y.Z -- and
#      shipping a new card body without bumping it means you are still looking
#      at the old one. Bump VERSION in the card, push, then:
#
#        python HomeAssistant/tools/ha_dashboard.py --card dtek-shutdowns-card.js
#
# Override the host with HA_SSH=<alias> if the `ha` alias in ~/.ssh/config is
# not the one you want.
set -eu

mod_dir=$(cd "$(dirname "$0")/.." && pwd)
src="$mod_dir/config/www"
host=${HA_SSH:-ha}

if [ ! -d "$src" ]; then
    echo "no $src -- nothing to push" >&2
    exit 1
fi

count=$(find "$src" -type f | wc -l | tr -d ' ')
if [ "$count" = 0 ]; then
    echo "$src is empty -- refusing to push nothing over a live www/" >&2
    exit 1
fi

echo "pushing $count file(s) to $host:/config/www ..." >&2
find "$src" -type f | sed "s|^$src/|  |" >&2

# Over tar rather than scp: one round trip, and it keeps the directory layout
# under www/ intact. Deliberately NOT `--delete`-shaped -- a file on the box
# that is not in git (a HACS card) must survive a push of ours.
ssh -o BatchMode=yes "$host" "mkdir -p /config/www"
tar czf - -C "$src" . | ssh -o BatchMode=yes "$host" "tar xzf - -C /config/www"

echo >&2
echo "on the box now:" >&2
ssh -o BatchMode=yes "$host" "ls -l /config/www"
