# Operations

Everything below runs on the box. Get a shell there with:

```sh
sh Proxmox/tools/pve_ssh.sh "pct exec 104 -- sh -c 'cd /opt/metercam && …'"
```

## Is it reading?

```sh
docker compose logs --since 2h metercam | grep -v health
```

There is one line per wake:

```
read gas fw=gas-cam-6 -> 2261.74 accepted published to input_number.gas_meter_camera_reading
read gas fw=gas-cam-6 -> None refused: align: too few inliers
```

`curl -s localhost:8770/health` shows `last_read_s_ago`: anything well over
1800 means the board has not woken, or cannot reach the service. Next to it,
`last_accepted_s_ago` counts from the last reading that was *accepted*, so a
run of refusals shows there even while the board wakes on time; it survives a
restart. In Home Assistant, `input_number.gas_meter_camera_reading` moves with
every accepted wake.

**Home Assistant alerts on it** (`HomeAssistant/config/packages/metercam_watch.yaml`):
`sensor.gas_camera_last_accepted` is that age in minutes, polled every 10
minutes, and the household is notified once it passes 6 hours (twelve wakes),
or when MeterCam has not answered for an hour.

An occasional refusal is the design working. A frame caught while the last drum
was rolling, or two frames that disagreed, costs half an hour, and the next
accepted reading includes the gas. A run of refusals with the same reason is
worth a look.

## The last picture, and the archive

From a browser or curl on the LAN (add `?token=…` once auth is on):

```sh
curl -o last.jpg  'http://<metercam-ip>:8770/last.jpg'           # the newest frame
curl -s           'http://<metercam-ip>:8770/archive/days'       # what is stored, per day, with sizes
curl -O -J        'http://<metercam-ip>:8770/archive?days=3'     # today and the two days before, as a zip
```

The zip holds the frames with their `.json` (and `.txt` for refusals), under
the same `gas/raw|rejected/<date>/` paths as on disk. It is streamed, so the
browser's progress bar spins rather than fills.

## Why was a reading refused?

Every read is kept: accepted ones under `raw/` for 7 days, refused ones under
`rejected/` for 90:

```
data/images/gas/rejected/2026-10-02/2026-10-02-00-42-none.jpg     the frame, as the camera sent it
                                    2026-10-02-00-42-none.txt     the reason, value and prevalue
                                    2026-10-02-00-42-none.json    the whole answer: per-drum reads and confidences, alignment
```

The name carries the value that would have been published (`none` if no number
came out). When the two frames of a wake disagreed, both are kept (`~s1.jpg`,
`~s2.jpg`).

Common reasons:

| Reason starts with | Usually |
| --- | --- |
| `align:` | the camera moved, or the lighting changed, since the reference was taken |
| `confirm:` | the two frames disagreed: a drum was mid-roll between them |
| `confidence:` | glare or blur on one drum |
| `decrease:` / `rate:` | a misread; the gate refused it, which is the point |
| `zero:` | a frame of nothing (a dark or covered lens) that read as all zeros |
| `no prevalue:` | Home Assistant unreachable and no `last_accepted.json` |
| `unconfirmed:` | only one frame arrived |

To re-read a frame against the current config, without writing anything:

```sh
docker exec metercam python -m service.reader --config /config/config.json \
    /data/images/gas/rejected/<date>/<frame>.jpg /data/images/gas/rejected/<date>/<frame>-2.jpg
```

## The camera moved, or the lighting changed

The reference and the ROIs are redone **together**:

1. Back up: `cp -p data/ref/gas.jpg data/ref/gas-<date>.jpg` and
   `cp -p config.json config.json.bak-<date>`.
2. Take a sharp frame from the camera's new position: `data/images/gas/last.jpg`
   will do once the camera is settled (check it via `/last.jpg` first). Copy it
   to `data/ref/gas.jpg`.
3. Place one ROI per drum on that frame, left to right: seven boxes of about
   140×210 px, each centred on its digit with a little margin. Write them into
   `meters.gas.rois` in `config.json`.
4. `docker compose up -d --force-recreate`.
5. Re-read the frame you used as the reference, as above. It must align
   (inliers in the thousands) and read the dial exactly.

Until both are done, every wake is refused with `align: …`, which is the right
outcome: nothing reaches Home Assistant.

## A wrong value reached Home Assistant

The gate exists so that this does not happen. If it does, correct the
statistics, because retyping does not fix them:

- **Too high:** the next correct read is a decrease, which the gate refuses, so
  MeterCam stops publishing until the meter passes the bad value. Set
  `input_number.gas_meter_camera_reading` back to the true reading, then
  Developer tools → Statistics → `sensor.gas_meter_reading` → Adjust sum for
  the hour it happened.
- **A drop of more than 10%** is booked as a meter reset: Adjust sum as above.

Then find out why: the accepted frame is in `raw/<date>/`, named for the value
it published, with the whole answer beside it.
