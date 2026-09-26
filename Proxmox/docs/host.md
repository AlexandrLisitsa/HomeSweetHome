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
| Node name | `proxmox`, a single node, no cluster |

## Guests

| ID | Type | Name | vCPU | RAM | Disk | Doc |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | VM | `haos17-1` | 4 | 2 GB | 64 GB | [Home Assistant OS](100-home-assistant.md) |
| 101 | LXC | `adguard` | 1 | 512 MB | 2 GB | [AdGuard Home](101-adguard.md) |
| 102 | LXC | `tailscale` | 1 | 512 MB | 2 GB | [Tailscale](102-tailscale.md) |
| 103 | LXC | `cloudflare` | 1 | 512 MB | 2 GB | [Cloudflare Tunnel](103-cloudflare.md) |
| 104 | LXC | `metercam` | 2 | 1 GB | 8 GB | [MeterCam](104-metercam.md) |

All of them start with the host (`onboot=1`). Every guest runs Debian or, for the
VM, Home Assistant OS; 100 and 101 were created with the
[community-scripts](https://community-scripts.org) helpers, which is what their
`community-script` tag records.

## Sizing

RAM is the tight resource: the guests are given about 4.5 GB between them on a
host with 3.6 GB, which works because Home Assistant's VM runs the
`virtio_balloon` driver and the containers use well under their limits. CPU is
not: the Home Assistant guest sits at a few percent (see
[the CPU case study](cpu-growth-case-study.md)). A new guest should check free
memory on the host first.

## Access

Read-only through the API token (`tools/pve_get.sh`), as described in the
[README](../README.md#access). The one thing that changes the host is MeterCam's
deployment, over the [SSH write path](ssh-write-path.md).
