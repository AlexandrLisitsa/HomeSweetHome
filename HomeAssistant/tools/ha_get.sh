#!/bin/sh
# Read-only GET against the Home Assistant REST API.
#
#   sh HomeAssistant/tools/ha_get.sh /api/config
#   sh HomeAssistant/tools/ha_get.sh /api/states
#
# GET-only by construction: no -X, no -d. Anything that changes the house goes
# through ha_call.sh instead, which is deliberately not on the permission
# allowlist.
set -eu

. "$(dirname "$0")/_ha_env.sh"
_ha_env_load

api_path=${1:-}
if [ -z "$api_path" ]; then
    echo "usage: ha_get.sh /api/..." >&2
    exit 1
fi
case "$api_path" in
    /*) ;;
    *) api_path="/$api_path" ;;
esac

curl -sS -m 30 --fail-with-body \
    -H "Authorization: Bearer $HA_TOKEN" \
    -H "Content-Type: application/json" \
    "$HA_URL$api_path"
