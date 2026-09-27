# Proxmox

The hypervisor that runs the home: one small Proxmox VE host with Home Assistant
as a VM and the network services (ad-blocking DNS, remote access, a public
tunnel) as LXC containers. This project documents the host and every guest on
it, one doc each, holds read-only tooling to measure them, and the hook that
sends every backup off-site ([`docs/backups.md`](docs/backups.md)).

| Guest | What it does | Doc |
| --- | --- | --- |
| the host | Celeron J4105, ~3.6 GB RAM, Proxmox VE 9.2 | [`docs/host.md`](docs/host.md) |
| 100 · VM | Home Assistant OS, with the Zigbee coordinator passed through | [`docs/100-home-assistant.md`](docs/100-home-assistant.md) |
| 101 · LXC | AdGuard Home: ad-blocking DNS for the LAN | [`docs/101-adguard.md`](docs/101-adguard.md) |
| 102 · LXC | Tailscale subnet router: private remote access | [`docs/102-tailscale.md`](docs/102-tailscale.md) |
| 103 · LXC | Cloudflare Tunnel: lets Google Home and Gemini reach Home Assistant, without an open port | [`docs/103-cloudflare.md`](docs/103-cloudflare.md) |

The tooling began as a way to measure the HA guest's resource history rather
than eyeball it off a graph ([the CPU case study](docs/cpu-growth-case-study.md)).

| Thing | Value |
| --- | --- |
| Host | your Proxmox host (`<proxmox-ip>`) — API and UI on `8006`, SSH on `22` |
| Credentials | `secrets.env` — gitignored; see `secrets.env.example` |
| Backups | weekly vzdump jobs, copied encrypted to Google Drive — [`docs/backups.md`](docs/backups.md) |

## Access

Two ways in, for two jobs:

- A **read-only API token** for measuring. `PVEAuditor` can see every node, VM,
  config and metric and change nothing. Setup steps and the privilege-separation
  trap are in `secrets.env.example`. The tools below use only this.
- **SSH as root** with a dedicated key, for host administration: installing
  packages, the backup hook, the backup jobs. Nothing in `tools/` uses it; the
  hook is installed by hand (see [`docs/backups.md`](docs/backups.md)).
  Changes made this way are written up in the docs, since there is no mirror of
  the host's config in this repository.

Verify:

```sh
sh tools/pve_get.sh /nodes
```

## Tools

| Script | Does | Prompts? |
| --- | --- | --- |
| `tools/pve_get.sh` | GET against `/api2/json` — GET-only by construction | no |
| `tools/cpu_trend.py` | the HA guest's CPU by week (or by hour: `... day`), against a recorded baseline | no |
| `tools/_pve_env.sh` | not a command: sourced by `pve_get.sh` to load the token from `secrets.env` | — |
| `tools/vzdump-offsite.sh` | **runs on the host**, as the vzdump hook of both backup jobs: uploads the dumps to Google Drive through rclone crypt and prunes the off-site copies | changes Drive, not the host |

```sh
python tools/cpu_trend.py        # weekly, the whole year
python tools/cpu_trend.py day    # per-hour, the last day
```

There is deliberately no write helper over the API. If the VM's RAM or core
count ever needs changing, that is an SSH job and a separate decision.

## Endpoints worth knowing

```sh
sh tools/pve_get.sh /nodes                       # node names
sh tools/pve_get.sh /cluster/resources           # every guest, one call
sh tools/pve_get.sh /nodes/<node>/status         # host CPU, RAM, uptime
sh tools/pve_get.sh /nodes/<node>/qemu           # guests with vmid + live usage
sh tools/pve_get.sh "/nodes/<node>/qemu/<vmid>/rrddata?timeframe=year&cf=AVERAGE"
```

That last one is the point of the module: it returns the same series the UI
graphs, as JSON. `timeframe` accepts `hour`, `day`, `week`, `month`, `year` —
each a different RRD resolution, so pick the one matching the question. `year`
answers "when did the climb start"; `hour` answers "did the change just now
help".

## Docs

| Doc | About |
| --- | --- |
| [`docs/host.md`](docs/host.md) | the host's hardware, storage, the guest list and memory budget |
| [`docs/100-home-assistant.md`](docs/100-home-assistant.md) | VM 100, Home Assistant OS |
| [`docs/101-adguard.md`](docs/101-adguard.md) | LXC 101, AdGuard Home |
| [`docs/102-tailscale.md`](docs/102-tailscale.md) | LXC 102, Tailscale subnet router |
| [`docs/103-cloudflare.md`](docs/103-cloudflare.md) | LXC 103, Cloudflare Tunnel |
| [`docs/backups.md`](docs/backups.md) | what is backed up, where, the retention, and how to restore |
| [`docs/security.md`](docs/security.md) | the certificate, the read-only token, and what a leak could and could not do |
| [`docs/cpu-growth-case-study.md`](docs/cpu-growth-case-study.md) | the investigation into the Home Assistant guest's CPU growth, and the model that fits it |
