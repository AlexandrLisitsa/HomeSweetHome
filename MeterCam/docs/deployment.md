# MeterCam deployment

MeterCam runs in LXC **104** on the Proxmox host, as one Docker container.

| Script | Does | Idempotent? |
| --- | --- | --- |
| `deploy/lxc_create.sh` | `pct create` the container, start it, wait for DNS | **no**: refuses if 104 exists |
| `deploy/lxc_provision.sh` | Docker, and the frame-retention timer | yes |
| `deploy/deploy.sh` | ship the code, build, recreate, health-check | yes |
| `deploy/probe_cpu.sh` | prove the TFLite runtime executes on this CPU | yes |
| `deploy/_lxc_env.sh` | the container's spec, sourced by all of the above | — |

A code change is one command: `sh MeterCam/deploy/deploy.sh`.

---

## What lives where

`deploy.sh` ships **code only**: `service/`, `tests/`, the `Dockerfile`,
`requirements.txt` and `docker-compose.yml`. Everything that describes this
house stays on the box in `/opt/metercam/` and is never overwritten by a deploy:

| On the box | What | Mounted as |
| --- | --- | --- |
| `config.json` | the meter, its ROIs, Home Assistant's address | `/config/config.json`, read-only |
| `.env` | `METERCAM_TOKEN`, `METERCAM_HA_TOKEN` | environment |
| `models/*.tflite` | jomjol's weights | `/models`, read-only |
| `data/ref/gas.jpg` | the alignment reference | `/data` |
| `data/images/gas/` | archived frames (`raw/`, `rejected/`), `last.jpg`, `last_accepted.json` + `last_accepted.jpg` | `/data` |
| `data/firmware/` | `gas-cam.bin`, `version.txt`, older builds for rollback | `/data` |

The reference and the ROIs are one matched pair: each ROI is a pixel rectangle
in the reference frame. A deploy that shipped a workstation's copy of either
would quietly undo a change made on the box and give confident wrong numbers.
That is why neither travels with the code.

**After editing `config.json`, recreate the container:**
`docker compose up -d --force-recreate`. A single-file bind mount follows the
inode, and an editor that replaces the file leaves the running container
reading the old one with no error.

---

## First setup

Only on a fresh container. `deploy.sh` refuses to run until all of this exists.

```sh
sh MeterCam/deploy/lxc_create.sh
sh MeterCam/deploy/lxc_provision.sh
```

Then, in `/opt/metercam/` on the box:

1. `models/`: run `models/fetch.sh` on a workstation and copy the `.tflite`
   files across.
2. `config.json`: start from `service/config.example.json`; set Home
   Assistant's address.
3. `.env`: `METERCAM_HA_TOKEN=<a long-lived token>`. Mint one for MeterCam alone
   so it can be revoked on its own. Add `METERCAM_TOKEN=` to turn auth on, and
   put the same value in the firmware's `config.h` and in Home Assistant's
   `secrets.yaml` as `metercam_token` (the gas submission's photo). Turn it on
   in that order: HA's secret first, then a firmware build with the token, and
   the service's `.env` only once the board reports that build. The board
   fetches new firmware from this service, so a service that demands the
   token before the board has it locks the board out until a USB flash.
4. `data/ref/gas.jpg` and the ROIs: see "The camera moved" in
   [`operations.md`](operations.md).

Then `sh MeterCam/deploy/deploy.sh` and `sh MeterCam/deploy/probe_cpu.sh`.

---

## The container

Read `_lxc_env.sh` for the reasoning; the values are:

| | | Why not the house default |
| --- | --- | --- |
| VMID | 104 | next after haos17-1, adguard, tailscale, cloudflare |
| address | `LXC_IP/24` from `deploy/lxc.env` | a free address outside the DHCP pool; `lxc_create.sh` refuses one that answers a ping |
| rootfs | `local-lvm`, **8 GB** | the image is about 640 MB, and refused frames accumulate |
| memory | **1024 MB** + 1024 swap | OpenCV holds a UXGA frame several times over |
| cores | 2 of 4 | two reads an hour, allowed to be greedy while they run |
| features | `nesting=1,keyctl=1` | Docker in an unprivileged container needs both |

Root SSH to the host goes through `Proxmox/tools/pve_ssh.sh`. That key belongs
to `Proxmox/`, and its README explains it. `pct exec` has no REST equivalent,
so all of this is SSH. Scripts go into the container as files (`pct push`,
then run by path), not as quoted strings: a script sent through two rounds of
shell quoting fails by doing something adjacent to what was meant.

---

## The host has no AVX

The hypervisor is a **Celeron J4105**: SSE4.2 yes; **AVX, AVX2, FMA and F16C
no**. TensorFlow's wheels abort with `SIGILL` on the first kernel that needs
AVX, with no traceback. `reader.py` falls back `ai-edge-litert` →
`tflite-runtime` → `tensorflow`, and only the first two can work here.

`probe_cpu.sh` **invokes** each model rather than importing a runtime, because
kernels are chosen at the first `invoke()`. It passes today: `ai-edge-litert`
uses XNNPACK's SSE microkernels. Re-run it after any rebuild that changes the
runtime, because `requirements.txt` pins nothing. If it fails, put
`tflite-runtime` ahead of `ai-edge-litert` in `requirements.txt`.

---

## Frame retention

Every read is archived: accepted ones in `gas/raw/<date>/`, refused ones in
`gas/rejected/<date>/`, about 300 KB a frame plus its `.json` (and `.txt` for a
refusal). At 48 wakes a day that is about 14 MB a day. `lxc_provision.sh`
installs `metercam-prune.timer`, **hourly**, with two rules:

1. **Age**: raw frames are kept 7 days, rejected ones 90. A refused frame is the
   whole record of why; an accepted one is corroborated by the reading it
   produced.
2. **Size**: a hard ceiling of `MAX_ARCHIVE_MB`, 1024. Over it, the oldest go
   first, raw before rejected.

The ceiling is not redundant. A camera knocked out of alignment refuses every
wake, and at 48 wakes a day the age rule alone would let that fill the rootfs.
Change the numbers in `_lxc_env.sh` and re-run `lxc_provision.sh`.
