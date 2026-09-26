#!/bin/sh
# Read-only GET against the Proxmox VE API.
#
#   sh Proxmox/tools/pve_get.sh /nodes
#   sh Proxmox/tools/pve_get.sh /cluster/resources
#   sh Proxmox/tools/pve_get.sh "/nodes/pve/qemu/100/rrddata?timeframe=year&cf=AVERAGE"
#
# GET-only by construction: no -X, no -d. The token should hold PVEAuditor,
# which cannot write anything anyway - this is belt and braces.
set -eu

. "$(dirname "$0")/_pve_env.sh"
_pve_env_load

api_path=${1:-}
if [ -z "$api_path" ]; then
    echo "usage: pve_get.sh /nodes[?query]" >&2
    exit 1
fi
case "$api_path" in
    /*) ;;
    *) api_path="/$api_path" ;;
esac

# Proxmox ships a self-signed certificate. `-k` skips verification, which is
# acceptable on the LAN and consistent with how Home Assistant is already
# reached over plain HTTP - but it does mean the token is only as safe as the
# network. Set PVE_CACERT in secrets.env to pin a certificate instead.
if [ -n "${PVE_CACERT:-}" ]; then
    _tls="--cacert $PVE_CACERT"
else
    _tls="-k"
fi

# shellcheck disable=SC2086
curl -sS -m 60 --fail-with-body $_tls \
    -H "Authorization: PVEAPIToken=${PVE_TOKEN_ID}=${PVE_TOKEN_SECRET}" \
    "${PVE_URL}/api2/json${api_path}"
