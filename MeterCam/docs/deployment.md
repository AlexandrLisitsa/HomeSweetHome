# MeterCam deployment

Creates LXC **104** on the Proxmox host and runs MeterCam's container in it.

`MeterCam/Dockerfile` has claimed "the identical compose file runs it in the
LXC at <metercam-ip>" since its first commit. This is the part that makes that
sentence true.

| Script | Does | Idempotent? |
| --- | --- | --- |
| `lxc_create.sh` | `pct create` the container, start it, wait for DNS | **no** — refuses if 104 exists |
| `lxc_provision.sh` | Docker, and the frame-retention timer | yes |
| `deploy.sh` | ship the working tree, build, `up -d`, health-check | yes |
| `probe_cpu.sh` | prove the TFLite runtime executes on this CPU | yes |
| `_lxc_env.sh` | the container's spec, sourced by all of the above | — |

```sh
sh MeterCam/deploy/lxc_create.sh
sh MeterCam/deploy/lxc_provision.sh
sh MeterCam/deploy/deploy.sh
sh MeterCam/deploy/probe_cpu.sh
```

After that, a change is one command: `sh MeterCam/deploy/deploy.sh`.

---

## Before the first run: the write path

`Proxmox/tools/pve_get.sh` is a `PVEAuditor` token and stays read-only —
creating a container is not something a metrics token should be able to do.
Everything here goes over SSH as root instead, through
`Proxmox/tools/pve_ssh.sh`.

**That key belongs to `Proxmox/`, not to MeterCam.** It is a general
administrative key for the hypervisor — root, able to create and destroy any
guest, not scoped to container 104 or to this module. MeterCam's deployment is
simply its first consumer. `Proxmox/README.md` owns the explanation; this
section only says enough to get the first deploy moving.

Generate a dedicated key on your workstation
(`ssh-keygen -t ed25519 -f ~/.ssh/pve_ed25519`), alongside `~/.ssh/ha_ed25519` for
the HA guest.
Install the public half once from the Proxmox UI — **Datacenter → proxmox →
Shell**, where you are already root and need no key to get in:

