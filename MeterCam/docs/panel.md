# The control panel

**`http://cam.lan`**, or `http://<metercam-ip>:8770/` directly.

The panel shows in a browser what the reader has been doing: the latest frame, every archived read with its digits and confidences, why reads were refused, how the reading and the confidence have moved, and how full the archive is. It is part of the MeterCam service itself (`service/panel.py`, `service/templates/`, `service/static/`) and needs no container of its own. The frames, the sidecars and the reader are all already there.

## Open on the LAN, no login

The panel is a house dashboard, like `home.lan`, so its routes do not ask for a token. The service's own routes still do: `/read`, `/last.jpg`, `/last_accepted.jpg`, `/archive`, `/archive/days` and `/firmware/*`. The camera's API keeps its token, and `tests/test_routes.py` fails if any of those routes stops checking it.

That means anyone on the LAN (or on the tailnet) can see photographs of the meter and publish a firmware build. The firmware form only accepts a real ESP32 image whose version is higher than the one on offer (see below).

## Tabs

| Tab | Shows |
| --- | --- |
| **Live** | Last accepted value and its age, the last read's verdict, when the next wake is due (flagged *late* 5 min after), the firmware the board runs against the one on offer, whether Home Assistant is being written, and the newest and last-accepted frames side by side with the newest read's drums |
| **Gallery** | One day of reads as thumbnails, filtered to accepted or refused. A click opens the frame with its drums, confidences, alignment, the reason, any other frames of the same wake, and **Replay** |
| **Trend** | 7 or 30 days: the accepted reading, the lowest drum confidence of every read against `min_confidence` and `min_confidence_last_digit`, and reads per day split by refusal reason |
| **Storage** | Archive size against metercam-prune's 1 GB ceiling, per day and per meter |
| **Firmware** | What is on offer and what the board ran at its last wake, and the form that publishes a new build |

## Replay

Replay runs one archived frame through `reader.read_once()` with the **current** `config.json`, and draws every ROI on the aligned frame with the digit and the confidence it read. Green passes the gate's confidence floor, amber passes only the last drum's looser floor, and red would be refused.

Nothing is published, archived or remembered. So it is safe to press, and after a ROI or threshold change it is the quickest way to check the change against the frames that went wrong. It is a single-frame read: the agreement check between the frames of a wake and the gate itself are not applied, so it shows the value and the reason but never "accepted".

Replay takes the reader's lock, the same one `POST /read` holds. If the camera is mid-read it waits up to 5 s and then answers *busy*. The camera always comes first.

## Firmware

The form does what [firmware.md](firmware.md) describes by hand: it writes `gas-cam.bin`, then `version.txt`, in that order. A board that wakes between the two writes still sees the old version and does nothing. It refuses:

- a version without a number after its last `-` (the board compares exactly that number);
- a version that is not higher than the one on offer;
- a file that is not an ESP32 application image (first byte `0xE9`) or is over 4 MB.

The board takes the build at its next wake. The *Board runs* line on that tab, and the gallery's per-read firmware, show when it did.

## What it costs

Nothing while nobody is looking:

- **No background work.** No thread, timer, index or cache. Every listing reads the sidecars of one day on request. `/api/series` reads up to 30 days, and only when the Trend tab is opened.
- **Thumbnails** are made the first time a frame is shown and kept in `<day>/.thumbs/` with the frame's own mtime. metercam-prune's age rule deletes them with the frame. `/archive` and `/archive/days` skip dot-folders.
- **The browser goes quiet.** The Live tab refreshes once a minute only while it is the visible tab, and stops when the tab is hidden or closed. No other tab polls.
- **Threads.** waitress runs 4 threads instead of 2, so a page of thumbnails cannot leave the camera's `POST /read` waiting for a thread. An idle thread costs nothing.

## Routes

| Route | What |
| --- | --- |
| `GET /` | The page |
| `GET /api/overview?meter=gas` | The Live tab's numbers |
| `GET /api/reads?meter=gas&day=YYYY-MM-DD&kind=all\|raw\|rejected` | One day's reads from the sidecars, oldest first |
| `GET /api/series?meter=gas&days=7` | Trend points and per-day counts, up to 30 days |
| `GET /api/days` | `/archive/days` plus the ceiling, for the Storage tab and the day picker |
| `GET /img/<meter>/<raw\|rejected>/<day>/<file>.jpg[?thumb=1]` | An archived frame, or its thumbnail. Nothing outside the archive resolves |
| `GET /live/<meter>/<last\|last_accepted>.jpg` | The newest frames, for the Live tab |
| `POST /api/replay` `{meter, kind, day, file}` | Replay, as above. The annotated frame comes back as a data URL |
| `POST /api/firmware` multipart `version`, `bin` | Publish a build, as above |

Tests: `tests/test_panel.py`, which runs in the container like `test_reader.py`.
