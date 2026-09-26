# Renaming an entity id

Not a config change, and **not something git can record** — entity ids live in
`.storage/core.entity_registry`, which is never mirrored. Doing it through the UI
is fine for one entity. For a rename that has to land across the registry, a
Lovelace dashboard and `configuration.yaml` at the same time, editing `.storage`
directly is far faster, and this is the procedure that works:

1. **Find every reference first.** `configuration.yaml`, the packages and the
   dashboards are all in the mirror now, so `grep -r` over `config/` and
   `dashboards/` finds them; check `homeassistant.exposed_entities` too, which
   is not. Missing a dashboard reference leaves a broken card.
2. **Confirm the target id is free** in the registry. HA appends `_2` rather than
   refusing, which is how stale suffixes appear in the first place.
3. **`ha core stop` before editing.** Home Assistant holds the registry in memory
   and will overwrite your edit on its next save. A plain restart is not enough.
4. Edit by **surgical text replacement** on the raw JSON, not parse-and-re-dump:
   HA writes these files compactly, and re-dumping reformats all 780 KB. Assert
   the entity count is unchanged and no duplicate id was created.
5. `ha core start`, then verify the new ids report real states. ESPHome entities
   match by `unique_id`, so a correct rename keeps its value.
6. **Hard-refresh the browser.** A `.storage` edit fires no
   `entity_registry_updated` event, so open tabs show a ghost duplicate of the
   old entity until reloaded. This looks exactly like a failed rename and is not.

`core.restore_state` and `trace.saved_traces` will keep naming the old id. Both
are inert and self-clear — restore entries expire after 7 days, traces rotate
out.

Two renames done this way are recorded in `docs/audit.md` (findings #6 and #7),
including which references each one had.

**To delete one dead row, don't do any of that.** The procedure above is for a
rename that has to land across the registry, a dashboard and
`configuration.yaml` at once. Deleting the leftover entry of a helper removed
from YAML is one WebSocket call, needs no restart, and cannot corrupt an 856 KB
JSON file:

```sh
python tools/ha_registry.py --orphans          # read-only
python tools/ha_registry.py --remove input_number.old_thing
```

`--orphans` only reports rows whose platform is one this repo's YAML creates
**and** which no longer appear in any YAML under `config/`. Three things look
like orphans and are not, so it skips them: entities that are *disabled*
(zigbee2mqtt leaves a `_linkquality` and a `_last_seen` off for every device),
entities that are unavailable *on purpose* (`binary_sensor.dtek_scheduled_dark`
since DTEK suspended schedules, and half of `bedroom_ac_energy.yaml` whenever
that unit is unplugged), and entities owned by an integration — deleting one of
those just makes it come back as `_2`, which is where stale suffixes come from.

Two details that each hid the first orphan it was pointed at, both now in the
tool: it strips comments before deciding an entity is still referenced (the
note you leave saying where something went reads exactly like a definition),
and it matches whole tokens rather than substrings (`irbridge_ac_tariff` is a
prefix of the live meter key `irbridge_ac_tariff_daily`, so the file that
replaced it appeared to still want it).

`--repairs` lists what's open, and `--clear-stats` is the resolution for a
`state_class_removed` or `units_changed` repair — both are the statistics
compiler saying a sensor stopped being the shape its stored series expects.
The series cannot be reconciled, only dropped. It is irreversible, so read the
repair first: clearing the series for a sensor that *should* have kept its
state class throws away real history to silence a warning about a mistake.
Clearing alone does not retire the notification either — the issue is
re-evaluated only at startup, so a restart is what removes it.

## Helper state after a rename

Home Assistant restores a helper's last state from `.storage/core.restore_state`,
**keyed by entity id**. A renamed `input_boolean` (or `input_number`,
`input_select`, ...) keeps its state until the next restart and then comes back
at its default, because nothing was saved under the new id. When a helper gates
an automation, as the light-sensor toggles do, the automation then looks broken
while it is doing exactly what it was told.

So before renaming helpers, note their states; after the next restart, compare
and restore them, then restart once more and confirm they persist.
