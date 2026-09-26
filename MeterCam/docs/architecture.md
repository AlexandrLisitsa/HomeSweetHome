# Where the logic lives, and where it does not

**The camera owns the clock. This service owns the arithmetic and the
verdict.** The ESP32-CAM wakes on its own timer, lights the meter, takes a
couple of frames, POSTs them here and goes back to sleep.

```
ESP32-CAM  ──POST /read?meter=gas  (2 JPEGs, multipart)──►  MeterCam :8770
 (asleep 5 min)                                                  │
      ▲                                                          │ GET  /api/states/input_number…
      └──GET /firmware/version.txt──────────────────────────┐    ▼
                                                            │  Home Assistant
                                    ◄──{value, accepted, …}─┘    ▲
                                                                 │ POST /api/services/input_number/set_value
                                                                 └─ only when accepted
```

It used to be the other way round — Home Assistant polled `/read`, passed the
previous reading in as a query parameter, and decided what to do with the
answer. That shape was better, and it is gone for a physical reason: the board
overheats if it stays awake to be asked, and nothing can poll a sleeping ESP32.

So two things moved, and it is worth being precise about which:

- **The clock moved to the camera.** Nothing here schedules anything, still.
- **The writing moved here.** With no poll to answer, this service fetches the
  previous reading from Home Assistant and writes an accepted one back.

**The judging did not move.** `gate()` still decides whether a reading is good
enough to keep, in this repo, in code with tests, and `ha_publish()` is called
only for a reading that already passed it. The token moved the writing here,
not the deciding.

The pull shape still works and is still the right one for anything that can
poll: leave `home_assistant` out of the config and `/read` behaves exactly as
it always did — prevalue from the query string, verdict in the response.

That helper is the only write target, and it is the one this repo has always
had. Everything downstream of it — `sensor.gas_meter_reading` with its
`unique_id`, both utility meters, the Energy dashboard's Gas tab — keeps
working untouched. The dashboard's wiring lives in `.storage/energy`, is not
fetched by `ha_pull.sh` and cannot be restored from this repo, which is exactly
why the camera feeds the existing helper instead of minting a new sensor.

The cost of putting HA in charge is that there is no automatic retry: a failed
poll returns an error, the sensor goes unavailable, and HA tries again in five
minutes. That is visible rather than hidden, which is the trade.

---
