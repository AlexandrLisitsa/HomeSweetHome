# 106 · Portal (`portal`)

The house dashboard and the `.lan` names: Homepage draws a card for every
service, and Caddy maps `home.lan`, `ha.lan`, `pve.lan`, `adguard.lan` and
`meter.lan` to them. The project is [`Portal/`](../../Portal/README.md).

| | |
| --- | --- |
| Type | unprivileged LXC, Debian 13, `nesting` on for systemd 257; no `keyctl`, no Docker |
| CPU / RAM / disk | 1 vCPU / 512 MB (+512 MB swap) / 2 GB, the house defaults |
| Software | Caddy (Debian package), Homepage on Node 22 (official tarball), both systemd |
| Created by | `Portal/deploy/lxc_create.sh`, provisioned by `lxc_provision.sh`, updated by `deploy.sh` |
| Starts with host | yes |

## Things to know

- It must cost nothing while idle: no Docker, no background polling, no
  timers of its own, no log files; postfix and ssh are disabled. Measure with
  `sh Portal/tools/idle_cpu.sh` (passes under 0.005 cores).
- Homepage is built on the workstation, not here, because a Next.js build needs
  more RAM than the host has free.
- `/opt/portal/.env` holds the upstream addresses and three read-only
  credentials: Proxmox token `root@pam!homepage` (PVEAuditor), an AdGuard
  login and a Home Assistant token. A deploy never overwrites it.
- Stateless otherwise: everything else rebuilds from git. It is not in the
  off-site backup run. If it is lost, recreate it and rewrite `.env`.
- If it is down, only the names stop working. Every service is still on its
  address and port, and DNS is unaffected (AdGuard is 101).
- Its address, gateway and VM id are set in `Portal/deploy/_lxc_env.sh`,
  with the real address in the git-ignored `deploy/lxc.env`.
- Like 104 and 105, this repository creates and changes it through the
  [SSH write path](ssh-write-path.md).
