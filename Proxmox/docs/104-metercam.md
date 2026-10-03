# 104 · MeterCam (`metercam`)

The service that reads the gas meter: it takes the photos the ESP32-CAM pushes
every 30 minutes, reads the dial's digits, and writes the reading into Home
Assistant only when it can stand behind it. It reads meters and nothing
else: filing the reading with the gas operator is [105](105-meterbots.md).
The project is [`MeterCam/`](../../MeterCam/README.md).

| | |
| --- | --- |
| Type | unprivileged LXC, Debian 13, `nesting` and `keyctl` on (it runs Docker) |
| CPU / RAM / disk | 2 vCPU / 1 GB (+1 GB swap) / 8 GB |
| Software | Docker, running the MeterCam service from `MeterCam/docker-compose.yml` |
| Created by | `MeterCam/deploy/lxc_create.sh`, provisioned by `lxc_provision.sh`, updated by `deploy.sh` |
| Starts with host | yes |

## Things to know

- 8 GB where the other containers have 2: the image (Python, OpenCV, the model
  runtime) is about 640 MB, and every refused read is archived; a retention
  timer installed by `lxc_provision.sh` prunes old frames.
- It holds state that is not in git, all in `/opt/metercam/`:
  - `config.json`
  - `.env`: the Home Assistant token and MeterCam's own token
  - the models, the alignment reference and the firmware channel

  A deploy ships code only and never overwrites any of it.
- It is **not dumped** by the weekly backup job. Its state goes off-site as a
  ~3 MB encrypted archive with the LXC run instead
  ([`backups.md`](backups.md)).
- It talks to nothing outside the LAN. Until 2026-10-04 it also held the
  Telegram session for the gas bot; that moved to [105](105-meterbots.md).
- Its address, gateway and VM id are set in `MeterCam/deploy/_lxc_env.sh`, with
  the real address in the git-ignored `deploy/lxc.env`.
- This repository creates and changes it, like 105, through the
  [SSH write path](ssh-write-path.md).
