# 100 · Home Assistant OS (`haos17-1`)

The smart home itself: a KVM virtual machine running Home Assistant OS. Its
configuration is mirrored in [`HomeAssistant/`](../../HomeAssistant/README.md).

| | |
| --- | --- |
| Type | QEMU/KVM VM, machine `q35`, UEFI (OVMF) |
| CPU | 4 vCPU, `host` CPU type (2 was tried on 2026-09-30 and saved nothing, see [the CPU case study](cpu-growth-case-study.md)) |
| RAM | 2 GB, balloons down to 1.5 GB when the host needs it (`balloon: 1536`) |
| Disk | 64 GB on `local-lvm` (virtio-SCSI, discard and SSD emulation on) |
| USB passthrough | a Silicon Labs CP210x USB-serial adapter (`10c4:ea60`): the Zigbee coordinator |
| Guest agent | enabled |
| Starts with host | yes |

## Why a VM and not a container

Home Assistant OS is a full appliance: its own supervisor, add-ons (SSH,
Zigbee2MQTT, the MQTT broker) and updates. It only runs as a VM, and the
Zigbee coordinator reaches it by USB passthrough.

## Things to know

- Moving the Zigbee stick to another USB port keeps working, because the
  passthrough is by vendor and product id, not by port.
- The disk is sized for the recorder database and backups; the recorder keeps
  two days of raw states (see `configuration.yaml`).
