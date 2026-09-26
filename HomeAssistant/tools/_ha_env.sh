# Sourced by ha_get.sh and ha_call.sh. Not executable on its own.
# Loads HA_URL / HA_TOKEN from HomeAssistant/secrets.env.

_ha_env_load() {
    _mod_dir=$(cd "$(dirname "$0")/.." && pwd)
    _env_file="$_mod_dir/secrets.env"

    if [ ! -f "$_env_file" ]; then
        echo "no $_env_file" >&2
        echo "copy secrets.env.example to secrets.env and paste a long-lived token into it" >&2
        return 1
    fi

    # Tolerate a CRLF secrets.env rather than putting a \r inside the token.
    eval "$(tr -d '\r' < "$_env_file" | grep -E '^[A-Z_]+=')"

    if [ -z "${HA_URL:-}" ]; then echo "HA_URL not set in $_env_file" >&2; return 1; fi
    if [ -z "${HA_TOKEN:-}" ]; then echo "HA_TOKEN not set in $_env_file" >&2; return 1; fi
}
