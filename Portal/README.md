# Portal

One page for every service in the house, and short names for each one's web UI
in place of an address and a port. It runs in LXC 106 on the Proxmox host
([`Proxmox/docs/106-portal.md`](../Proxmox/docs/106-portal.md)) and is only
reachable at home and over Tailscale. Nothing is published to the internet.

- **[Homepage](https://gethomepage.dev)** draws the dashboard: a card per
  service with an icon, a line on what it is, an up/down dot and, where the
  service has an API, live numbers (the Proxmox guests' CPU and RAM, AdGuard's
  blocked share, the battery and load from Home Assistant).
- **Caddy** answers the `.lan` names and passes each one to its service.
- **AdGuard** (CT 101) resolves every `*.lan` name to this container.

```text
browser ── home.lan ──► AdGuard: *.lan = Portal ──► Caddy :80 ─┬─► Homepage (127.0.0.1:3000)
                                                               ├─► ha.lan      Home Assistant :8123
                                                               ├─► pve.lan     Proxmox :8006 (https)
                                                               ├─► adguard.lan AdGuard :80
                                                               └─► meter.lan   ElectricityMeter board
```

## Names

| Name | Opens |
| --- | --- |
| `http://home.lan` | this dashboard |
| `http://ha.lan` | Home Assistant |
| `http://pve.lan` | Proxmox (the console works too) |
| `http://adguard.lan` | AdGuard Home |
| `http://meter.lan` | the ElectricityMeter board's own page |

Any other `*.lan` name goes to the dashboard. MeterCam and MeterBots have no
page to open, only an API, so they get a status card and no name.

The old addresses keep working. Home Assistant is still on `:8123` and on its
Cloudflare hostname, which Google Home uses.

## Idle costs nothing

This container must not use the host's CPU while nobody has the page open,
and the design follows from that:

- **No Docker.** Caddy is Debian's package and Homepage runs on Node, both
  plain systemd services. dockerd and containerd cost something just by
  running ([the CPU case study](../Proxmox/docs/cpu-growth-case-study.md)).
- **Nothing polls in the background.** Homepage's status dots and widgets
  are fetched by the open page through Homepage's server. With no tab open,
  nothing is fetched. The update check, which calls GitHub, is off.
- **No timers, no disk writes.** Caddy runs with no HTTPS, no admin endpoint
  and no access log. Homepage logs to the journal, not to a file. Postfix and
  ssh are switched off in the container.

Check it with `sh Portal/tools/idle_cpu.sh` after closing every tab. It reads
the container's cgroup CPU counter on the host over 10 minutes and passes under
**0.005 cores**.

## Layout

| Path | What |
| --- | --- |
| `homepage/` | Homepage's config: `services.yaml` (the cards), `bookmarks.yaml`, `widgets.yaml`, `settings.yaml`, `proxmox.yaml` (the API behind the guests' CPU/RAM lines). The other files are empty on purpose: Homepage writes a sample into any file that is missing. |
| `caddy/Caddyfile` | the names |
| `systemd/` | `homepage.service`, and the drop-in that gives Debian's `caddy.service` this Caddyfile and the `.env` |
| `.env.example` | template for the box's `/opt/portal/.env`: upstream addresses and the widgets' credentials |
| `deploy/` | `lxc_create.sh`, `lxc_provision.sh`, `deploy.sh`, as in MeterBots |
| `tools/build_homepage.sh` | builds Homepage from its release tag in Docker, on the workstation |
| `tools/idle_cpu.sh` | the idle measurement above |

No LAN address or token is committed. The config refers to `{{HOMEPAGE_VAR_*}}`
(Homepage) and `{$HOMEPAGE_VAR_*}` (Caddy), filled from `/opt/portal/.env`.

## Adding a card

Add the service to `homepage/services.yaml` under a group, then
`sh Portal/deploy/deploy.sh`. Icon names come from
[dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (`proxmox.png`)
or Material Design (`mdi-flash`). A `siteMonitor` URL gives the card a status
dot. If it also needs a name, add a site block to `caddy/Caddyfile` and its
address to the box's `.env` and `.env.example`.

## First setup

1. `cp Portal/deploy/lxc.env.example Portal/deploy/lxc.env` and set the real
   address (the next free one in the root README's Network table) and gateway.
2. `sh Portal/deploy/lxc_create.sh`, then `sh Portal/deploy/lxc_provision.sh`.
3. Credentials for the widgets, all read-only or scoped to this page:
   - Proxmox: on the host,
     `pveum user token add root@pam homepage --privsep 1` and
     `pveum acl modify / --tokens 'root@pam!homepage' --roles PVEAuditor`.
     It is a separate token from `root@pam!claude`, so either can be revoked
     without breaking the other.
   - AdGuard: its admin login.
   - Home Assistant: a long-lived token named *Homepage* (Profile → Security).
4. Write `/opt/portal/.env` in the container from `.env.example`.
5. `sh Portal/deploy/deploy.sh`. The first run builds Homepage (Docker on the
   workstation, a few minutes) and ships it.
6. AdGuard → Filters → DNS rewrites: `*.lan` → the container's address.
7. Home Assistant: add the container's address to `http` → `trusted_proxies`.
   Since 2026.x that is websocket `http/config/configure`, then `promote`
   within 5 minutes. YAML is ignored
   ([`HomeAssistant/docs/remote-access-security.md`](../HomeAssistant/docs/remote-access-security.md)).
8. Tailscale admin → DNS → add a split-DNS nameserver: AdGuard's address,
   restricted to the domain `lan`. The phone then resolves the names away from
   home through the subnet route.

## Updating Homepage

Set `HOMEPAGE_VERSION` in `deploy/_lxc_env.sh` to a release that has been out for
a couple of weeks, then run `deploy.sh`. It rebuilds only when the box's version
differs. `NODE_VERSION` is bumped the same way, followed by `lxc_provision.sh`.
Caddy updates with the container's apt.

## Not yet

- HTTPS. Plain HTTP is fine on the LAN, and Tailscale encrypts the remote path.
  Real certificates would need a subdomain of the house domain (`<domain>`) and a
  Cloudflare DNS-01 token, plus a Caddy build with that plugin.
