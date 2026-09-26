# 101 · AdGuard Home (`adguard`)

A DNS resolver for the home network that blocks ads and trackers for every
device, including the ones that can't run a blocker of their own (TVs, phones'
apps, IoT devices).

| | |
| --- | --- |
| Type | unprivileged LXC, Debian |
| CPU / RAM / disk | 1 vCPU / 512 MB (+512 MB swap) / 2 GB |
| Software | AdGuard Home v0.107 |
| Starts with host | yes |

## Things to know

- Devices only use it if the router hands it out as the DNS server (DHCP), so
  when this container is down, name resolution on the LAN is down with it. Keep a
  fallback resolver in the router's DHCP settings.
- Created with the community-scripts AdGuard helper; AdGuard Home updates itself
  from its own web UI.
