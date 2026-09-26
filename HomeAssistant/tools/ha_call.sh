#!/bin/sh
# Call a Home Assistant service. THIS CHANGES THE HOUSE.
#
#   sh HomeAssistant/tools/ha_call.sh automation.reload
#   sh HomeAssistant/tools/ha_call.sh climate.set_temperature \
#        '{"entity_id":"climate.daewoo_a_c","temperature":22}'
#
# Kept out of .claude/settings.local.json on purpose, so every state-changing
# call prompts.
set -eu

. "$(dirname "$0")/_ha_env.sh"
_ha_env_load

target=${1:-}
payload=${2:-'{}'}
if [ -z "$target" ]; then
    echo "usage: ha_call.sh <domain.service> [json]" >&2
    exit 1
fi

domain=$(printf '%s' "$target" | cut -d. -f1)
service=$(printf '%s' "$target" | cut -s -d. -f2)
if [ -z "$domain" ] || [ -z "$service" ]; then
    echo "expected domain.service, got '$target'" >&2
    exit 1
fi

echo "POST $domain.$service $payload" >&2
curl -sS -m 30 --fail-with-body -X POST \
    -H "Authorization: Bearer $HA_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$HA_URL/api/services/$domain/$service"
