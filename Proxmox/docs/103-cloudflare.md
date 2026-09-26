# 103 · Cloudflare Tunnel (`cloudflare`)

Public access without an open port: `cloudflared` keeps an outbound tunnel to
Cloudflare, and Cloudflare forwards the configured public hostnames through it to
services on the LAN. It exists for **Google Home and Gemini**: both reach Home
Assistant over the internet, through Google's cloud, so Home Assistant has to be
publicly reachable. The tunnel publishes it without opening a port on the
router. (Private access for the household goes through
[Tailscale](102-tailscale.md) instead.)

| | |
| --- | --- |
| Type | unprivileged LXC, Debian |
| CPU / RAM / disk | 1 vCPU / 512 MB (+512 MB swap) / 2 GB |
| Software | `cloudflared` 2026.3, as a systemd service |
| Configuration | token-based: the tunnel and its hostnames are defined in the Cloudflare dashboard, not on the container |
| Starts with host | yes |

## Things to know

- Anything published through the tunnel is on the internet. Home Assistant's log
  shows scanners probing it with invalid credentials; keep strong passwords and
  multi-factor login on every Home Assistant user.
- The tunnel token is the credential. It lives only in the service's unit on the
  container and is never committed.
