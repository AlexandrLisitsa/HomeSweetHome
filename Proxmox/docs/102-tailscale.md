# 102 · Tailscale (`tailscale`)

Private remote access to the home network. The container joins the owner's
Tailscale network and advertises the home LAN as a subnet route, so a phone or
laptop on the tailnet can reach Home Assistant and the other services as if it
were at home, with nothing exposed to the internet.

| | |
| --- | --- |
| Type | **privileged** LXC, Debian (it needs the TUN device) |
| CPU / RAM / disk | 1 vCPU / 512 MB (+512 MB swap) / 2 GB |
| Software | Tailscale 1.96 |
| Role | subnet router; not an exit node |
| Starts with host | yes |

## Things to know

- A subnet route has to be approved once in the Tailscale admin console before
  clients can use it.
- It is the only privileged container on the host. A privileged container's root
  is the host's root, so keep nothing else in it.
