# 104 · MeterCam (`metercam`)

The service that reads the gas meter: it takes the photo the ESP32-CAM sends,
reads the dial's digits, and answers Home Assistant's poll with a reading only
when it can stand behind it. The project is [`MeterCam/`](../../MeterCam/README.md).

| | |
| --- | --- |
| Type | unprivileged LXC, Debian 13, `nesting` and `keyctl` on (it runs Docker) |
| CPU / RAM / disk | 2 vCPU / 1 GB (+1 GB swap) / 8 GB |
| Software | Docker, running the MeterCam service from `MeterCam/docker-compose.yml` |
| Created by | `MeterCam/deploy/lxc_create.sh`, provisioned by `lxc_provision.sh`, updated by `deploy.sh` |
| Starts with host | yes |

## Things to know

- 8 GB where the other containers have 2: the image (Python, OpenCV, the model
  runtime) is about 640 MB, and every read is archived; a retention timer
  installed by `lxc_provision.sh` prunes old frames.
- Its address, gateway and VM id are set in `MeterCam/deploy/_lxc_env.sh`, with
  the real address in the git-ignored `deploy/lxc.env`.
- It is the one guest this repository creates and changes, through the
  [SSH write path](ssh-write-path.md).
