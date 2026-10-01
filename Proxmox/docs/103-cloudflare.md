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

- The tunnel publishes exactly two hostnames, both to Home Assistant: the main
  one, behind Cloudflare Access with Google login, and a Google-only one that a
  WAF rule limits to Google Home's two machine calls. Anything else gets the
  tunnel's 404. The design, and how each request is accepted or denied, is in
  [`../../HomeAssistant/docs/remote-access-security.md`](../../HomeAssistant/docs/remote-access-security.md).
- Home Assistant trusts this container, and only it, as a reverse proxy, so it
  logs and bans the real client address. If the container's address changes,
  update `trusted_proxies` in HA (Settings → System → Network) or every
  request through the tunnel is refused.
- The tunnel token is the credential. It lives only in the service's unit on the
  container and is never committed.
