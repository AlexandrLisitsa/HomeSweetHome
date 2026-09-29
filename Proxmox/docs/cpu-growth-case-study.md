# Case study: why the HA guest's CPU grew

The guest's CPU climbs in **steps with flat plateaus between**, not as drift —
which rules out anything accumulating, including database growth:

```
week of 03-30   0.93%          baseline, before the inverter
week of 04-27   1.59%  +0.60   ESPHome inverter added 04-24; disk steps too
week of 06-22   2.03%  +0.34   CPU up, disk FLAT
week of 08-24   2.43%  +0.22   IR Bridge energy package, deployed 08-23
```

The model that fits: **CPU tracks state-change rate at ~0.025pp per 1,000
writes/hour, whether or not those changes reach disk.** ESPHome at 21,886/h
gives +0.60pp and the `sensor.google_*` shims at 14,291/h give +0.34pp — within
15% of each other. Disk bytes do *not* predict it: April→May added 43 KB/s for
+0.58pp, while May→August added 2 KB/s for another +0.59pp.

The 06-22 step is CPU with no disk at all, which is the shims' signature, but it
is inferred rather than proved — they had no registry entries to date until they
were given `unique_id`s on 2026-08-28.

**Open prediction.** 11,262 writes/hour were removed on 2026-08-28. The model
says −0.28pp, so a quiet day should read ~2.15% against 2.43%. If it holds,
halving the ESPHome telemetry is worth ~0.55pp and the firmware work is
justified; if it does not, the model is wrong and the cost is somewhere not yet
measured.

## 2026-09-30: most of it was never Home Assistant

The prediction above did not hold: the weeks after 08-28 read 2.23–2.41%, not
~2.15%. Measuring both sides of the VM over the same minute showed why the
model kept missing:

| | CPU |
| --- | --- |
| work inside the guest (`/proc/stat`: every process and its kernel) | 1.08% of 4 vCPUs |
| the VM's QEMU process on the host (what the graph shows) | 2.73% of 4 cores |

Over 60% of the graph was the cost of running the VM, not work in it: four
mostly idle vCPUs woken by every packet, timer and USB interrupt, each wake
also spinning up to `halt_poll_ns` (200 µs) on the host before it sleeps.
That overhead scales with the event rate, which is why CPU "tracked writes"
whether or not they reached disk.

Inside the guest, Home Assistant Core is ~0.4% of the VM, then os-agent
(0.12%), dockerd, coredns, mosquitto and qemu-ga at 0.04–0.07% each. The
state-change rate is ~30,400/h, and 91% of it is the power station's ESPHome
node (inverter 14.6k/h, JK BMS 13k/h, some BMS sensors every 2 s) -- up from
the 21,900/h measured on 08-28.

Tried the same day, all measured in absolute cores. Proxmox shows a VM's CPU
as a share of ITS vCPUs, so the same work reads twice as high on 2 as on 4;
`cpu_trend.py` now scales every row to "% of 4 cores" for that reason.

| | VM process | graph |
| --- | --- | --- |
| quiet morning, 4 vCPUs, no balloon floor issue | 0.083 cores | 2.08% |
| 4 vCPUs, balloon floor 1 GB (guest held at 1.15 GB, 475 MB swapped) | 0.169 cores | 4.2% |
| 2 vCPUs, balloon floor 1.5 GB | 0.086 cores | 4.3% (of 2) |
| 4 vCPUs again, balloon floor 1.5 GB, 8 min after boot | 0.095 cores | 2.4% |

Two results. A 1 GB balloon floor is too low: the host sits above the 80%
where auto-ballooning starts, the guest was squeezed into swap and its CPU
doubled; 1.5 GB keeps it out of swap. And 2 vCPUs saved NOTHING against the
4-vCPU baseline -- the idle-vCPU wake cost does not scale with the vCPU
count the way the overhead reading suggested -- while it halved the headroom
for backups and updates, so the VM went back to 4.

The lever that remains is the ESPHome node's telemetry rate (throttle/delta
filters), which cuts both the guest's work and the host-side wakes.

**Measure quiet days only.** Every restart, log pull and API poll lands on this
same graph. The week of 08-24 rose from 2.43% to 2.50% during the session that
produced these numbers — that was the session, not the house.
