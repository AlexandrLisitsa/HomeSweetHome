# The Proxmox host

One small x86 box runs every always-on service in the home as a guest: Home
Assistant as a VM, and the network services as LXC containers.

| | |
| --- | --- |
| CPU | Intel Celeron J4105, 4 cores / 4 threads, 1.5 GHz |
| RAM | ~3.6 GB usable |
| Boot | UEFI, Secure Boot off |
| Proxmox VE | 9.2 |
| Storage | `local` (directory: ISOs, templates, backups) and `local-lvm` (LVM-thin: guest disks) |
| Backups | weekly vzdump to `local`, copied encrypted to Google Drive ([backups.md](backups.md)) |
| Node name | `proxmox`, a single node, no cluster |

## Guests

| ID | Type | Name | vCPU | RAM | Disk | Doc |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | VM | `haos17-1` | 4 | 2 GB | 64 GB | [Home Assistant OS](100-home-assistant.md) |
| 101 | LXC | `adguard` | 1 | 512 MB | 2 GB | [AdGuard Home](101-adguard.md) |
| 102 | LXC | `tailscale` | 1 | 512 MB | 2 GB | [Tailscale](102-tailscale.md) |
| 103 | LXC | `cloudflare` | 1 | 512 MB | 2 GB | [Cloudflare Tunnel](103-cloudflare.md) |
| 104 | LXC | `metercam` | 2 | 1 GB | 8 GB | MeterCam: the gas-meter camera service, in Docker (on the `metercam` branch) |

All of them start with the host (`onboot=1`). Every guest runs Debian or, for the
VM, Home Assistant OS; 100 and 101 were created with the
[community-scripts](https://community-scripts.org) helpers, which is what their
`community-script` tag records.

## Sizing

RAM is the tight resource: the guests are given about 4.5 GB between them on a
host with 3.6 GB, which works because the containers use well under their limits
(20–120 MB each) and Home Assistant's VM can balloon down to 1.5 GB when the
host runs short (`balloon: 1536`; it uses about 1 GB of its 2). Not lower: at
1 GB the host, which sits above the 80% where auto-ballooning starts, held the
guest at 1.15 GB and it swapped 475 MB and doubled its CPU. Swappiness is 10 so
the host drops page cache before it swaps a guest out
([maintenance.md](maintenance.md)). CPU is
not: the Home Assistant guest sits at a few percent (see
[the CPU case study](cpu-growth-case-study.md)). A new guest should check free
memory on the host first.

## Access

Read-only through the API token (`tools/pve_get.sh`), and SSH as root for
administration, as described in the [README](../README.md#access). Installed on
the host from this repository: the backup hook ([backups.md](backups.md)) and
the weekly `pct fstrim` timer ([maintenance.md](maintenance.md)).

## Disk space

The root filesystem (40 GB) holds `local`, so the local backups compete with the
OS for it. **Proxmox never removes old kernels**: by 2026-09-27, 22 kernels had
piled up and used 21 GB of it. Keep only the kernels `proxmox-boot-tool kernel
list` selects (the running one, the previous one and the newest of the older
series) and purge the rest:

```sh
proxmox-boot-tool kernel list
dpkg -l 'proxmox-kernel-*-pve-signed' | awk '/^ii/{print $2}'   # installed
apt-get -s purge <the unselected ones>   # check it removes only those, then without -s
```

After that cleanup the root filesystem had 31 GB free. The journal is capped at
100 MB and the apt cache is worth clearing on the same occasion; the routine is
in [maintenance.md](maintenance.md).
