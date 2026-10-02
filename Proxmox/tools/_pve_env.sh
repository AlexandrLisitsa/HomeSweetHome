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

# Loads PVE_SSH_HOST / PVE_SSH_USER / PVE_SSH_KEY for pve_ssh.sh.
#
# Separate from _pve_env_load because the two paths have nothing in common but
# a file: the API token is read-only by role and needs no key, and SSH is root
# on the hypervisor and needs no token. A script asking for one must not be
# made to carry the other, or the read path starts failing for want of a key
# it never uses.
_pve_ssh_env_load() {
    _mod_dir=$(cd "$(dirname "$0")/.." && pwd)
    _env_file="$_mod_dir/secrets.env"

    if [ ! -f "$_env_file" ]; then
        echo "no $_env_file" >&2
        echo "copy secrets.env.example to secrets.env and fill in the PVE_SSH_* lines" >&2
        return 1
    fi

    eval "$(tr -d '\r' < "$_env_file" | grep -E '^[A-Z_]+=')"

    # Defaults, so secrets.env only has to carry what differs from the obvious.
    PVE_SSH_HOST=${PVE_SSH_HOST:-}
    PVE_SSH_USER=${PVE_SSH_USER:-root}
    PVE_SSH_KEY=${PVE_SSH_KEY:-$HOME/.ssh/pve_ed25519}

    if [ -z "$PVE_SSH_HOST" ]; then
        echo "PVE_SSH_HOST not set in $_env_file" >&2
        return 1
    fi
    if [ ! -f "$PVE_SSH_KEY" ]; then
        echo "no SSH key at $PVE_SSH_KEY" >&2
        echo "generate one and install it -- see 'The write path' in Proxmox/README.md" >&2
        return 1
    fi
}
