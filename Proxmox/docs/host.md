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

All of them start with the host (`onboot=1`). Every guest runs Debian or, for the
VM, Home Assistant OS; 100 and 101 were created with the
[community-scripts](https://community-scripts.org) helpers, which is what their
`community-script` tag records.

## Sizing

RAM is the tight resource: the guests are given about 3.5 GB between them on a
host with 3.6 GB, which works because Home Assistant's VM runs the
`virtio_balloon` driver and the containers use well under their limits. CPU is
not: the Home Assistant guest sits at a few percent (see
[the CPU case study](cpu-growth-case-study.md)). A new guest should check free
memory on the host first.

## Access

Read-only through the API token (`tools/pve_get.sh`), and SSH as root for
administration, as described in the [README](../README.md#access). The only
thing from this repository installed on the host is the backup hook
([backups.md](backups.md)).

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

After that cleanup the root filesystem had 31 GB free.
