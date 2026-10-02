# Gas and water meters

`config/packages/gas_meter.yaml` and `config/packages/water_meter.yaml` put gas
and cold water on the Energy dashboard's Gas and Water tabs. Both are read off
the dial by hand: an `input_number` holds the figure printed on the meter face,
a template sensor republishes it as `device_class: gas` / `water` with
`state_class: total_increasing`, and two utility meters cut it into a daily and
a monthly total.

Typing a number into a box is not measurement, and the daily bars it produces
are fiction — everything lands in the hour it was typed. The monthly total is
correct, and that is the point: a figure that exists only on a paper bill cannot
be trended, compared against last winter, or noticed when it doubles.

Three things here are deliberate and easy to undo by accident.

**The reading sensors gate on `> 0`, not on `| is_number`.** An `input_number`
with no `initial:` comes up at its `min:` rather than at `unknown`, so a reading
helper is guaranteed to publish `0.0` on its first boot. A `total_increasing`
sensor whose first observed value is 0 takes 0 as its statistics zero point, and
the real dial reading typed afterwards is then booked as consumption — 2245
minus 0, in one hour, permanently, as a row in the statistics table. The gate
means the first value the compiler ever sees is the real one, which it scores as
zero. That is also why `min:` is 0 on those two helpers and must stay there,
against this repo's own "each `min:` IS the default" convention.

**Restart before typing the first reading.** `utility_meter` registers no reload
service, so the meters need `ha core restart` to exist at all — and they never
seed from their source's current state, only from a change to it. Restart first
and the first entry initialises them with a zero adjustment, because the state
it replaces was `unavailable` rather than a number. Type first and they sit at
`unknown` until the reading next moves, which with a hand-typed meter could be a
month. Re-typing the same value does not help: an identical state fires a state
*report*, not a state *change*.

That order has one cosmetic cost, worth expecting rather than debugging. Between
the restart and the first reading the cycle meters are `unknown` **and carry no
unit**, so the statistics compiler records their metadata as unitless; when the
first reading arrives they adopt `m³` and HA raises a `units_changed` repair
against `sensor.gas_today` and `sensor.cold_water_today`. It is not fixable from
the UI — the resolution is `recorder/clear_statistics` on the four cycle meters,
whose statistics at that point are nothing but zeros. Clearing alone does not
retire the notification, because the issue is only re-evaluated at startup;
being non-persistent, it is dropped by the next `ha core restart` and not
recreated once the units agree.

**Gas keeps one entity across both eras.** `sensor.gas_meter_reading` is the only
gas entity the dashboard is pointed at. Long-term statistics are keyed by
statistic id and the Energy dashboard stores that id, so if counting hardware
ever replaces the typing it feeds this same name and the hand-entered history
stays in one continuous series. Pointing the dashboard at a second, "real"
sensor instead would not move the old history — it would simply stop being
looked at. This is why the reed work on `gas-meter-reed-trial` has its own
version of `gas_meter.yaml`: the two collide as an ordinary merge conflict,
which is where the decision about how to combine them belongs.

Tariffs live in `input_number` helpers rather than the dashboard's static price
field, so a rate change is a UI edit that lands in history and the figure itself
is in git. As of September 2026: gas **7.95689 UAH/m³** and cold water
**81.92 UAH/m³** (47.10 supply plus 34.82 wastewater), all including VAT.

The rule for both is *match the supplier's own invoice*, which cuts differently
in each case. Gas **excludes** the ~1.08 per m³ distribution charge from
Gazmerezhi, even though it is genuinely billed per cubic metre and the true
delivered cost is nearer 9.04 — because 7.95689 is what the Naftogaz cabinet
prints, and using it makes every month reconcile to the kopeck against the bill
it exists to check. The cost column therefore under-reports gas by roughly 12%,
on purpose. Water **includes** wastewater, because that is the same utility's
own second line on the same invoice, billed against the same metered volume and
not measured separately. The water figure was Dniprovodokanal's first change in
four and a half years; the numbers near 31 UAH/m³ still dominating search results
are not wrong so much as out of date — that was the real tariff until 30 June
2026, and the backfilled cost history still uses it for everything before then.

## Backfilled history

Everything before September 2026 was **imported, not measured**. It lives in
*external* statistics, not on the meter sensors themselves:

| statistic id | span | total |
| --- | --- | --- |
| `gas:manual_history` / `_cost` | Jan–Aug 2026 | 120.31 m³ · 957.29 UAH |
| `water:manual_history` / `_cost` | Feb–Sep 2026 | 89.00 m³ · 4106.50 UAH |

So the Energy dashboard carries **two sources per utility** — the live sensor and
the imported history — and their totals add. That looks redundant and is not.

**Why history cannot live on the sensor's own statistic id.** The sensor
statistics compiler resumes a running sum from the *short-term* statistics table,
and `recorder/import_statistics` writes only hourly rows. It therefore never sees
imported history, declares the sensor new, restarts its sum at 0 and writes rows
at 0 *behind* the import — which the dashboard renders as a large negative bar.
This was established the hard way: clearing first did not help, importing right
up to the current hour did not help, and restarting made it worse, because the
stale short-term rows survive a restart and are exactly what the compiler reads
on the way back up. External statistic ids are not owned by that compiler, so it
cannot reset them.

The one constraint that follows: HA rejects a price entity on an external source
(`_reject_price_for_external_stat`), so the history sources carry their cost as
their own external statistic wired through `stat_cost`, while the live sources
keep the `input_number` tariff helpers.

**Provenance.** Gas came from the gas supplier's customer cabinet, which
publishes billed *volumes* but only whole-m³ readings; readings were rebuilt
forward from a derived baseline and each checked to truncate to the integer
shown — a real cross-check, not a fit. Cost is volume × the tariff and reproduces
every billed amount to the kopeck. Water came from the water utility's meter
readings page, which publishes actual dated readings, so nothing had to be
reconstructed. The account-history export is useless for this: it contains money
only, and its recalculation entries break any mapping from charge back to volume.

**The water tariff changed mid-series**, so its cost is split at the change date.
The utility publishes only the new tariff, so the old one was derived from the
account history: the supply/wastewater charge ratio changes at exactly that
month, and a one-cubic-metre recalculation entry at the old rate pins the
absolute values. Water cost will not match a single invoice the way gas does,
because the utility bills a flat estimate monthly and trues it up when a reading
arrives.

**What is not trustworthy at fine grain:** consumption is spread evenly between
consecutive readings, so period totals are exact while daily and hourly bars are
interpolation. Water readings are 26–57 days apart and skip whole months. For gas
the spread flattens heating seasonality inside a winter month.

Two mechanics worth keeping: rows are keyed by timestamp, so re-importing
corrected figures overwrites in place; and the cost series carry `state` values
that are never read by the dashboard, which uses `sum` differences only.

The monthly gas reading is also sent to the operator from these numbers, after
a tap on the phone: [`gas-reading-submission.md`](gas-reading-submission.md).
