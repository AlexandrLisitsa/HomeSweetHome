# Sourced by pve_get.sh. Not executable on its own.
# Loads PVE_URL / PVE_TOKEN_ID / PVE_TOKEN_SECRET from Proxmox/secrets.env.

_pve_env_load() {
    _mod_dir=$(cd "$(dirname "$0")/.." && pwd)
    _env_file="$_mod_dir/secrets.env"

    if [ ! -f "$_env_file" ]; then
        echo "no $_env_file" >&2
        echo "copy secrets.env.example to secrets.env and paste the token secret into it" >&2
        return 1
    fi

    # Tolerate a CRLF secrets.env rather than putting a \r inside the token.
    eval "$(tr -d '\r' < "$_env_file" | grep -E '^[A-Z_]+=')"

    if [ -z "${PVE_URL:-}" ]; then echo "PVE_URL not set in $_env_file" >&2; return 1; fi
    if [ -z "${PVE_TOKEN_ID:-}" ]; then echo "PVE_TOKEN_ID not set in $_env_file" >&2; return 1; fi
    if [ -z "${PVE_TOKEN_SECRET:-}" ]; then echo "PVE_TOKEN_SECRET not set in $_env_file" >&2; return 1; fi
}
