# The HTTP endpoint

| Endpoint | What |
| --- | --- |
| `GET /read` | Capture, parse, judge. `?meter=` `?prevalue=` `?save=` `?elapsed_s=` |
| `POST /read` | Same, but reads the JPEG from the request body. No camera needed — this is what the tests use |
| `GET /capture` | A photo and nothing else. For aiming |
| `GET /last.jpg` | The frame behind the last answer |
| `GET /last_annotated.jpg` | Same frame with ROI boxes and per-drum readings drawn on |
| `POST /preview` | Try a set of ROIs without saving them. The editor's Test button |
| `POST /reference` | Store the current frame as the alignment reference |
| `GET /archive` | Every stored frame as one streamed zip. `?meter=` `?days=` |
| `GET /archive/days` | What is on disk, newest first, with age and byte counts. Read this before the one above |
| `GET /roi` | The editor |
| `GET /aim` | A one-button photo page for aiming the camera and focusing the lens; its size in KB rises as focus sharpens |
| `GET /health` | Config status, known meters, whether auth is on |

Auth is `X-Auth-Token`, matching `HomeAssistant/config/irbridge/rest_commands.yaml`.
Also accepted as `?token=`, because the editor is a browser page and a browser
cannot set a header on a plain navigation.

```json
{
  "meter": "gas", "value": 2246.91, "accepted": true, "reason": null,
  "dial": 2246.916,
  "digits": [0, 2, 2, 4, 6, 9, 1, 6], "raw": "02246916",
  "prevalue": 2246.90, "delta": 0.01,
  "confidence": {"per_drum": [0.99, 0.98, "..."], "min": 0.91},
  "align": {"ok": true, "inliers": 84, "dx": -2.1, "dy": 0.4},
  "captured_at": "2026-09-05T14:32:07+0300", "duration_ms": 1840
}
```

`accepted: false` always carries a `reason` and still populates `value`, so a
rejected read can be looked at rather than guessed at.

---
