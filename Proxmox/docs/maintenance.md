# Housekeeping

What keeps the host and its guests from slowly filling up, and the one-off
cleanup that put these settings in place (2026-09-30). None of this is mirrored
from the host automatically: it was set over SSH, and this page is the record.

## Settings that stay in place

| Where | Setting | Why |
| --- | --- | --- |
| Host | `/etc/systemd/journald.conf.d/size.conf`: `SystemMaxUse=100M` | the journal was uncapped and had reached 331 MB |
| Host | `/etc/sysctl.d/99-swappiness.conf`: `vm.swappiness=10` | with ~3.6 GB of RAM the default 60 swapped guests out while page cache stayed |
| Host | `pve-ha-lrm`, `pve-ha-crm` disabled | single node, no HA resources: they only ran a watchdog and wrote state |
| Host | `rpcbind`, `nfs-blkmap`, `zfs-zed` disabled | no NFS storage and no ZFS pool |
| Host | `pct-fstrim.timer`, Sundays 05:30 ([`tools/pct-fstrim.service`](../tools/pct-fstrim.service), [`.timer`](../tools/pct-fstrim.timer)) | see *Thin pool* below |
| VM 100 | `balloon: 1536` (memory 2048), 2 vCPUs | lets the host take back some of what Home Assistant does not use; 1024 squeezed it into swap. 2 vCPUs, not 4: see the CPU case study |
| Every LXC | `/etc/systemd/journald.conf.d/size.conf`: `SystemMaxUse=32M` | each 2 GB container had ~190 MB of journal from months of reboots |
| HA · Zigbee2MQTT | `advanced.log_level: warning`, `log_directories_to_keep: 5` | 183 MB of info-level logs; **5 is the minimum Zigbee2MQTT accepts** — 3 makes it refuse to start |

`postfix` stays on the host and in every container: it is how PVE and cron
deliver mail (`/root/.forward`).

## Thin pool

Container root disks on `local-lvm` have no `discard` option, so a deleted file
keeps its thin blocks until something trims the filesystem. Nothing did: the
AdGuard container's volume read 95% full on a filesystem 59% full. The first
`pct fstrim` of all four containers returned about 8 GB to the pool; the timer
keeps doing it weekly. The VM's disk already has `discard=on` and Home Assistant
OS trims it itself.

Install on the host:

```sh
scp tools/pct-fstrim.service tools/pct-fstrim.timer root@<proxmox-ip>:/etc/systemd/system/
ssh root@<proxmox-ip> 'systemctl daemon-reload && systemctl enable --now pct-fstrim.timer'
```

**Open item.** The guest disks add up to 86 GB on a 57 GB thin pool, and the
pool does not grow on its own. At 30% used that is no risk yet; the fix is
`thin_pool_autoextend_threshold = 80` and `thin_pool_autoextend_percent = 20` in
`/etc/lvm/lvm.conf` (the volume group has ~14 GB unassigned).

## The cleanup of 2026-09-30

A full pass over the host, the four containers and Home Assistant. Safety net
first: a `vzdump` of 101–104 (`--prune-backups keep-all=1`, so it could not prune
the weekly backups) and a Home Assistant partial backup of the config folder and
Zigbee2MQTT.

| Where | What | Result |
| --- | --- | --- |
| Host | duplicate first-run dumps of 101–103, `/tmp` and `/root` leftovers, the 6.17 kernel (7.0.14-17 kept as fallback), apt cache, journal | ~2 GB on the root filesystem |
| Containers | `apt full-upgrade` (377 packages across the four), `autoremove`, `apt clean`, journal cap, a leftover `cloudflared.deb`, 1.7 GB of Docker build cache in the MeterCam container | disks 59/55/52/44% → 47/40/38/24% |
| Thin pool | first `pct fstrim` | 36% → 30.5% |
| Home Assistant | 8 stale backups, 44 leftover `*.bak*` / `*-backup-*` files and folders in `/config`, Zigbee2MQTT logs, `recorder.purge` with `repack: true` | database 421 → 260 MB, logs 183 → 85 MB |

Checked afterwards: no failed units anywhere, DNS answering, Tailscale online,
the tunnel up with 4 connections, MeterCam healthy, all Zigbee entities available.

Two things that looked like failures and were not:

- After the container upgrades, `systemctl --failed` listed
  `wtmpdb-rotate.timer … not-found`: the unit was removed by the upgrade and its
  old state lingered. `systemctl reset-failed` clears it.
- The Docker upgrade in the MeterCam container restarts the daemon, and with it
  the container (`restart: unless-stopped`); it was healthy again in under a minute.

## Doing it again

Every step above is safe to repeat. The ones worth doing every few months:

```sh
# host
proxmox-boot-tool kernel list        # then purge the unselected ones (host.md)
apt-get clean
# each container
pct exec <id> -- sh -c 'apt-get update && apt-get -y full-upgrade && apt-get -y autoremove && apt-get clean'
```