```sh
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo 'ssh-ed25519 AAAA... you@workstation' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

Then:

```sh
sh Proxmox/tools/pve_ssh.sh pveversion
```

Generating it on a fresh clone, and revoking it, are in
`Proxmox/secrets.env.example`.

---

## The container

Read `_lxc_env.sh` for the reasoning; the values are:

| | | Why not the house default |
| --- | --- | --- |
| VMID | 104 | next after haos17-1, adguard, tailscale, cloudflare |
| address | `LXC_IP/24` from `deploy/lxc.env` | a free address outside the DHCP pool; `lxc_create.sh` refuses one that answers a ping |
| rootfs | `local-lvm`, **8 GB** | 2 GB is the convention; the image is 640 MB and the frames grow. Measured after first deploy: 2.2 GB used, 5.2 GB free |
| memory | **1024 MB** + 1024 swap | 512 is the convention; OpenCV holds a 5 MP frame several times over. Measured idle after a read: 134 MB used, 889 MB available |
| cores | 2 of 4 | one read every five minutes, allowed to be greedy while it runs |
| features | `nesting=1,keyctl=1` | Docker in an unprivileged container needs both. adguard already runs this pair |

---

## Three things that will bite

### 1. The host has no AVX

The hypervisor is a **Celeron J4105** — Goldmont Plus. SSE4.2 yes; **AVX, AVX2,
FMA and F16C all absent**. TensorFlow's pip wheels have required AVX since 1.6
and abort with `SIGILL` on the first kernel that needs it — no traceback, just
a dead process.

`reader.py` falls back `ai-edge-litert` → `tflite-runtime` → `tensorflow`, which
looks like three chances and is really two: the `tensorflow` tier cannot run on
this CPU at all. And the chain catches `ImportError`, which SIGILL is not.

Hence `probe_cpu.sh`. It **invokes** each model rather than merely importing a
runtime, because kernels are selected at the first `invoke()` — an interpreter
that constructs fine and dies on first use is exactly this bug's shape.

**Measured 2026-09-05: it passes.** `ai-edge-litert` imports, builds an XNNPACK
delegate and invokes all four models on this CPU; XNNPACK dispatches to its SSE
microkernels and never reaches for AVX. OpenCV 5.0.0 and ORB are fine too. So
the risk is retired — but the probe stays, because the runtime is the part that
moves: `requirements.txt` pins nothing, and the next `docker compose build`
could pull a wheel that has dropped the fallback. Re-run it after any rebuild
that changes the runtime.

If it ever fails: add `tflite-runtime` to `requirements.txt` ahead of
`ai-edge-litert` and redeploy. If *that* fails, the models have to be converted
or the inference has to move off this box.

### 2. The reference and the ROIs are one matched pair

Every ROI in `config.json` is a pixel rectangle **in the reference frame**
(`data/ref/gas.jpg`). Ship one without the other and the container reads eight
rectangles in a coordinate space it has never seen — and because
`auto_reference` is `true`, it adopts its own first frame and returns a
confident wrong number with no error anywhere.

So `deploy.sh` ships `data/ref/` and excludes `data/images/`. It seeds the
reference only when the container has none: once the container is live, its
`/roi` editor is the source of truth, and a deploy must not undo an aiming
session. `--force-ref` overrides.

### 3. Nothing prunes the frames

`app.py`'s `archive()` writes a full-sensor JPEG on every read and deletes
nothing — deliberately, because a rejected frame is the only evidence of a
failure nobody watched happen. At 0.6 MB a frame and a five-minute poll that is
**175 MB/day, 5.1 GB/month**, which fills the 8 GB rootfs before the spring.

`lxc_provision.sh` installs `metercam-prune.timer`, **hourly**, enforcing two
rules in order:

1. **Age** — raw frames kept 7 days, rejected 90. Rejected outlive accepted
   because an accepted frame is corroborated by the reading that came out of it
   and a rejected one is the whole record of why.
2. **Size** — a hard ceiling of `MAX_ARCHIVE_MB`, 1024 by default. Over it,
   oldest-first, raw before rejected, `.jpg` and its `.txt` together.

The second rule is not redundant. Seven days of raw is already ~1.2 GB, and
90 days of rejected at the full poll rate is far more — which is the live case,
not a hypothetical, while the camera is out of alignment and refusing every
frame. Age says what is worth keeping; the cap says what there is room for on
an 8 GB rootfs that also holds a 640 MB image.

Hourly rather than daily because the ceiling is only as tight as the interval:
at the normal poll rate the worst-case overshoot is about 7 MB.

Frames are foldered by day and named for their reading —
`gas/raw/2026-09-05/2026-09-05-16-11-2246.916.jpg` — so the timer also sweeps
date directories once they empty. `raw/` and `rejected/` stay above the date
folder precisely so `-path '*/raw/*'` can still tell the two retention classes
apart; see **The archive** in `MeterCam/README.md`.

Change the numbers in `_lxc_env.sh` and re-run `lxc_provision.sh`.

---

## Why the working tree and not a git ref

Three things the service cannot start without are gitignored on purpose:

- `config.json` — holds the camera's LAN address
- `models/*.tflite` — jomjol's weights, no stated licence
- `.env` — the auth token

A deploy from a clean clone would produce a container that builds and then
cannot read a meter. `deploy.sh` therefore packs the working tree, minus
`data/images`, `corpus`, `deploy` and the usual Python litter.

---

## Why SSH and not a second API token

`pct create` has an API equivalent. `pct exec` does not — the API offers a
websocket terminal, which is not a thing a shell script should be driving. Half
the job would be REST and half would be SSH, so it is all SSH.

Provisioning scripts go in as **files** (`pct push`, then execute by path)
rather than as quoted strings. A script sent as `pct exec … sh -c '…'` over SSH
survives two rounds of shell quoting, and the failure mode is not a syntax
error — it is a script that runs with half its quotes eaten and does something
adjacent to what was meant. The file also stays in the container's `/tmp`,
which is worth a lot at 2am.

---

## State as of 2026-09-05

LXC 104 is **created, provisioned and running**. Docker 29.8.0, Compose v5.5.1,
`overlayfs` (not the `vfs` fallback). `/health` answers on
`http://<metercam-ip>:8770`, the prune timer is active, and a `GET /read` walks
the whole pipeline — capture, align, crop, infer, gate — in about 1.4 s.

**The infrastructure is done; the aiming is not.** The first live read came back
`00111111` at 0.345 confidence and was refused, with
`align.dx = -808.3` on 21 inliers: the phone has moved some 800 px from the
frame the ROIs were drawn against. Both guards fired independently — the
confidence floor and the `total_increasing` decrease check — which is the gate
behaving exactly as `MeterCam/README.md` argues it should.

Nothing in this directory fixes that. It is a phone on a shelf, and it is why
the ESP32-CAM is the next piece of work rather than more code.

## Not done yet

- **Aim, then re-reference.** The camera has to be fixed in a position it will
  hold, then `POST /reference` (or **Set reference** in `/roi`) and the ROIs
  redrawn against that frame. Until then every read is refused, correctly.
- **Home Assistant.** No `rest:` sensor points at `<metercam-ip>:8770` yet. The
  shadow period in `MeterCam/README.md` comes first — the OCR has to agree with
  hand typing for a week or two before it writes to `input_number`.
- **Backups.** 104 is not in any backup job. The container holds nothing that
  is not in this repo except `data/ref/gas.jpg` and the archived frames.
- **The ESP32-CAM.** Only a URL in `config.json` changes; none of this does.
