/**
 * PowMr Inverter Console card.
 *
 * Draws the whole Inverter tab of the Power station dashboard: a live power
 * flow diagram (grid -> inverter -> house, plus the battery leg), the three
 * inverter selects, the tariff meters, and a history chart. Registered as a
 * Lovelace resource, so it is handed `hass` directly -- no token, no iframe,
 * no CORS.
 *
 * WHY THIS IS NOT A STACK OF TILE CARDS
 * -------------------------------------
 * The tab it replaces was three grid sections of stock `tile` cards. Every
 * number was there and none of the relationships were: nothing showed that the
 * grid was feeding the house AND charging the battery at once, or how hard.
 * A flow diagram needs `style`, and every shortcut to it is absent here --
 * card-mod, button-card and power-flow-card-plus are not installed, HACS
 * carries no frontend cards on this box, and HA sanitises markdown through
 * filterXSS (frontend/src/resources/markdown-worker.ts) whose allowlist has no
 * `style` attribute and no <style> tag. A custom element has its own shadow
 * root and none of those limits. Same reasoning, and the same shape, as
 * dtek-shutdowns-card.js -- that card is this one's template.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * ESPHome (PowerStation/power-station.yaml) by way of the PI30 QPIGS reply for
 * everything inverter-side, and the JK BMS for everything battery-side. The
 * BMS is authoritative for the battery: sensor.jkbms_gateway_bms_power is
 * SIGNED (+ charging, - discharging) and its state_of_charge is a real SOC, so
 * neither the flow direction nor the charge level has to be inferred from the
 * inverter's two unsigned current sensors or from pack voltage.
 *
 * Two upstream quirks this card has to know about:
 *
 *   - binary_sensor.powmr_inverter_grid_condition_safe is `device_class:
 *     safety`, so ON means UNSAFE. Reading it the obvious way inverts the
 *     grid tile.
 *   - sensor.powmr_inverter_grid_real_power_calculated is derived, not
 *     measured. It returns 0 below 150 V of grid and adds a hardcoded +30 W of
 *     inverter overhead, and it is import-only -- there is no export on this
 *     system and no CT clamp to measure one.
 *
 * THERE IS NO PV. The QPIGS reply carries PV fields but the firmware discards
 * them, so a solar leg would be a firmware change, not a dashboard one.
 * Nothing here draws one.
 *
 * THE HISTORY CHART IS LIVE, AND NOT BY POLLING
 * ---------------------------------------------
 * The recorder is queried once per window per TTL. That is where the chart
 * comes from; it is not how it keeps up. Every `set hass` hands this card the
 * sample the recorder is about to store, so _ingest appends it to the cached
 * windows and redraws the drawn one -- line, axes, off-scale count, the
 * Now/Min/Max/Mean row and any readout under the cursor all move with the
 * tiles above them. The poll in _tick is only the correction: it replaces a
 * window with what the recorder actually kept, which is how a gap left by a
 * dropped socket or a suspended laptop heals.
 *
 * TWO THINGS THAT WILL WASTE YOUR AFTERNOON
 *
 *   1. Bump VERSION below on EVERY edit to this file, then re-register it.
 *      The browser caches an ES module hard and you will be debugging the new
 *      card while looking at the old one. The resource URL's ?v= IS the
 *      VERSION -- MAJOR.MINOR.PATCH, see "Versions" in the top-level README --
 *      and --card reads it from this file rather than trusting a typed one:
 *
 *        python HomeAssistant/tools/ha_dashboard.py --card powmr-inverter-console-card.js
 *
 *   2. Do NOT re-render this card by replacing innerHTML the way
 *      dtek-shutdowns-card.js does. `set hass` fires on every state change
 *      across all ~331 entities here; rebuilding the DOM would recreate the
 *      flow elements and restart their CSS animations, so the dashes would
 *      snap back to phase zero several times a minute. _build() runs once,
 *      _patch() only writes custom properties and textContent. See _setFlow.
 */

const CARD = "powmr-inverter-console-card";
import { cardTip } from "./card-tip.js?v=1.0.0";
import { ramp, rampCss } from "./card-ramp.js?v=1.0.0";

const VERSION = "2.11.2";

/*
 * Brand colours stay literal: they identify a leg of the diagram (amber =
 * grid, green = battery, blue = load), and a theme reassigning them would stop
 * the battery run matching the battery tile.
 *
 * THE THREE SEMANTIC COLOURS ARE LITERAL TOO, AND THAT IS A CHANGE.
 *
 * They used to read `var(--success-color, #34E39A)` and friends, on the
 * argument that no theme should be able to paint an overvoltage warning green.
 * The cost of that was larger than the benefit and it showed on this box: HA's
 * default theme resolves them to #43a047, #ffa600 and #db4437 -- a flatter
 * green and a harder orange than the design's #34E39A / #FFB454 / #FF5C5C.
 *
 * The mismatch is not only a matter of taste. Every gauge gradient below
 * hardcodes the design's three stops, so a themed number sat above a band
 * painted in a different green: the mark was in the green zone and the reading
 * over it was a colour that zone never contains. One palette, used by both,
 * is the whole point of colouring them at all.
 *
 * A theme can still restyle the card through ha-card; what it can no longer do
 * is disagree with the gauge under the number.
 */
const GRID_C = "#AE8446";
const BATT_C = "#589569";
const LOAD_C = "#6EA8FE";

const OK = "#589569";
const WARN = "#AE8446";
const BAD = "#BB635B";

const BLOCKS = ["header", "flow", "controls", "history"];

const DEFAULTS = {
  // Grid
  grid_voltage: "sensor.powmr_inverter_grid_voltage",
  grid_frequency: "sensor.powmr_inverter_grid_frequency",
  grid_power: "sensor.powmr_inverter_grid_real_power_calculated",
  grid_safe: "binary_sensor.powmr_inverter_grid_condition_safe",
  // Unfiltered 185-250 V check. ON while grid_safe is still unsafe means the
  // firmware's delayed_off is running; the header counts it down.
  grid_in_range: "binary_sensor.powmr_inverter_grid_voltage_in_range",
  // Inverter / load
  ac_output_voltage: "sensor.powmr_inverter_ac_output_voltage",
  load_power: "sensor.powmr_inverter_ac_output_power",
  load_percentage: "sensor.powmr_inverter_load_percentage",
  uptime: "sensor.powmr_inverter_total_uptime",
  // Battery -- the BMS first, it is the one with a sign and a real SOC
  battery_power: "sensor.jkbms_gateway_bms_power",
  battery_soc: "sensor.jkbms_gateway_bms_state_of_charge",
  battery_voltage: "sensor.powmr_inverter_battery_voltage_inverter",
  charge_current: "sensor.powmr_inverter_battery_charge_current",
  discharge_current: "sensor.powmr_inverter_battery_discharge_current",
  // Energy
  // The flat's electricity meter (ElectricityMeter/, packages/
  // electricity_meter.yaml): what the grid really delivers, the boiler's
  // circuit included, which never passes through the inverter. Its power is
  // the Meter tile under Grid; its tariff counters, priced at the Energy
  // dashboard's rates (see _loadPrices), are the energy rows.
  meter_power: "sensor.electricity_meter_power",
  meter_day: "sensor.electricity_meter_tariff_day",
  meter_night: "sensor.electricity_meter_tariff_night",
  meter_total: "sensor.electricity_meter_energy",
  meter_tariff: "select.electricity_meter_tariff",
  // Controls
  max_charge_current: "select.powmr_inverter_max_ac_charge_current",
  power_priority: "select.powmr_inverter_power_priority",
  ac_input_mode: "select.powmr_inverter_inverter_ac_input_mode",
  // What the outage pre-charge intends (HomeAssistant/config/packages/
  // outage_precharge.yaml). Read only for the Pre-charge chip's sub-label.
  precharge_plan: "sensor.outage_pre_charge_plan",
  // Adaptive night charge (HomeAssistant/config/packages/adaptive_charge.yaml):
  // the second dot on the AC charge chip, and the plan behind its sub-label.
  adaptive_charge: "input_boolean.adaptive_night_charge",
  adaptive_plan: "sensor.adaptive_charge_plan",
  // Ceilings the flow speed scales against. 2400 W is the inverter's rating
  // and was already the `max` on the tab's old bar-gauge.
  max_grid_w: 2400,
  max_load_w: 2400,
  max_batt_w: 1600,
  // The flat's breaker: the Meter tile's scale (the same 60/85 % bands as
  // the load gauge) and its run's full speed.
  max_meter_w: 6000,
  // grid_safe's delayed_off in PowerStation/power-station.yaml. Keep in step.
  grid_return_s: 300,
  device_label: "PowMr · Hybrid Inverter",
  title: "Power Station",
  blocks: BLOCKS.slice(),
};

/*
 * The header's switches. Each keeps its own MDI icon so a chip and its badge
 * read as one control. Night only and Pre-charge used to be chips of their
 * own; they only ever shape AC charging, so they are icons on that chip now
 * (AC_DOTS below), and the header is three chips instead of five.
 *
 * The design had a fifth chip ("Quiet / night fan limit"). This system has no
 * such switch and it is deliberately not faked. The badge row's other three
 * entries are elsewhere in this card: uptime and tariff in the header, and
 * grid_condition_safe in the Grid tile's status word.
 */
const CHIPS = [
  { label: "Auto", cfg: "chip_auto", ent: "switch.powmr_inverter_auto_tariff_mode", icon: "mdi:clock-check-outline", color: BATT_C },
  { label: "Protect", cfg: "chip_protect", ent: "switch.powmr_inverter_auto_grid_protection", icon: "mdi:shield-home", color: BATT_C },
  { label: "AC charge", cfg: "chip_ac_charge", ent: "switch.powmr_inverter_ac_charging_enabled", icon: "mdi:battery-charging-50", color: GRID_C, live: true, dots: true },
];
CHIPS.forEach((c) => { DEFAULTS[c.cfg] = c.ent; });
/*
 * The AC charge chip carries the charger's feature toggles as small icons
 * after its label, in this order: when it charges (Night only), how hard
 * (adaptive), and the outage override (Pre-charge). The charger itself is the
 * chip's own icon on the left, which pulses while the pack charges -- no dot
 * of its own, so the main switch stands apart from the features. Each icon
 * is its own switch: dim when off, lit in its colour when on, a tap toggles
 * it, the tooltip names it and its state.
 *
 * THE RULE: an icon pulses while it is acting, not merely on. The charger
 * (the chip's left icon) while the pack takes grid current; Night only while
 * the pack charges under its window; adaptive and Pre-charge while their plan
 * reads `charging`. On and idle is lit and still. Adaptive is an input_boolean with its
 * own rules and keeps its config key (adaptive_charge); the other two keep
 * the keys they had as chips, so an existing override still works.
 */
/*
 * Lines 2-4 of every tooltip on the card, in the house format
 * (HomeAssistant/docs/dashboard-tooltips.md): what the element means, then
 * "E.g." with this house's numbers, then at most a limit or a tap hint. Line
 * 1, "<name> — <state>", is built when the card patches; tip() joins the two.
 * Keep it in step with PowerStation/docs/architecture.md (§3, §4, §10, §11),
 * the two charge packages and electricity_meter.yaml.
 */
const HELP = {
  // Header
  uptime: "How long the PowerStation controller has run in total, across reboots and updates."
    + "\nE.g. up 41d 6h; a hard power cut loses at most the last 5 min of it.",
  pill: "Whether the inverter trusts the grid, with its AC input mode and the clock."
    + "\nE.g. Grid down after 5 s under 185 V; back in range, Grid returning counts 5:00.",
  ret: "Time left until the firmware trusts the grid again: 5 min of stable voltage."
    + "\nE.g. voltage back at 14:02: it counts down from 5:00 and the grid is trusted at 14:07.",
  // Chips and the AC charge chip's icons
  chip_auto: "Runs the house on the pack by day and on the grid at night: SBU Battery 07:00–23:00."
    + "\nE.g. at 22:59 the house runs on the pack; at 23:00 it switches to Utility First."
    + "\nCannot be on together with Night only.",
  chip_protect: "Moves the house to the battery when the grid leaves 185–250 V; beats every rule."
    + "\nE.g. a brownout to 170 V: SBU Battery within 5 s, back after 5 min of stable grid.",
  chip_ac_charge: "The BMS charge switch: lets the pack charge from the grid at all; pulses while it does."
    + "\nE.g. off at 23:30 under Auto: the house still runs on the grid, the pack stays as it is."
    + "\nNight only and a running Pre-charge take it over and switch it back on.",
  chip_night_only: "Opens the charger only in the night tariff, 23:00–07:00; the pack is a cheap UPS."
    + "\nE.g. on: charging stops at 07:00 and starts again at 23:00."
    + "\nCannot be on together with Auto.",
  adaptive_charge: "Charges at night at the lowest current that still fills the pack by 06:30."
    + "\nE.g. half full at 23:00 needs ~21 A, so 30 A, not 60 A; re-sized every 10 min."
    + "\nNeeds Auto with the charger on, or Night only; an outage window switches it off.",
  chip_precharge: "Arms a full pack before each scheduled DTEK outage; idle until DTEK publishes one."
    + "\nE.g. outage at 10:00: fills overnight at night rates, or by day at the amps it needs.",
  adaptive_plan: "What adaptive night charge is doing: the current it set and when the charge ends."
    + "\nE.g. 20 A → 07:00 at night, tonight by day, full within 1 % of a full pack.",
  precharge_plan: "What pre-charge is doing for the next DTEK outage: the amps and the outage start."
    + "\nE.g. 30 A → 10:00 while charging; at night → 10:00 when the night tariff will do.",
  // Flow tiles and their status words
  tile_grid: "Mains voltage at the inverter input, its frequency and the inverter's estimated draw."
    + "\nE.g. 231.4 V · 50.00 Hz · 640 W in; Protect trips outside 185–250 V for 5 s.",
  tile_inv: "The inverter's output voltage to the house, with its AC input mode and power priority."
    + "\nE.g. 230.0 V out · APL · SBU Battery: by day under Auto the house runs on the pack.",
  tile_load: "What the house draws from the inverter's output, against its 2400 W rating."
    + "\nE.g. 1500 W is 62.5 % of 2400 W: ELEVATED, amber from 1440 W.",
  tile_meter: "What the flat's electricity meter measures: all grid power, the boiler's circuit too."
    + "\nE.g. 2450 W is 40.8 % of the 6000 W breaker; the inverter's figure misses the boiler.",
  tile_batt: "The 8S 280 Ah pack's state of charge, as the BMS reports it."
    + "\nE.g. 87 %: green from 70 %, amber below, red under 20 %.",
  volt_state: "The voltage band: NOMINAL 220–240 V, LOW or HIGH out to 200 or 250 V, then UNDER/OVER."
    + "\nE.g. 243.0 V reads HIGH in amber; on Grid, NO GRID once the inverter calls it unsafe.",
  load_state: "How hard the circuit is worked: NORMAL to 60 %, ELEVATED to 85 %, HEAVY, OVERLOAD."
    + "\nE.g. House load 2100 W of 2400 W is 87.5 %: HEAVY; Meter reads HEAVY above 5100 W.",
  batt_state: "Whether the pack charges, discharges or idles (within ±2 W), then its charge band."
    + "\nE.g. DIS · MODERATE: discharging at 45 %; CRITICAL under 20 %, FULL from 95 %.",
  batt_sub: "Pack voltage at the inverter, the BMS's signed power, and the current while one flows."
    + "\nE.g. 26.8 V · 1450 W in · 54.0 A on a night charge at the 60 A maximum."
    + "\nTap: opens the current while one flows, the voltage otherwise.",
  // Flow runs
  run_grid: "The inverter's draw from the grid; the dashes run faster with the watts, to 2400 W."
    + "\nE.g. 0 W on SBU Battery by day; load + 30 W + charging on Utility First at night.",
  run_load: "Power from the inverter to the house; the dashes run faster with the watts, to 2400 W."
    + "\nE.g. 640 W: a steady stream; under 5 W the run dims and stops.",
  run_batt: "The BMS's signed pack power: the dashes flow into the pack charging, out discharging."
    + "\nE.g. 1450 W in on a night charge, 380 W out by day under Auto; full speed at 1600 W.",
  run_meter: "The meter's whole-flat power from the grid; the dashes reach full speed at 6000 W."
    + "\nE.g. 2450 W while the boiler heats, though the inverter itself draws far less.",
  // Controls
  sel_max_charge: "The most current the charger may push into the pack from the grid: 2, 10 … 60 A."
    + "\nE.g. adaptive sets 30 A at 23:00 and puts your own value back at 07:00."
    + "\nAdaptive and Pre-charge overwrite a hand choice while they run.",
  sel_priority: "Which source runs the house: Utility First (grid) or SBU Battery (pack, then grid)."
    + "\nE.g. Auto picks SBU Battery at 07:00 and Utility First at 23:00."
    + "\nAuto, Protect and Pre-charge overwrite a hand choice at their next decision.",
  sel_ac_mode: "How wide a mains voltage the inverter accepts: APL ~90–280 V, UPS ~170–280 V."
    + "\nE.g. a brownout to 160 V: UPS moves to the battery by itself, APL rides it out.",
  // Energy rows
  erow_day: "Grid energy the meter counted on the day tariff, 07:00–23:00, this month."
    + "\nE.g. 123.46 kWh at 4.32 ₴/kWh is 533.35 ₴; marked active from 07:00 to 23:00.",
  erow_night: "Grid energy the meter counted on the night tariff, 23:00–07:00, this month."
    + "\nE.g. 78.90 kWh at 2.16 ₴/kWh is 170.42 ₴; marked active from 23:00 to 07:00.",
  erow_total: "The meter's own register: the whole flat's lifetime grid energy, both tariffs."
    + "\nE.g. 15234.6 kWh, the same figure as the total on the meter's display.",
  // History
  range: "Shows this span on the chart, ending now, and keeps it live as readings arrive."
    + "\nE.g. 24h on SOC shows the night charge as the 23:00–07:00 climb."
    + "\nPast 36 h (7d, 14d) it draws hourly statistics, not every reading.",
  tab: "Picks the series the chart draws; one with bands takes its tile's colour."
    + "\nE.g. Grid voltage at 243 V draws the line amber, like the Grid tile's HIGH.",
  ch_name: "The series on the chart: drag to pan, pinch or scroll to zoom, double-click for live."
    + "\nE.g. zoom 24h down to the minute a brownout began; a range button goes back to live."
    + "\nTap: opens the series' own entity.",
  ch_win: "The span the chart covers, and how many readings ran off the scale."
    + "\nE.g. last 24 hours · 3 readings off-scale: spikes clipped so the rest stays readable.",
  stat: "Now is the live value; Min, Max and the time-weighted Mean cover the window drawn."
    + "\nE.g. Grid Voltage, 24h: Min 214.2 V, Max 246.0 V, Mean 229.8 V.",
};

/** A whole tooltip: line 1 (clipped to the 90-character line) and the HELP lines. */
function tip(head, key) {
  const h = String(head);
  return (h.length > 90 ? h.slice(0, 89) + "…" : h) + (HELP[key] ? "\n" + HELP[key] : "");
}
const AC_DOTS = [
  { ref: "Nt", label: "Night only", cfg: "chip_night_only", ent: "switch.powmr_inverter_night_charging_only", icon: "mdi:weather-night", color: LOAD_C },
  { ref: "Ad", label: "Adaptive night charge", cfg: "adaptive_charge", icon: "mdi:tune-variant", color: GRID_C },
  { ref: "Pc", label: "Pre-charge", cfg: "chip_precharge", ent: "switch.powmr_inverter_outage_pre_charge", icon: "mdi:battery-clock", color: GRID_C },
];
AC_DOTS.forEach((d) => { if (d.ent) DEFAULTS[d.cfg] = d.ent; });
/*
 * The Pre-charge dot's switch only ARMS the feature -- nothing happens until
 * DTEK publishes a window -- so ON alone says little. The chip carries a
 * sub-label from its plan sensor instead: "30 A → 09:30" while charging, "at
 * night" while the night tariff will do.
 *
 * `live` marks the chip whose switch only PERMITS something. AC charge sits
 * on all night whether or not a watt is moving, so ON alone says nothing; the
 * chip pulses while the grid is up and the BMS says the pack is taking
 * current. There is no PV here, so a charging pack on grid is the AC charger.
 *
 * `dots` gives a chip the AC_DOTS icons. The adaptive one sizes the charge current
 * to finish by 07:00, with a sub-label from its plan ("20 A → 07:00"). It
 * only works under Auto or Night only, with the charger on, so otherwise its
 * icon is dimmed and a tap on it does nothing.
 */

/*
 * History tabs. `cfg` names the DEFAULTS key, so an override follows through.
 *
 * `band` names the threshold the series is judged against, and a series that
 * has one is DRAWN IN ITS BAND'S COLOUR rather than in `color` -- see
 * _seriesColor. Grid voltage sitting at 224 V is nominal, so its line is the
 * same green as the word NOMINAL in the tile above it, and it turns amber at
 * 240 V with the tile. `color` is the identity colour, and it is what the four
 * series with no threshold keep: grid power, frequency, battery power and
 * battery voltage are numbers this card has no opinion about, and inventing
 * bands for them to colour a line would be inventing the opinion too.
 */
const SERIES = [
  { key: "grid_v", cfg: "grid_voltage", name: "Grid Voltage", short: "Grid voltage", unit: "V", dec: 1, band: "volt", color: GRID_C },
  { key: "grid_w", cfg: "grid_power", name: "Grid Power", short: "Grid power", unit: "W", dec: 0, color: GRID_C },
  { key: "ac_out", cfg: "ac_output_voltage", name: "AC Output Voltage", short: "AC output", unit: "V", dec: 1, band: "volt", color: GRID_C },
  { key: "load_w", cfg: "load_power", name: "Load Power", short: "Load", unit: "W", dec: 0, band: "load", color: LOAD_C },
  { key: "freq", cfg: "grid_frequency", name: "Grid Frequency", short: "Frequency", unit: "Hz", dec: 2, color: GRID_C },
  { key: "bms_w", cfg: "battery_power", name: "Battery Power", short: "Battery power", unit: "W", dec: 0, color: BATT_C },
  { key: "soc", cfg: "battery_soc", name: "Battery SOC", short: "SOC", unit: "%", dec: 0, band: "soc", color: BATT_C },
  { key: "bat_v", cfg: "battery_voltage", name: "Battery Voltage", short: "Battery voltage", unit: "V", dec: 1, color: BATT_C },
];

/*
 * Cumulative meters: a rising total charts as a ramp, so these are rows. All
 * from the electricity meter -- what YASNO bills -- not the inverter's
 * estimate, which misses the boiler's circuit. The tariff rows are this
 * month's, with their cost at the Energy dashboard's price when it has one.
 */
const ENERGY = [
  { key: "mtr_d", cfg: "meter_day", priced: true, short: "Day this month", unit: "kWh", dec: 2, tariff: "day", help: "erow_day" },
  { key: "mtr_n", cfg: "meter_night", priced: true, short: "Night this month", unit: "kWh", dec: 2, tariff: "night", help: "erow_night" },
  { key: "mtr_t", cfg: "meter_total", short: "Meter total", unit: "kWh", dec: 1, help: "erow_total" },
];

/*
 * `points` is a BUDGET of drawn samples, not a resample width -- see
 * _decimate, which spends it two rows at a time on each bucket's extremes.
 * The plot is 1000 viewBox units wide, so past ~1500 points there is nothing
 * left to resolve and the path string just gets expensive.
 */
const RANGES = {
  "30m": { hours: 0.5, points: 900, label: "last 30 minutes" },
  "1h": { hours: 1, points: 900, label: "last hour" },
  "24h": { hours: 24, points: 1500, label: "last 24 hours" },
  "7d": { hours: 168, points: 1500, label: "last 7 days" },
  "14d": { hours: 336, points: 1500, label: "last 14 days" },
};

/*
 * The stops the viewport zooms between. MIN_SPAN is a minute because below
 * that a 3-second sensor has nothing left to show, and the ceiling is the
 * largest preset -- the recorder is not asked for more history than the
 * longest button already asks for.
 */
const MIN_SPAN = 60000;
const MAX_SPAN = Math.max.apply(null, Object.keys(RANGES)
  .map((k) => RANGES[k].hours)) * 3600000;

// How far back raw states reach: the recorder keeps two days
// (configuration.yaml, purge_keep_days: 2). A window starting before this is
// drawn from hourly long-term statistics instead. 36 h, not 48, so a window
// that would lean on the last hours before a purge takes statistics too.
const RAW_HORIZON = 36 * 3600000;

const CH_W = 1000;
const CH_H = 260;
const CH_PAD = 14;

/* Voltage gauges span 190-260 V; the coloured zones below match those stops. */
const V_LO = 190;
const V_SPAN = 70;

const DASH = 14; // px, one gradient period -- must match @keyframes flowX/flowY

/*
 * SOC bands, taken from the Battery tab's gauge severity on the same entity
 * (green 70, yellow 20, red 0). The .gauge.soc gradient stops and the tick
 * labels under the bar use the same two numbers -- change them together.
 */
const SOC_RED = 20;
const SOC_GREEN = 70;
/*
 * How far either side of a threshold the colour fades between two bands
 * (card-ramp.js), per reading. At most half the narrowest gap between two of
 * its thresholds, so every band keeps a solid middle: grid voltage has 240 and
 * 250 only 10 V apart, so 5 V.
 */
const SOC_FADE = 10;
const V_FADE = 5;
const LOAD_FADE = 10;

/* The bands as ramp edges -- [threshold, colour below, colour above]. */
const V_EDGES = (bad, warn, ok) => [[200, bad, warn], [220, warn, ok], [240, ok, warn], [250, warn, bad]];
const LOAD_EDGES = (bad, warn, ok) => [[60, ok, warn], [85, warn, bad]];
const SOC_EDGES = (bad, warn, ok) => [[SOC_RED, bad, warn], [SOC_GREEN, warn, ok]];

/*
 * Space Grotesk ships no Cyrillic subset from Google, so Cyrillic in the sans
 * face falls back to system-ui. IBM Plex Mono does carry one, and the mono face
 * is where an entity name would land, so that is the one that matters.
 * Extracted from the design bundle and served locally: no request leaves the
 * house and the card still renders with the network down.
 */
const FONTS = [
  ["IBM Plex Mono", 400, "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Mono", 500, "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Mono", 600, "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Mono", 400, "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Mono", 500, "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Mono", 600, "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Mono", 400, "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["IBM Plex Mono", 500, "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["IBM Plex Mono", 600, "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["Space Grotesk", "400 700", "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["Space Grotesk", "400 700", "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
].map(function (f) {
  var slug = f[0] === "Space Grotesk" ? "space-grotesk" : "ibm-plex-mono";
  var file = f[0] === "Space Grotesk"
    ? slug + "-" + f[2] + ".woff2"
    : slug + "-" + f[1] + "-" + f[2] + ".woff2";
  return "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1]
    + ";font-display:swap;src:url('/local/fonts/" + file + "') format('woff2');"
    + "unicode-range:" + f[3] + "}";
}).join("\n");

/*
 * THE FACES ARE REGISTERED ON THE DOCUMENT, NOT IN THIS CARD'S SHADOW ROOT.
 *
 * Chrome does not apply an @font-face rule declared inside a shadow tree. The
 * rule parses and CSSOM keeps it -- sheet.cssRules lists every one, with the
 * right family, weight and src -- and the font is never fetched or used.
 * Nothing warns; the text simply renders in the fallback.
 *
 * This card carried its faces in the shadow style from the day it was written,
 * so its Space Grotesk had never loaded: every heading on the Inverter tab was
 * system-ui, and IBM Plex Mono only looked correct on boxes that happen to
 * have it installed. Found while building jkbms-battery-console-card.js, which
 * copied the same mistake. The id keeps this idempotent -- both cards can be
 * on one dashboard, and each installs only what it is missing.
 */
const FONT_STYLE_ID = "powmr-inverter-console-fonts";

function installFonts() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(FONT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = FONTS;
  document.head.appendChild(style);
}

const STYLE = `
:host { display: block; container-type: inline-size; container-name: pmcard; }

ha-card {
  /* Type scale. 1.0 is the design at its own 1560px width. */
  --s: 1;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #080909;
  background-image: radial-gradient(1200px 600px at 15% -10%, #14161b 0%, #080909 60%);
  color: #E8EAED;
  font-family: 'Space Grotesk', system-ui, -apple-system, sans-serif;
  border: 1px solid #16181d;
  box-shadow: none;
  overflow: hidden;
}
/*
 * max-width is the design's own, and it matters: every size in here is a fixed
 * px value tuned against a 1560px box. Letting the card stretch to the full
 * width of a 5-column section scales nothing up, so the type just gets smaller
 * relative to the layout and the whole thing reads washed out.
 */
.root { padding: 28px; display: flex; flex-direction: column; gap: 22px; }
.mono { font-family: var(--mono); }

/* --- header ------------------------------------------------------------- */
.head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
.head-l { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.kicker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-family: var(--mono); font-size: calc(11px * var(--s)); letter-spacing: .22em; color: #6E737E; text-transform: uppercase; }
.kdot { width: 4px; height: 4px; border-radius: 50%; background: #2A2E36; flex: none; }
.up { color: ${OK}; letter-spacing: .12em; cursor: pointer; }
.title { font-size: calc(30px * var(--s)); font-weight: 600; letter-spacing: -.02em; line-height: 1; }
.pill { display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  border: 1px solid #1F2229; border-radius: 999px; background: #0E1013; flex: none;
  cursor: pointer; transition: border-color .15s, background .15s; }
.pill:hover { border-color: #3A3F4A; background: #14171C; }
.livedot { width: 7px; height: 7px; border-radius: 50%; background: ${OK}; flex: none;
  animation: pmpulse 2s ease-in-out infinite; }
.vsep { width: 1px; height: 14px; background: #23262E; flex: none; }
.pill .mono { font-size: calc(12px * var(--s)); }
.pill [hidden] { display: none; }
.pill .ret { color: ${WARN}; font-variant-numeric: tabular-nums; }
@keyframes pmpulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }

/* --- toolbar ------------------------------------------------------------ */
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 14px;
  border: 1px solid #1C1E24; border-radius: 16px;
  background: linear-gradient(180deg, #0E1014 0%, #0A0B0E 100%); padding: 12px 14px; }
.bar-l { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.segs { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: #0A0B0E; border: 1px solid #1C1E24; }
.seg { padding: 7px 15px; border: none; border-radius: 9px; cursor: pointer; background: transparent;
  color: #6E737E; font-family: var(--mono); font-size: calc(12px * var(--s)); letter-spacing: .02em; transition: all .15s; }
.seg:hover { color: #B9BEC7; }
.seg[aria-pressed="true"] { background: #1B1E25; color: #E8EAED; box-shadow: 0 1px 0 #262A33 inset; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 8px; border-radius: 11px;
  font-family: inherit; font-size: calc(13px * var(--s)); transition: all .16s;
  border: 1px solid #1F2229; background: #0C0E11; color: #616671; }
.chip.on { border-color: var(--cb); background: var(--cf); color: var(--cc); }
.chip .ic { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;
  border-radius: 8px; flex: none; cursor: pointer; transition: background .15s; }
.chip .ic:hover { background: #ffffff14; }
.chip .ic ha-icon { --mdc-icon-size: calc(17px * var(--s));
  width: calc(17px * var(--s)); height: calc(17px * var(--s)); }
.chip .lbl { cursor: pointer; white-space: nowrap; }
.chip .lbl:hover { text-decoration: underline; text-underline-offset: 3px; }
.chip .sub { font-family: var(--mono); font-size: calc(11px * var(--s)); opacity: .75; white-space: nowrap; }
.chip .sub:empty { display: none; }
.chip .dw { display: flex; align-items: center; justify-content: center; width: 18px; height: 22px;
  border-radius: 6px; flex: none; cursor: pointer; }
.chip .dw:hover { background: #ffffff14; }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #2A2E36; }
.chip.on .dot { background: var(--cc); box-shadow: 0 0 8px var(--cs); }
.chip.on.live { animation: pmchip 2s ease-in-out infinite; }
.chip.on.live .dot { animation: pmpulse 2s ease-in-out infinite; }
/* AC charge's feature toggles are icons (AC_DOTS). Each keeps its own state,
   whatever the chip's switch is doing: --dc is its colour, --ds its glow. */
.chip .dw.i { width: 22px; margin-left: -4px; }
.chip .dw.i ha-icon { --mdc-icon-size: calc(15px * var(--s)); color: #4A505B; transition: color .2s; }
.chip .dw.i.on ha-icon { color: var(--dc); filter: drop-shadow(0 0 4px var(--ds)); }
.chip .dw.i.on.act ha-icon { animation: pmpulse 2s ease-in-out infinite; }
/* A chip without a dot of its own (AC charge) pulses its main icon instead. */
.chip.on.live.nodot .ic ha-icon { animation: pmpulse 2s ease-in-out infinite; }
.chip .dw.i.dis { cursor: not-allowed; opacity: .35; }
.chip .dw.i.dis:hover { background: transparent; }
@keyframes pmchip { 0%, 100% { box-shadow: 0 0 0 0 transparent } 50% { box-shadow: 0 0 14px -2px var(--cs) } }

/* --- panels ------------------------------------------------------------- */
.cols { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; align-items: stretch; }
.panel { border: 1px solid #1C1E24; border-radius: 18px; min-width: 0; }
.panel.flow { padding: 24px; background: linear-gradient(180deg, #101216 0%, #0B0C0F 100%); }
.panel.ctl { padding: 18px; background: #0B0C0F; display: flex; flex-direction: column; gap: 12px; }
.panel.hist { padding: 22px; background: #0B0C0F; }
.plabel { font-family: var(--mono); font-size: calc(11px * var(--s)); letter-spacing: .2em; color: #6E737E; text-transform: uppercase; }
.panel.flow > .plabel { margin-bottom: 22px; }

/* --- tiles -------------------------------------------------------------- */
.flowrow, .battrun, .battwrap { display: grid; grid-template-columns: 1fr 64px 1fr 64px 1fr; gap: 10px; }
.flowrow { align-items: center; }
.battrun > *, .battwrap > * { grid-column: 3; grid-row: 1; }
/* The Meter tile hangs under Grid the way Battery hangs under Inverter. */
.battrun > .direct, .battwrap > .direct { grid-column: 1; }
.direct[hidden] { display: none !important; }
.tile { border-radius: 14px; padding: 16px; min-width: 0; cursor: pointer; transition: border-color .15s; }
.tile:hover { border-color: #3A3F4A; }
.tile.t-grid { border: 1px solid #241D14; background: #0F0D0A; }
.tile.t-inv { border: 1px solid #23262E; background: #0E1014; box-shadow: 0 0 0 1px #101318, 0 18px 50px -30px #000; }
.tile.t-load { border: 1px solid #131C2A; background: #0A0D12; }
.tile.t-batt { border: 1px solid #12271E; background: #080F0C; }
/* The meter is the grid's own figure: Grid's amber family, like the other tiles. */
.tile.t-dir { border: 1px solid #241D14; background: #0F0D0A; }
.t-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.t-name { font-family: var(--mono); font-size: calc(10px * var(--s)); letter-spacing: .18em; text-transform: uppercase; }
.t-grid .t-name { color: #8A7550; }
.t-inv .t-name { color: #6E737E; }
.t-load .t-name { color: #5B7091; }
.t-batt .t-name { color: #4E8C71; }
.t-dir .t-name { color: #8A7550; }
.t-state { font-family: var(--mono); font-size: calc(10px * var(--s)); letter-spacing: .14em; white-space: nowrap; }
.t-val { font-size: calc(26px * var(--s)); font-weight: 600; margin-top: 8px; line-height: 1; }
.t-val i { font-size: calc(13px * var(--s)); margin-left: 4px; font-style: normal; }
.t-grid .t-val i { color: #8A7550; }
.t-inv .t-val i { color: #6E737E; }
.t-load .t-val i { color: #5B7091; }
.t-dir .t-val i { color: #8A7550; }
.t-batt .t-val { font-size: calc(34px * var(--s)); }
.t-batt .t-val i { font-size: calc(14px * var(--s)); color: #4E8C71; margin-left: 3px; }
.t-sub { font-family: var(--mono); font-size: calc(12px * var(--s)); color: #6E737E; margin-top: 6px; }
.t-batt .t-row { display: flex; align-items: flex-end; gap: 14px; margin-top: 8px; flex-wrap: wrap; }
.t-batt .t-row .t-val { margin-top: 0; }
.t-batt .t-row .t-sub { margin-top: 0; padding-bottom: 4px; cursor: pointer; }
.t-batt .t-row .t-sub:hover { color: #B9BEC7; }
.gauge { position: relative; height: 6px; border-radius: 6px; margin-top: 14px; opacity: .55; }
/* The tracks fade across each threshold exactly where the paint does (card-ramp.js). */
.gauge.volt { background: ${rampCss(V_EDGES(BAD, WARN, OK), V_FADE, (v) => (v - V_LO) / V_SPAN * 100)}; }
.gauge.load { background: ${rampCss(LOAD_EDGES(BAD, WARN, OK), LOAD_FADE)}; }
.gauge.soc { opacity: 1; overflow: hidden;
  background: ${rampCss(SOC_EDGES("#2E1618", "#2B2313", "#12241C"), SOC_FADE)}; }
.socfill { height: 100%; border-radius: 6px; width: 0; transition: width .4s;
  /*
   * The fill fades in from 40% alpha of its own colour, so the bar reads as a
   * charge level rather than a block. The design writes that by appending "66"
   * to the hex, and that is exactly how this broke: the colour arrived as
   * var(--warning-color, #AE8446), so "66" landed after the closing bracket,
   * the gradient failed to parse, and CSSOM dropped the declaration without a
   * word. Width 66%, no background, nothing drawn.
   *
   * color-mix takes the colour however it arrives -- literal, var(), or a
   * chain of them. The flat first line is the fallback where color-mix is not
   * understood: a solid fill is worth more than no fill.
   */
  background-image: linear-gradient(90deg, var(--fc), var(--fc));
  background-image: linear-gradient(90deg, color-mix(in srgb, var(--fc) 40%, transparent), var(--fc)); }
.mark { position: absolute; top: -3px; left: 0; width: 2px; height: 12px; border-radius: 2px;
  background: #E8EAED; box-shadow: 0 0 6px #000; transition: left .4s; }
.ticks { position: relative; height: 12px; margin-top: 5px; font-family: var(--mono); font-size: calc(9px * var(--s)); color: #4A4E57; }
.ticks span { position: absolute; transform: translateX(-50%); }
.ticks span.l0 { left: 0; transform: none; }
.ticks span.r0 { right: 0; left: auto; transform: none; }

/*
 * THE FLOW DASHES -- the point of the whole card.
 *
 * One 14px gradient period, translated exactly one period by the keyframe, so
 * the loop is seamless. --dur is the seconds per period and is the ONLY thing
 * that changes with power: 2.4s barely moving, down to 0.3s flat out. Writing
 * it retunes the running animation rather than restarting it, which is the
 * whole reason this card patches properties instead of rebuilding its DOM.
 *
 * Idle pauses through animation-play-state, NOT by dropping the animation --
 * removing and re-adding it would restart the phase, which is the stutter this
 * design is trying to avoid.
 */
.run { display: flex; align-items: center; justify-content: center; min-width: 0; }
.run i {
  display: block;
  animation-name: flowX;
  animation-duration: var(--dur, 2.4s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-direction: var(--dir, normal);
  animation-play-state: var(--play, running);
  opacity: var(--op, .85);
  transition: opacity .35s;
}
.run.x i { height: 2px; width: 100%;
  background-image: repeating-linear-gradient(90deg, var(--c) 0 6px, transparent 6px ${DASH}px); }
.run.y i { width: 2px; height: 34px; animation-name: flowY;
  background-image: repeating-linear-gradient(180deg, var(--c) 0 6px, transparent 6px ${DASH}px); }
@keyframes flowX { from { background-position: 0 0 } to { background-position: ${DASH}px 0 } }
@keyframes flowY { from { background-position: 0 0 } to { background-position: 0 ${DASH}px } }

/* --- controls ----------------------------------------------------------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field > .flabel { font-size: calc(13px * var(--s)); color: #9AA0AB; cursor: pointer; width: fit-content; }
.field > .flabel:hover { color: #E8EAED; text-decoration: underline; text-underline-offset: 3px; }
.selwrap { position: relative; }
select { width: 100%; padding: 10px 38px 10px 13px; border-radius: 12px; border: 1px solid #23262E;
  background: #101216; color: #E8EAED; font-family: var(--mono); font-size: calc(14px * var(--s)); cursor: pointer;
  -webkit-appearance: none; appearance: none; }
select:hover { border-color: #3A3F4A; }
select:disabled { cursor: not-allowed; color: #5C616B; }
.caret { position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
  color: #6E737E; pointer-events: none; font-size: calc(11px * var(--s)); }
.erows { border-top: 1px solid #1C1E24; padding-top: 12px; margin-top: auto;
  display: flex; flex-direction: column; gap: 6px; }
.erow { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; cursor: pointer;
  padding: 4px 8px; margin: 0 -8px; border-radius: 8px; transition: background .15s; }
.erow:hover { background: #121419; }
.erow.on { background: #101821; }
.erow .el { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.erow .en { font-size: calc(13px * var(--s)); color: #9AA0AB; }
.erow.on .en { color: #E8EAED; }
.erow .tag { font-family: var(--mono); font-size: calc(9px * var(--s)); letter-spacing: .16em; text-transform: uppercase; color: ${LOAD_C}; }
.erow .ev { font-family: var(--mono); font-size: calc(14px * var(--s)); color: ${LOAD_C}; white-space: nowrap; }
.erow .ev small { font-size: calc(12px * var(--s)); color: #8A7550; margin-left: 6px; }

/* --- history ------------------------------------------------------------ */
.hhead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; }
.hname { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; }
.hname .n { font-size: calc(20px * var(--s)); font-weight: 600; cursor: pointer; }
.hname .n:hover { text-decoration: underline; text-underline-offset: 4px; }
.hname .w { font-family: var(--mono); font-size: calc(12px * var(--s)); color: #5C616B; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.tab { padding: 7px 13px; border-radius: 999px; cursor: pointer; font-family: var(--mono); font-size: calc(12px * var(--s));
  border: 1px solid #23262E; background: #101216; color: #8A9099; transition: all .15s; }
.tab:hover { color: #E8EAED; }
.tab[aria-pressed="true"] { border-color: var(--tc); background: #101216; color: var(--tc); }
/* 33% and 10% are the 55 and 1A these carried as hex alpha. Written as a mix
   of --tc so the chip follows a colour that now changes under it, without the
   two extra properties -- and without an alpha suffix on a value this file no
   longer guarantees is a literal. */
.tab[aria-pressed="true"] { border-color: color-mix(in srgb, var(--tc) 33%, transparent);
  background: color-mix(in srgb, var(--tc) 10%, transparent); }
.chart { display: flex; gap: 14px; margin-top: 20px; align-items: flex-start; }
.yax { display: flex; flex-direction: column; justify-content: space-between; height: ${CH_H}px;
  padding: ${CH_PAD}px 0; box-sizing: border-box; font-family: var(--mono); font-size: calc(11px * var(--s)); color: #5C616B; }
.yax span { display: block; height: 0; line-height: 0; white-space: nowrap; }
.plot { flex: 1; min-width: 0; position: relative;
  /*
   * pan-y hands vertical scrolling back to the page and keeps everything
   * else: a horizontal drag and a two-finger pinch arrive here as pointer
   * events instead of scrolling or zooming the dashboard. Without it a drag
   * on the chart would scroll the view behind it on every phone.
   */
  touch-action: pan-y; cursor: grab; user-select: none; -webkit-user-select: none; }
.plot.grabbing { cursor: grabbing; }
svg.ch { width: 100%; height: ${CH_H}px; display: block; }
.xax { display: flex; justify-content: space-between; font-family: var(--mono); font-size: calc(11px * var(--s));
  color: #5C616B; margin-top: 8px; gap: 4px; }
.hv { position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 1; }
.hv.on { opacity: 1; }
.hvline { top: 0; height: ${CH_H}px; width: 1px; background: #3A3F4A; }
.hvdot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid #0B0C0F;
  transform: translate(-50%, -50%); }
.tip { position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
  transform: translate(-50%, -100%); z-index: 2;
  background: #14171C; border: 1px solid #2A2E36; border-radius: 9px; padding: 6px 10px;
  font-family: var(--mono); font-size: calc(12px * var(--s)); color: #E8EAED; white-space: nowrap;
  box-shadow: 0 10px 30px -12px #000; }
.tip.on { opacity: 1; }
.tip b { display: block; font-weight: 600; font-size: calc(13px * var(--s)); }
.tip i { display: block; font-style: normal; color: #6E737E; font-size: calc(10px * var(--s)); letter-spacing: .08em; margin-top: 2px; }
.plot svg.ch { cursor: crosshair; }
.note { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  font-family: var(--mono); font-size: calc(12px * var(--s)); color: #4A4E57; text-align: center; padding: 0 12px; }
.note.show { display: flex; }
.stats { display: flex; flex-wrap: wrap; gap: 26px; margin-top: 18px; border-top: 1px solid #1C1E24; padding-top: 16px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat b { font-family: var(--mono); font-size: calc(10px * var(--s)); letter-spacing: .16em; text-transform: uppercase;
  color: #5C616B; font-weight: 400; }
.stat span { font-size: calc(16px * var(--s)); font-weight: 600; }
.foot { font-family: var(--mono); font-size: calc(11px * var(--s)); color: #4A4E57; text-align: center; }

@container pmcard (min-width: 1250px) { ha-card { --s: 1.06; } }
@container pmcard (min-width: 1500px) { ha-card { --s: 1.12; } }
@container pmcard (min-width: 1750px) { ha-card { --s: 1.18; } }
@container pmcard (min-width: 2100px) { ha-card { --s: 1.26; } }

/* --- narrow ------------------------------------------------------------- */
@container pmcard (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }

/*
 * Below ~900px the 1fr 64px 1fr 64px 1fr flow row cannot hold three tiles, so
 * everything stacks and the two horizontal runs become vertical ones -- same
 * keyframe, same speed mapping, just rotated.
 */
@container pmcard (max-width: 900px) {
  .flowrow, .battrun, .battwrap { grid-template-columns: 1fr; }
  .battrun > *, .battwrap > * { grid-column: 1; grid-row: auto; }
  /* Stacked, Grid is three tiles up: a run from it would point at Load. The
     Meter tile goes last, under Battery. */
  .battrun > .direct { display: none; }
  .battwrap { gap: 10px; }
  .battwrap > .t-batt { order: 1; }
  .battwrap > .direct { order: 2; }
  .flowrow > .run.x i { width: 2px; height: 28px; animation-name: flowY;
    background-image: repeating-linear-gradient(180deg, var(--c) 0 6px, transparent 6px ${DASH}px); }
  .title { font-size: calc(24px * var(--s)); }
  .root { padding: 18px 14px 22px; }
  .panel { padding: 16px; }
}

/*
 * The dash SPEED is information here, so this card cannot simply drop the
 * animation -- but it must still honour the preference. Paused dashes keep the
 * direction and the dimming, and every value is on screen as a number anyway.
 */
@media (prefers-reduced-motion: reduce) {
  .run i, .livedot, .chip.on.live, .chip.on.live .dot,
  .chip.on.live.nodot .ic ha-icon, .chip .dw.i.on.act ha-icon { animation-play-state: paused; }
  .socfill, .mark { transition: none; }
}
`;

class PowmrInverterConsoleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    cardTip(this, this.shadowRoot);
    this._hass = null;
    this._config = null;
    this._built = false;
    this._el = {};
    this._print = null;
    this._timer = null;
    // 30m by default. The tiles above answer "what is it doing now"; the
    // shortest window is the one that answers "and what did it just do",
    // which is the question asked of a card someone opened during an outage.
    this._range = "30m";
    this._sel = SERIES[0].key;
    this._hist = new Map();
    this._inflight = new Map();
    this._token = null;
    // The Energy dashboard's grid prices, by the meter they are set on; see
    // _loadPrices.
    this._prices = null;
    this._pricesAt = 0;
    this._pricesBusy = false;
    // Where the cursor is, so a redraw can put the readout back under it
    // rather than being held off until the pointer leaves.
    this._hovering = false;
    this._hoverX = null;
    /*
     * The viewport. null is "live": the whole preset window, right edge at
     * now. A zoom or a pan writes {start, end, follow} and the presets stop
     * being what is drawn -- see _domain. `follow` means the right edge was
     * left at now, so the window keeps tracking it instead of freezing.
     */
    this._view = null;
    this._dom = null;
    this._pointers = new Map();
    this._gesture = null;
    this._dragging = false;
    this._viewTimer = null;
    this._drawnKey = null;
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    if (!Array.isArray(cfg.blocks) || !cfg.blocks.length) {
      throw new Error(CARD + ": blocks must be a non-empty list of " + BLOCKS.join(", "));
    }
    const unknown = cfg.blocks.filter((b) => BLOCKS.indexOf(b) < 0);
    if (unknown.length) {
      throw new Error(CARD + ": unknown block(s) " + unknown.join(", ")
        + " -- expected " + BLOCKS.join(", "));
    }
    ["max_grid_w", "max_load_w", "max_batt_w", "max_meter_w"].forEach((k) => {
      const n = Number(cfg[k]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(CARD + ": " + k + " must be a positive number, got " + cfg[k]);
      }
      cfg[k] = n;
    });
    // Every entity is overridable, so a typo should fail here rather than draw
    // a card full of em dashes.
    Object.keys(DEFAULTS).forEach((k) => {
      if (typeof DEFAULTS[k] === "string" && DEFAULTS[k].indexOf(".") > 0) {
        if (typeof cfg[k] !== "string" || cfg[k].indexOf(".") < 1) {
          throw new Error(CARD + ": " + k + " must be an entity id, got " + cfg[k]);
        }
      }
    });
    this._config = cfg;
    // A changed config means a changed DOM, so drop the built tree.
    this._built = false;
    this._print = null;
    this._hist.clear();
    // A history reply still in flight belongs to the old tree: it may have no
    // chart at all now. Dropping the token makes it land on the floor.
    this._token = null;
    this._drawnKey = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadPrices();
    if (this._config) this._render();
  }

  /*
   * The tariff rows' money is the month's kWh times the Energy dashboard's
   * price, worked out here rather than read off its sensor.*_cost.
   *
   * Those cost sensors are not restored: every HA start brings them back at 0
   * with a fresh last_reset. The Energy dashboard does not mind, it sums
   * statistics across resets, but the state itself is "since the last
   * restart", so the card showed 0.00 ₴ against a half-month of kWh after
   * every `ha core restart`. The kWh are monthly utility meters, which do come back.
   *
   * The price comes from the Energy prefs so that it is set in one place: a
   * fixed number, or a price entity read live. Asked again hourly, so a rate
   * changed in the Energy settings lands without a reload. One price for the
   * whole month: a rate changed mid-month reprices all of it, which the
   * Energy dashboard does not do.
   */
  _loadPrices() {
    if (!this._hass || typeof this._hass.callWS !== "function" || this._pricesBusy) return;
    if (this._prices && Date.now() - this._pricesAt < 3600000) return;
    this._pricesBusy = true;
    this._pricesAt = Date.now();
    Promise.resolve()
      .then(() => this._hass.callWS({ type: "energy/get_prefs" }))
      .then((prefs) => {
        const map = {};
        ((prefs && prefs.energy_sources) || []).forEach((src) => {
          if (!src || src.type !== "grid") return;
          // Older Energy prefs nest the meters under flow_from.
          const flows = Array.isArray(src.flow_from) ? src.flow_from : [src];
          flows.forEach((f) => {
            if (!f || typeof f.stat_energy_from !== "string") return;
            if (typeof f.entity_energy_price === "string" && f.entity_energy_price) {
              map[f.stat_energy_from] = { entity: f.entity_energy_price };
            } else if (Number.isFinite(f.number_energy_price)) {
              map[f.stat_energy_from] = { number: f.number_energy_price };
            }
          });
        });
        this._prices = map;
      })
      .catch(() => {
        // No Energy dashboard, or no admin: the rows go without money. Kept
        // as an empty map so this is not asked again until the hour is up.
        this._prices = this._prices || {};
      })
      .then(() => {
        this._pricesBusy = false;
        if (this._config && this._hass) this._render();
      });
  }

  /** The price per kWh set on this meter, or null. */
  _price(id) {
    const p = this._prices && this._prices[id];
    if (!p) return null;
    return p.entity ? this._num(p.entity) : p.number;
  }

  connectedCallback() {
    // Cheap and idempotent. Done here as well as at module load because a
    // module can be evaluated before <head> exists.
    installFonts();
    // The clock is the only thing that moves without a state change.
    if (!this._timer) this._timer = window.setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    const per = { header: 3, flow: 14, controls: 0, history: 12 };
    return this._config
      ? this._config.blocks.reduce((t, b) => t + (per[b] || 0), 0)
      : 29;
  }

  static getStubConfig() {
    return {};
  }

  /*
   * A sections view lays each section out as a 12-column sub-grid, and a card
   * that does not answer this gets a narrow default slot -- which squeezed the
   * flow diagram into ~350px however wide the section itself was. "full" is
   * the whole section width, which is what `column_span` on the section was
   * for.
   */
  getGridOptions() {
    return { columns: "full", rows: "auto", min_columns: 6 };
  }

  // --- state reading -------------------------------------------------------

  _stateObj(id) {
    return (this._hass && this._hass.states && this._hass.states[id]) || null;
  }

  _state(id) {
    const st = this._stateObj(id);
    return st ? st.state : "unknown";
  }

  /** A finite number, or null for unknown/unavailable/non-numeric. */
  _num(id) {
    const st = this._stateObj(id);
    if (!st) return null;
    const v = parseFloat(st.state);
    return Number.isFinite(v) ? v : null;
  }

  _opts(id) {
    const st = this._stateObj(id);
    const o = st && st.attributes && st.attributes.options;
    return Array.isArray(o) ? o : [];
  }

  _fmt(v, dec) {
    return v === null || v === undefined ? "—" : v.toFixed(dec);
  }

  // --- derivation ----------------------------------------------------------

  /*
   * Grid voltage bands, from the design. The gauge's coloured zones use the
   * same edges, so a mark sitting in the amber band always reads HIGH or LOW.
   * The colour fades V_FADE either side of each edge (card-ramp.js); the word
   * from _vLabel still changes on the edge itself.
   */
  _vColor(v) {
    if (v === null) return "#5C616B";
    return ramp(v, V_EDGES(BAD, WARN, OK), V_FADE);
  }

  _vLabel(v) {
    if (v === null) return "NO DATA";
    if (v > 250) return "OVERVOLTAGE";
    if (v < 200) return "UNDERVOLTAGE";
    if (v >= 240) return "HIGH";
    if (v <= 220) return "LOW";
    return "NOMINAL";
  }

  _loadColor(p) {
    if (p === null) return "#5C616B";
    return ramp(p, LOAD_EDGES(BAD, WARN, OK), LOAD_FADE);
  }

  _loadLabel(p) {
    if (p === null) return "NO DATA";
    return p > 100 ? "OVERLOAD" : p > 85 ? "HEAVY" : p > 60 ? "ELEVATED" : "NORMAL";
  }

  /** SOC_RED/SOC_GREEN, faded SOC_FADE either side -- the word still snaps. */
  _socColor(p) {
    if (p === null) return "#5C616B";
    return ramp(p, SOC_EDGES(BAD, WARN, OK), SOC_FADE);
  }

  _socLabel(p) {
    if (p === null) return "NO DATA";
    return p < SOC_RED ? "CRITICAL" : p < SOC_GREEN ? "MODERATE" : p < 95 ? "HEALTHY" : "FULL";
  }

  /**
   * True when there is no usable mains. Two independent tells, because either
   * can lag: the safety binary_sensor (ON = unsafe) and the voltage itself,
   * below the 150 V the firmware treats as "no grid".
   */
  _gridDown() {
    const v = this._num(this._config.grid_voltage);
    return this._state(this._config.grid_safe) === "on" || (v !== null && v < 150);
  }

  /*
   * Truncate in whole hours rather than rounding the fractional day: rounding
   * turns 14.9999 d into 24 h and, with a naive guard, back into "14d 0h".
   */
  _uptime() {
    const d = this._num(this._config.uptime);
    if (d === null) return "—";
    const total = Math.floor(d * 24);
    return "up " + Math.floor(total / 24) + "d " + (total % 24) + "h";
  }

  _pct(v, lo, span) {
    if (v === null) return 0;
    return Math.max(0, Math.min(100, (v - lo) / span * 100));
  }

  /**
   * The relative-speed mapping, straight from the design.
   *
   *   r   = |watts| / max, clamped to 0..1
   *   dur = 2.4 - 2.1 * r^0.55  seconds per 14px dash period
   *
   * The 0.55 exponent is what keeps low power visibly moving instead of
   * crawling -- a linear map spends most of its range looking idle. Below 5 W
   * the run dims and pauses rather than animating imperceptibly.
   *
   * `signed` legs also pick a direction from the sign, so the battery run
   * flows toward the battery while charging and away from it while
   * discharging. Sign chooses direction, magnitude chooses speed.
   */
  _setFlow(el, watts, max, signed) {
    if (!el) return;
    const w = watts === null ? 0 : Math.abs(watts);
    const r = Math.max(0, Math.min(1, w / max));
    const dur = (2.4 - 2.1 * Math.pow(r, 0.55)).toFixed(2);
    const idle = w < 5;
    el.style.setProperty("--dur", dur + "s");
    el.style.setProperty("--op", idle ? ".18" : ".85");
    el.style.setProperty("--play", idle ? "paused" : "running");
    if (signed) {
      el.style.setProperty("--dir", (watts || 0) < 0 ? "reverse" : "normal");
    }
  }

  // --- interaction ---------------------------------------------------------

  /** The native HA dialog. `composed` is what gets it out of the shadow root. */
  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: entityId },
      bubbles: true,
      composed: true,
    }));
  }

  _onClick(ev) {
    const path = ev.composedPath ? ev.composedPath() : [ev.target];
    for (const node of path) {
      if (!node || node === this.shadowRoot || !node.getAttribute) continue;
      const act = node.getAttribute("data-act");
      if (act === "toggle") {
        ev.stopPropagation();
        ev.preventDefault();
        // A dimmed adaptive dot: Auto and Night only are both off.
        if (node.classList && node.classList.contains("dis")) return;
        const ent = node.getAttribute("data-ent");
        // switch.* for the firmware chips, input_boolean.* for adaptive.
        if (ent && this._hass) this._hass.callService(ent.split(".")[0], "toggle", { entity_id: ent });
        return;
      }
      if (act === "range") {
        ev.stopPropagation();
        this._range = node.getAttribute("data-val");
        this._view = null;
        this._syncSegs();
        this._refreshChart();
        return;
      }
      if (act === "tab") {
        ev.stopPropagation();
        this._sel = node.getAttribute("data-val");
        this._syncSegs();
        this._refreshChart();
        return;
      }
      const more = node.getAttribute("data-more");
      if (more) {
        ev.stopPropagation();
        this._moreInfo(more);
        return;
      }
    }
  }

  _onSelect(ev) {
    const el = ev.target;
    const ent = el && el.getAttribute && el.getAttribute("data-ent");
    if (!ent || !this._hass) return;
    ev.stopPropagation();
    this._hass.callService("select", "select_option", { entity_id: ent, option: el.value });
  }

  // --- build ---------------------------------------------------------------

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._built) {
      this._build();
      this._refreshChart();
    }
    this._patch();
  }

  /**
   * Seconds left until the firmware declares the grid safe again, or null when
   * nothing is counting: the grid is fine, or down and still out of range.
   *
   * The count starts at grid_in_range's last_changed, which is only exact if
   * HA was connected when it flipped -- an HA restart mid-countdown resets it,
   * and the timer then over-reads by up to that much. It clamps at 0 for the
   * second or two between the firmware's release and HA hearing about it, and
   * at grid_return_s when the browser's clock runs behind HA's and the flip
   * looks like it happened in the future.
   */
  _returnLeft() {
    const c = this._config;
    const safe = this._stateObj(c.grid_safe);
    const rng = this._stateObj(c.grid_in_range);
    if (!safe || !rng || safe.state !== "on" || rng.state !== "on") return null;
    const t = Date.parse(rng.last_changed || "");
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.min(c.grid_return_s, c.grid_return_s - (Date.now() - t) / 1000));
  }

  /**
   * One of AC charge's switch dots: lit while its switch is on, and a tooltip
   * from the entity's friendly_name, the same words a chip's title uses, then
   * `more` (a plan's reason) and HELP[key]. Returns the state.
   */
  _patchSwitchDot(dot, ent, label, key, more) {
    const st = this._state(ent);
    if (!dot) return st;
    dot.classList.toggle("on", st === "on");
    const o = this._stateObj(ent);
    dot.dataset.tip = tip(((o && o.attributes && o.attributes.friendly_name) || label) + " — " + st
      + (more || ""), key);
    return st;
  }

  /**
   * The Pre-charge dot, and the sub-label and tooltip from its plan sensor.
   * The sub-label is empty (and hidden) while the switch is off or there is
   * nothing to charge for, which is most of the time.
   */
  _patchPlan(node, sub) {
    const plan = this._stateObj(this._config.precharge_plan);
    const a = (plan && plan.attributes) || {};
    const st = this._patchSwitchDot(node, this._config.chip_precharge, "Pre-charge", "chip_precharge",
      plan && a.reason ? " · " + plan.state + ": " + a.reason : "");
    const t = Date.parse(a.until || "");
    const at = Number.isFinite(t)
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
    let text = "";
    if (st === "on" && plan) {
      if (plan.state === "charging") text = this._chargeText(a.current, at);
      else if (plan.state === "waiting_night") text = at ? "at night → " + at : "at night";
      else if (plan.state === "full") text = "full";
    }
    if (sub) {
      sub.textContent = text;
      sub.dataset.tip = tip("Pre-charge plan — " + (text || (plan ? plan.state : "unknown")), "precharge_plan");
    }
    if (node) node.classList.toggle("act", st === "on" && !!plan && plan.state === "charging");
  }

  /**
   * "<A> A → HH:MM" for a charging plan, shared by Pre-charge and adaptive.
   * Either half can be missing for a tick while the template sensor settles
   * (or after a hand edit of its attributes), and then that half is left out
   * rather than printed as "undefined A" or a bare arrow.
   */
  _chargeText(current, at) {
    const n = current === null || current === undefined || current === "" ? NaN : Number(current);
    const amps = Number.isFinite(n) ? n + " A" : "";
    if (amps && at) return amps + " → " + at;
    if (amps) return amps;
    return at ? "charging → " + at : "charging";
  }

  /**
   * The AC charge chip's adaptive dot and its sub-label. The dot is the
   * input_boolean; it dims when there is no night charge to size: neither
   * Auto nor Night only is on, or the AC charger is off under Auto. Under
   * Night only the firmware owns the charger (it is off all day by design),
   * so it does not count. It also dims while a DTEK outage window is pending:
   * the night is pre-charge's then, and adaptive was switched off for it.
   * Same rule as adaptive_charge.yaml's guard.
   */
  _patchAdaptive(dot, sub) {
    const c = this._config;
    const st = this._state(c.adaptive_charge);
    const outage = ["waiting_night", "charging", "full"].includes(this._state(c.precharge_plan));
    const charges = this._state(c.chip_night_only) === "on"
      || (this._state(c.chip_auto) === "on" && this._state(c.chip_ac_charge) === "on");
    const usable = charges && !outage;
    const plan = this._stateObj(c.adaptive_plan);
    const a = (plan && plan.attributes) || {};
    const t = Date.parse(a.until || "");
    const at = Number.isFinite(t)
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
    let text = "";
    if (st === "on" && plan) {
      if (plan.state === "charging") text = this._chargeText(a.current, at);
      else if (plan.state === "full") text = "full";
      else if (plan.state === "day") text = "tonight";
    }
    if (dot) {
      dot.classList.toggle("on", st === "on");
      dot.classList.toggle("act", st === "on" && !!plan && plan.state === "charging");
      dot.classList.toggle("dis", !usable && st !== "on");
      dot.dataset.tip = tip(!usable && st !== "on"
        ? (outage ? "Adaptive night charge — off while an outage is scheduled (pre-charge)"
          : "Adaptive night charge — needs Auto or Night only, and the AC charger on")
        : "Adaptive night charge — " + st + (plan && a.reason ? " · " + plan.state + ": " + a.reason : ""),
      "adaptive_charge");
    }
    if (sub) {
      sub.textContent = text;
      sub.dataset.tip = tip("Adaptive charge plan — " + (text || (plan ? plan.state : "unknown")), "adaptive_plan");
    }
  }

  /** The header pill: grid word, dot colour and the return countdown. */
  _patchGrid() {
    const c = this._config;
    const el = this._el;
    const left = this._returnLeft();
    const down = this._gridDown();
    const word = left !== null ? "Grid returning" : down ? "Grid down" : "Grid connected";
    if (el.mode) el.mode.textContent = word + " · " + this._state(c.ac_input_mode);
    if (el.livedot) el.livedot.style.background = left !== null ? WARN : down ? BAD : OK;
    let count = "";
    if (el.ret) {
      el.ret.hidden = el.retsep.hidden = left === null;
      if (left !== null) {
        const s = Math.ceil(left);
        count = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
        el.ret.textContent = count;
      }
      el.ret.dataset.tip = tip("Grid return — " + (count ? count + " left" : "not counting"), "ret");
    }
    if (el.pill) {
      el.pill.dataset.tip = tip("Grid — " + (left !== null ? "returning" + (count ? ", " + count + " left" : "")
        : down ? "down" : "connected") + " · " + this._state(c.ac_input_mode), "pill");
    }
  }

  _tick() {
    if (!this._built) return;
    const el = this._el;
    if (el.clock) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      el.clock.textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    // The return countdown moves without a state change too.
    if (this._returnLeft() !== null || (el.ret && !el.ret.hidden)) this._patchGrid();

    /*
     * The recorder backstop. _ingest carries the chart between polls, so this
     * only has to heal what the browser missed while nothing was telling it.
     *
     * Staleness is read off the cached window's own timestamp rather than
     * counted in ticks, which is what the previous `_ticks % 60` got wrong
     * twice over: a background tab throttles setInterval to one firing a
     * minute, so sixty firings was an hour and not a minute; and the interval
     * starts in connectedCallback while the first fetch happens later in
     * _build, so firing sixty came in a few milliseconds under the 60s TTL and
     * the refetch it asked for fell through to firing 120.
     *
     * _stale() is false for all but one second in sixty, and _inflight keeps a
     * slow reply from being asked for again on the next tick, so this costs a
     * Map lookup a second and a fetch only when there is one to do.
     */
    if (el.chLine && !this._inflight.size && this._stale()) this._refreshChart();
  }

  _build() {
    const c = this._config;
    const has = (b) => c.blocks.indexOf(b) >= 0;
    const parts = [];

    if (has("header")) {
      parts.push(`
      <div class="head">
        <div class="head-l">
          <div class="kicker">
            <span>${this._esc(c.device_label)}</span>
            <span class="kdot"></span>
            <span class="up" data-more="${c.uptime}" role="button" tabindex="0" data-ref="uptime"></span>
          </div>
          <div class="title">${this._esc(c.title)}</div>
        </div>
        <div class="pill" data-ref="pill" data-more="${c.grid_safe}" role="button" tabindex="0">
          <div class="livedot" data-ref="livedot"></div>
          <span class="mono" data-ref="mode"></span>
          <span class="vsep" data-ref="retsep" hidden></span>
          <span class="mono ret" data-ref="ret" hidden></span>
          <span class="vsep"></span>
          <span class="mono" data-ref="clock"></span>
        </div>
      </div>`);

      parts.push(`
      <div class="bar">
        <div class="chips">${CHIPS.map((ch, i) => `
          <div class="chip${ch.dots ? " nodot" : ""}" data-ref="chip${i}"
               style="--cc:${ch.color};--cb:${ch.color}4D;--cf:${ch.color}14;--cs:${ch.color}99">
            <span class="ic" data-act="toggle" data-ent="${c[ch.cfg]}" role="button" tabindex="0"
                  aria-label="Toggle ${this._esc(ch.label)}"><ha-icon icon="${ch.icon}"></ha-icon></span>
            <span class="lbl" data-more="${c[ch.cfg]}" role="button" tabindex="0">${this._esc(ch.label)}</span>
${ch.dots ? "" : `
            <span class="dw" data-act="toggle" data-ent="${c[ch.cfg]}" role="button" tabindex="0"
                  aria-label="Toggle ${this._esc(ch.label)}"><span class="dot"></span></span>`}${
              ch.dots ? AC_DOTS.map((d) => `
            <span class="dw i" data-ref="chip${d.ref}${i}" data-act="toggle" data-ent="${c[d.cfg]}" role="button" tabindex="0"
                  style="--dc:${d.color};--ds:${d.color}99" aria-label="Toggle ${this._esc(d.label)}"><ha-icon icon="${d.icon}"></ha-icon></span>`).join("") + `
            <span class="sub" data-ref="chipAdSub${i}" data-more="${c.adaptive_plan}" role="button" tabindex="0"></span>
            <span class="sub" data-ref="chipPcSub${i}" data-more="${c.precharge_plan}" role="button" tabindex="0"></span>` : ""}
          </div>`).join("")}
        </div>
      </div>`);
    }

    const flowPanel = !has("flow") ? "" : `
      <div class="panel flow">
        <div class="plabel">Live power flow</div>

        <div class="flowrow">
          <div class="tile t-grid" data-ref="gridTile" data-more="${c.grid_voltage}" role="button" tabindex="0">
            <div class="t-head">
              <span class="t-name">Grid</span>
              <span class="t-state" data-ref="gridState"></span>
            </div>
            <div class="t-val" data-ref="gridVal"></div>
            <div class="t-sub" data-ref="gridSub"></div>
            <div class="gauge volt"><div class="mark" data-ref="gridMark"></div></div>
            <div class="ticks">
              <span style="left:14.29%">200</span><span style="left:42.86%">220</span>
              <span style="left:71.43%">240</span><span style="left:85.71%">250</span>
            </div>
          </div>

          <div class="run x" data-ref="gridRun" style="--c:${GRID_C}" data-more="${c.grid_power}" role="button" tabindex="0"
               ><i data-ref="runGrid"></i></div>

          <div class="tile t-inv" data-ref="invTile" data-more="${c.ac_output_voltage}" role="button" tabindex="0">
            <div class="t-head">
              <span class="t-name">Inverter</span>
              <span class="t-state" data-ref="invState"></span>
            </div>
            <div class="t-val" data-ref="invVal"></div>
            <div class="t-sub" data-ref="invSub"></div>
            <div class="gauge volt"><div class="mark" data-ref="invMark"></div></div>
            <div class="ticks">
              <span style="left:14.29%">200</span><span style="left:42.86%">220</span>
              <span style="left:71.43%">240</span><span style="left:85.71%">250</span>
            </div>
          </div>

          <div class="run x" data-ref="loadRun" style="--c:${LOAD_C}" data-more="${c.load_power}" role="button" tabindex="0"
               ><i data-ref="runLoad"></i></div>

          <div class="tile t-load" data-ref="loadTile" data-more="${c.load_power}" role="button" tabindex="0">
            <div class="t-head">
              <span class="t-name">House load</span>
              <span class="t-state" data-ref="loadState"></span>
            </div>
            <div class="t-val" data-ref="loadVal"></div>
            <div class="t-sub" data-ref="loadSub"></div>
            <div class="gauge load"><div class="mark" data-ref="loadMark"></div></div>
            <div class="ticks">
              <span class="l0">0</span><span style="left:60%">1440</span><span class="r0">2400</span>
            </div>
          </div>
        </div>

        <div class="battrun">
          <div class="run y direct" data-ref="dirRun" style="--c:${GRID_C}" data-more="${c.meter_power}" role="button" tabindex="0"
               ><i data-ref="runDir"></i></div>
          <div class="run y" data-ref="battRun" style="--c:${BATT_C}" data-more="${c.battery_power}" role="button" tabindex="0"
               ><i data-ref="runBatt"></i></div>
        </div>

        <div class="battwrap">
          <div class="tile t-dir direct" data-ref="dirTile" data-more="${c.meter_power}" role="button" tabindex="0">
            <div class="t-head">
              <span class="t-name">Meter</span>
              <span class="t-state" data-ref="dirState"></span>
            </div>
            <div class="t-val" data-ref="dirVal"></div>
            <div class="t-sub" data-ref="dirSub"></div>
            <div class="gauge load"><div class="mark" data-ref="dirMark"></div></div>
            <div class="ticks">
              <span class="l0">0</span><span style="left:60%">${Math.round(c.max_meter_w * 0.6)}</span><span class="r0">${c.max_meter_w}</span>
            </div>
          </div>
          <div class="tile t-batt" data-ref="battTile" data-more="${c.battery_soc}" role="button" tabindex="0">
            <div class="t-head">
              <span class="t-name">Battery</span>
              <span class="t-state" data-ref="battState"></span>
            </div>
            <div class="t-row">
              <div class="t-val" data-ref="socVal"></div>
              <div class="t-sub" data-ref="battSub" data-more="${c.battery_voltage}"
                   role="button" tabindex="0"></div>
            </div>
            <div class="gauge soc"><div class="socfill" data-ref="socFill"></div></div>
            <div class="ticks">
              <span class="l0">0</span><span style="left:${SOC_RED}%">${SOC_RED}</span>
              <span style="left:${SOC_GREEN}%">${SOC_GREEN}</span><span class="r0">100</span>
            </div>
          </div>
        </div>
      </div>`;

    const ctlPanel = !has("controls") ? "" : `
      <div class="panel ctl">
        <div class="plabel">Controls</div>
        ${[["Max AC charge current", c.max_charge_current, "maxChg"],
           ["Power priority", c.power_priority, "prio"],
           ["AC input mode", c.ac_input_mode, "acMode"]].map(([label, ent, ref]) => `
        <div class="field" data-ref="${ref}Field">
          <span class="flabel" data-more="${ent}" role="button" tabindex="0">${label}</span>
          <div class="selwrap">
            <select data-ent="${ent}" data-ref="${ref}" aria-label="${label}"></select>
            <span class="caret">▼</span>
          </div>
        </div>`).join("")}
        <div class="erows">${ENERGY.map((e, i) => `
          <div class="erow" data-ref="erow${i}" data-more="${c[e.cfg]}" role="button" tabindex="0">
            <span class="el">
              <span class="en">${e.short}</span>
              <span class="tag" data-ref="etag${i}"></span>
            </span>
            <span class="ev" data-ref="eval${i}"></span>
          </div>`).join("")}
        </div>
      </div>`;

    if (flowPanel || ctlPanel) {
      parts.push(`<div class="cols">${flowPanel}${ctlPanel}</div>`);
    }

    if (has("history")) {
      const gy = [0, 1, 2, 3, 4].map((i) =>
        `<line x1="0" x2="${CH_W}" y1="${(CH_PAD + i * (CH_H - CH_PAD * 2) / 4).toFixed(0)}"
               y2="${(CH_PAD + i * (CH_H - CH_PAD * 2) / 4).toFixed(0)}"
               stroke="#191B21" stroke-width="1" vector-effect="non-scaling-stroke"></line>`).join("");
      parts.push(`
      <div class="panel hist">
        <div class="hhead">
          <div>
            <div class="plabel">History</div>
            <div class="hname">
              <span class="n" data-ref="chName" role="button" tabindex="0"></span>
              <span class="w" data-ref="chWin" data-tip="${this._esc(tip("Window", "ch_win"))}"></span>
            </div>
          </div>
          <div class="segs" data-ref="ranges">${Object.keys(RANGES).map((r) => `
            <button class="seg" data-act="range" data-val="${r}" aria-pressed="false"
                    data-tip="${this._esc(tip(RANGES[r].label.charAt(0).toUpperCase() + RANGES[r].label.slice(1), "range"))}">${r}</button>`).join("")}
          </div>
        </div>
        <div class="tabs" data-ref="tabs">${SERIES.map((s) => `
            <button class="tab" data-act="tab" data-val="${s.key}" aria-pressed="false"
                    style="--tc:${s.color}" data-tip="${this._esc(tip(s.name, "tab"))}">${s.short}</button>`).join("")}
        </div>
        <div class="chart">
          <div class="yax" data-ref="yax"></div>
          <div class="plot" data-ref="plot">
            <svg class="ch" data-ref="chSvg" viewBox="0 0 ${CH_W} ${CH_H}" preserveAspectRatio="none">
              <defs><clipPath id="plotclip">
                <rect x="0" y="0" width="${CH_W}" height="${CH_H}"></rect>
              </clipPath></defs>
              ${gy}
              <g clip-path="url(#plotclip)">
                <path data-ref="chArea" stroke="none" fill-opacity="0.08"></path>
                <path data-ref="chLine" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"
                      stroke-linejoin="round" stroke-linecap="round"></path>
              </g>
            </svg>
            <div class="hv hvline" data-ref="hvLine"></div>
            <div class="hv hvdot" data-ref="hvDot"></div>
            <div class="tip" data-ref="tip"></div>
            <div class="note" data-ref="chNote"></div>
            <div class="xax" data-ref="xax"></div>
          </div>
        </div>
        <div class="stats" data-ref="stats"></div>
      </div>`);
    }

    parts.push(`<div class="foot">Tap any tile, chip label or row to open its entity dialog.${
      has("history") ? " Drag the chart to move through time, pinch or scroll to zoom;"
        + " double-click or pick a range to go back to live." : ""}</div>`);

    this.shadowRoot.innerHTML = "<style>" + STYLE + "</style>"
      + '<ha-card><div class="root">' + parts.join("") + "</div></ha-card>";

    this._el = {};
    this.shadowRoot.querySelectorAll("[data-ref]").forEach((n) => {
      this._el[n.getAttribute("data-ref")] = n;
    });

    const root = this.shadowRoot.querySelector(".root");
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.getAttribute
          && (e.target.getAttribute("data-more") || e.target.getAttribute("data-act"))) {
        e.preventDefault();
        this._onClick(e);
      }
    });
    const plot = this._el.plot;
    if (plot) {
      // Pointer events, so one set of handlers covers mouse, pen and touch --
      // and so a drag that leaves the plot is still ours, via capture.
      plot.addEventListener("pointerdown", (e) => this._onPointerDown(e));
      plot.addEventListener("pointermove", (e) => this._onPointerMove(e));
      ["pointerup", "pointercancel"].forEach((n) =>
        plot.addEventListener(n, (e) => this._onPointerUp(e)));
      // passive:false, or preventDefault cannot stop the page scrolling under
      // a zoom. Trackpad pinch arrives here too, as ctrl+wheel.
      plot.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
      plot.addEventListener("dblclick", () => this._resetView());
    }
    const svg = this._el.chSvg;
    if (svg) {
      svg.addEventListener("mousemove", (e) => this._onHover(e));
      // Three ways for the pointer to go away, because a touch never sends
      // mouseleave -- and a hover flag left stuck on would stop the live
      // redraws on every phone.
      ["mouseleave", "pointerleave", "pointercancel"].forEach((n) =>
        svg.addEventListener(n, () => this._leave()));
    }
    this.shadowRoot.querySelectorAll("select").forEach((s) => {
      s.addEventListener("change", (e) => this._onSelect(e));
      // A select must not also open the dialog behind its own dropdown.
      s.addEventListener("click", (e) => e.stopPropagation());
    });
    this._syncSegs();
    // _tick guards on this flag, so it is set here rather than by the caller:
    // the clock and the recorder poll start the moment there is a DOM to
    // write into, not a second later.
    this._built = true;
    this._tick();
  }

  _esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Segment / tab pressed state -- local UI state, not entity state. */
  _syncSegs() {
    const el = this._el;
    if (el.ranges) {
      // A zoomed viewport is not any of the presets, and lighting one up would
      // say it is. Nothing is pressed until the view goes back to live.
      const on = this._view === null;
      el.ranges.querySelectorAll(".seg").forEach((b) => {
        b.setAttribute("aria-pressed", String(on && b.getAttribute("data-val") === this._range));
      });
    }
    if (el.tabs) {
      el.tabs.querySelectorAll(".tab").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-val") === this._sel));
      });
    }
  }

  // --- patch ---------------------------------------------------------------

  /**
   * Everything that can change what is drawn, in one string.
   *
   * `set hass` fires on every state change across the machine (~331 entities
   * here). Without this guard an unrelated temperature sensor would rewrite
   * every node on the card.
   *
   * The flow runs are deliberately NOT behind it -- they are three property
   * writes and they are what the card is for.
   */
  _fingerprint() {
    const c = this._config;
    const ids = [
      c.grid_voltage, c.grid_frequency, c.grid_power, c.grid_safe, c.grid_in_range,
      c.ac_output_voltage, c.load_power, c.load_percentage, c.uptime,
      c.battery_power, c.battery_soc, c.battery_voltage,
      c.charge_current, c.discharge_current,
      c.meter_power, c.meter_day, c.meter_night, c.meter_total,
      c.max_charge_current, c.power_priority, c.ac_input_mode, c.meter_tariff,
    ].concat(CHIPS.map((ch) => c[ch.cfg]), [c.chip_night_only, c.chip_precharge]);
    const prices = ENERGY.filter((e) => e.priced).map((e) => this._price(c[e.cfg]));
    const plan = (this._stateObj(c.precharge_plan) || {}).attributes || {};
    const ad = (this._stateObj(c.adaptive_plan) || {}).attributes || {};
    return ids.map((id) => this._state(id)).join("|")
      + "|" + this._state(c.precharge_plan) + "|" + plan.current + "|" + plan.until + "|" + plan.reason
      + "|" + this._state(c.adaptive_charge) + "|" + this._state(c.adaptive_plan)
      + "|" + ad.current + "|" + ad.until + "|" + ad.reason
      + "|" + prices.join(",")
      + "|" + this._range + "|" + this._sel;
  }

  _patch() {
    const c = this._config;
    const el = this._el;

    // --- the flow runs, every time -----------------------------------------
    const gridW = this._num(c.grid_power);
    const loadW = this._num(c.load_power);
    const battW = this._num(c.battery_power);
    this._setFlow(el.runGrid, gridW, c.max_grid_w, false);
    this._setFlow(el.runLoad, loadW, c.max_load_w, false);
    this._setFlow(el.runBatt, battW, c.max_batt_w, true);
    this._setFlow(el.runDir, this._num(c.meter_power), c.max_meter_w, false);

    const print = this._fingerprint();
    if (print === this._print) return;
    const first = this._print === null;
    this._print = print;

    const down = this._gridDown();

    // --- header ------------------------------------------------------------
    if (el.uptime) {
      el.uptime.textContent = this._uptime();
      el.uptime.dataset.tip = tip("Uptime — " + this._uptime(), "uptime");
    }
    this._patchGrid();

    // --- flow runs: the speed is set above on every call, the words here ---
    const w = (v) => this._fmt(v, 0) + " W";
    if (el.gridRun) el.gridRun.dataset.tip = tip("Grid power — " + w(gridW), "run_grid");
    if (el.loadRun) el.loadRun.dataset.tip = tip("Load power — " + w(loadW), "run_load");
    if (el.battRun) {
      el.battRun.dataset.tip = tip("Battery power — " + (battW === null ? "— W"
        : battW > 2 ? w(battW) + " in" : battW < -2 ? w(-battW) + " out" : "idle"), "run_batt");
    }
    if (el.dirRun) el.dirRun.dataset.tip = tip("Metered power — " + w(this._num(c.meter_power)), "run_meter");

    const acCharging = !down && battW !== null && battW > 2;
    CHIPS.forEach((ch, i) => {
      const node = el["chip" + i];
      if (!node) return;
      const st = this._state(c[ch.cfg]);
      node.classList.toggle("on", st === "on");
      node.classList.toggle("live", !!ch.live && acCharging);
      node.dataset.tip = tip((this._stateObj(c[ch.cfg]) || {}).attributes
        ? ((this._stateObj(c[ch.cfg]).attributes.friendly_name || ch.label) + " — " + st)
        : ch.label, ch.cfg);
      if (ch.dots) {
        const nt = this._patchSwitchDot(el["chipNt" + i], c.chip_night_only, "Night only", "chip_night_only");
        if (el["chipNt" + i]) el["chipNt" + i].classList.toggle("act", nt === "on" && acCharging);
        this._patchAdaptive(el["chipAd" + i], el["chipAdSub" + i]);
        this._patchPlan(el["chipPc" + i], el["chipPcSub" + i]);
      }
    });

    // --- grid tile ---------------------------------------------------------
    const gv = this._num(c.grid_voltage);
    if (el.gridVal) {
      const col = down ? BAD : this._vColor(gv);
      el.gridVal.innerHTML = this._fmt(gv, 1) + '<i>V</i>';
      el.gridVal.style.color = col;
      el.gridState.textContent = down ? "NO GRID" : this._vLabel(gv);
      el.gridState.style.color = col;
      el.gridSub.textContent = this._fmt(this._num(c.grid_frequency), 2) + " Hz · "
        + this._fmt(gridW, 0) + " W in";
      el.gridMark.style.left = this._pct(gv, V_LO, V_SPAN).toFixed(2) + "%";
      if (el.gridTile) el.gridTile.dataset.tip = tip("Grid — " + this._fmt(gv, 1) + " V · " + el.gridState.textContent, "tile_grid");
      el.gridState.dataset.tip = tip("Grid status — " + el.gridState.textContent, "volt_state");
    }
    if (el.dirTile) {
      const has = !!this._stateObj(c.meter_power);
      el.dirTile.hidden = !has;
      if (el.dirRun) el.dirRun.hidden = !has;
      const mw = this._num(c.meter_power);
      const pct = mw === null ? null : mw / c.max_meter_w * 100;
      const col = mw === null ? "#5C616B" : this._loadColor(pct);
      el.dirVal.innerHTML = this._fmt(mw, 0) + "<i>W</i>";
      el.dirVal.style.color = col;
      el.dirState.textContent = this._loadLabel(pct);
      el.dirState.style.color = col;
      el.dirSub.textContent = pct === null ? "— % of the " + c.max_meter_w + " W breaker"
        : pct.toFixed(1) + " % of the " + c.max_meter_w + " W breaker";
      el.dirMark.style.left = (pct === null ? 0 : Math.max(0, Math.min(100, pct))).toFixed(2) + "%";
      el.dirTile.dataset.tip = tip("Meter — " + this._fmt(mw, 0) + " W · " + el.dirState.textContent, "tile_meter");
      el.dirState.dataset.tip = tip("Meter status — " + el.dirState.textContent, "load_state");
    }

    // --- inverter tile -----------------------------------------------------
    const av = this._num(c.ac_output_voltage);
    if (el.invVal) {
      el.invVal.innerHTML = this._fmt(av, 1) + '<i>V out</i>';
      el.invVal.style.color = this._vColor(av);
      el.invState.textContent = this._vLabel(av);
      el.invState.style.color = this._vColor(av);
      el.invSub.textContent = this._state(c.ac_input_mode) + " · " + this._state(c.power_priority);
      el.invMark.style.left = this._pct(av, V_LO, V_SPAN).toFixed(2) + "%";
      if (el.invTile) el.invTile.dataset.tip = tip("Inverter — " + this._fmt(av, 1) + " V out · " + el.invState.textContent, "tile_inv");
      el.invState.dataset.tip = tip("Output status — " + el.invState.textContent, "volt_state");
    }

    // --- house load tile ---------------------------------------------------
    const lp = this._num(c.load_percentage);
    if (el.loadVal) {
      el.loadVal.innerHTML = this._fmt(loadW, 0) + '<i>W</i>';
      el.loadVal.style.color = this._loadColor(lp);
      el.loadState.textContent = this._loadLabel(lp);
      el.loadState.style.color = this._loadColor(lp);
      el.loadSub.textContent = this._fmt(lp, 1) + " % of " + c.max_load_w + " W";
      el.loadMark.style.left = (lp === null ? 0 : Math.max(0, Math.min(100, lp))).toFixed(2) + "%";
      if (el.loadTile) el.loadTile.dataset.tip = tip("House load — " + this._fmt(loadW, 0) + " W · " + el.loadState.textContent, "tile_load");
      el.loadState.dataset.tip = tip("Load status — " + el.loadState.textContent, "load_state");
    }

    // --- battery tile ------------------------------------------------------
    const soc = this._num(c.battery_soc);
    if (el.socVal) {
      const col = this._socColor(soc);
      el.socVal.innerHTML = this._fmt(soc, 0) + '<i>%</i>';
      el.socVal.style.color = col;
      // Clamped: a BMS glitch past 100 % (or below 0) is still a full (empty)
      // bar, and a negative width is invalid CSS the browser would ignore.
      el.socFill.style.width = (soc === null ? 0 : Math.max(0, Math.min(100, soc))).toFixed(0) + "%";
      // The gradient is in the stylesheet; this only says what colour it is.
      el.socFill.style.setProperty("--fc", col);
      // The BMS sign is the truth; the inverter's two currents are magnitudes.
      const charging = battW !== null && battW > 2;
      const dischg = battW !== null && battW < -2;
      const amps = charging ? this._num(c.charge_current)
        : dischg ? this._num(c.discharge_current) : 0;
      el.battState.textContent =
        (charging ? "CHG · " : dischg ? "DIS · " : "IDLE · ") + this._socLabel(soc);
      el.battState.style.color = col;
      el.battSub.textContent = this._fmt(this._num(c.battery_voltage), 1) + " V · "
        + this._fmt(battW, 0) + " W "
        + (charging ? "in" : dischg ? "out" : "idle")
        + (amps ? " · " + this._fmt(amps, 1) + " A" : "");
      // Link to what the line actually shows: a current only when one is on it.
      el.battSub.setAttribute("data-more",
        amps ? (dischg ? c.discharge_current : c.charge_current) : c.battery_voltage);
      if (el.battTile) el.battTile.dataset.tip = tip("Battery — " + this._fmt(soc, 0) + " % · " + el.battState.textContent, "tile_batt");
      el.battState.dataset.tip = tip("Battery status — " + el.battState.textContent, "batt_state");
      el.battSub.dataset.tip = tip("Battery detail — " + el.battSub.textContent, "batt_sub");
    }

    // --- selects -----------------------------------------------------------
    [[c.max_charge_current, "maxChg", " A", "Max AC charge current", "sel_max_charge"],
     [c.power_priority, "prio", "", "Power priority", "sel_priority"],
     [c.ac_input_mode, "acMode", "", "AC input mode", "sel_ac_mode"]].forEach(([ent, ref, suffix, label, key]) => {
      const sel = el[ref];
      if (!sel) return;
      // On the field, so its label and the select share one tooltip.
      const st = this._state(ent);
      if (el[ref + "Field"]) {
        el[ref + "Field"].dataset.tip = tip(label + " — " + (this._opts(ent).indexOf(st) >= 0 ? st + suffix : st), key);
      }
      const opts = this._opts(ent);
      const sig = opts.join("\u0000");
      // Only rebuild the option list when it actually changes -- rebuilding it
      // while the dropdown is open would close it.
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        sel.innerHTML = opts.map((o) =>
          '<option value="' + this._esc(o) + '">' + this._esc(o + suffix) + "</option>").join("");
      }
      const cur = this._state(ent);
      sel.disabled = !opts.length;
      if (!opts.length) {
        sel.innerHTML = '<option>—</option>';
        sel.dataset.sig = "";
      } else if (sel.value !== cur) {
        sel.value = cur;
      }
    });

    // --- energy rows -------------------------------------------------------
    const tariff = this._state(c.meter_tariff);
    ENERGY.forEach((e, i) => {
      const row = el["erow" + i];
      if (!row) return;
      const active = e.tariff && e.tariff === tariff;
      row.classList.toggle("on", !!active);
      el["etag" + i].textContent = active ? "active" : "";
      const kwh = this._num(c[e.cfg]);
      const price = e.priced ? this._price(c[e.cfg]) : null;
      const cost = kwh !== null && price !== null ? kwh * price : null;
      el["eval" + i].innerHTML = this._esc(this._fmt(this._num(c[e.cfg]), e.dec) + " " + e.unit)
        + (cost !== null ? "<small>" + this._esc(cost.toFixed(2)) + " ₴</small>" : "");
      row.dataset.tip = tip(e.short + " — " + this._fmt(this._num(c[e.cfg]), e.dec) + " " + e.unit
        + (cost !== null ? " · " + cost.toFixed(2) + " ₴" : "") + (active ? " · active" : ""), e.help);
    });

    // A range or tab change is local, so redraw from cache; the state change
    // that got us here goes straight onto the drawn series.
    if (!first) {
      this._maybeRefresh();
      this._ingest();
    }
  }

  // --- history -------------------------------------------------------------

  _spec(key) {
    return SERIES.find((s) => s.key === key) || SERIES[0];
  }

  /**
   * The colour a series is drawn in: its band's colour where it has one, its
   * own identity colour where it has none.
   *
   * The band reads the SAME entity the tile does, which is the point -- a
   * chart in one green and a tile in another, drawn from one sensor, is a
   * reader's problem to resolve and there is nothing to resolve. Load is the
   * one that has to be said out loud: the House load tile bands on the
   * percentage entity while this series plots watts, so the percentage is
   * what colours it, not watts over max_load_w.
   */
  _seriesColor(spec) {
    const c = this._config;
    if (spec.band === "volt") return this._vColor(this._num(c[spec.cfg]));
    if (spec.band === "soc") return this._socColor(this._num(c[spec.cfg]));
    if (spec.band === "load") return this._loadColor(this._num(c.load_percentage));
    return spec.color;
  }

  _maybeRefresh() {
    const key = this._sel + "|" + this._range;
    if (key !== this._token) this._refreshChart();
  }

  // --- the viewport --------------------------------------------------------

  /**
   * What the x axis covers for a given window of data.
   *
   * Three cases, and the middle one is the interesting one. No view is the
   * preset, edge to edge. A FOLLOWING view keeps its span but takes its right
   * edge from the data, so zooming into the last five minutes keeps updating
   * instead of freezing the moment it is zoomed. A pinned view is a window in
   * the past and does not move at all.
   */
  _domain(rec) {
    const v = this._view;
    if (!v) return { t0: rec.start, t1: rec.end };
    if (v.follow) return { t0: rec.end - (v.end - v.start), t1: rec.end };
    return { t0: v.start, t1: v.end };
  }

  /** Smallest preset whose window covers `span`, for the live fetch. */
  _presetFor(span) {
    const keys = Object.keys(RANGES);
    for (let i = 0; i < keys.length; i++) {
      if (RANGES[keys[i]].hours * 3600000 >= span - 1000) return keys[i];
    }
    return keys[keys.length - 1];
  }

  _pinKey(spec, start, end) {
    return spec.key + "|@" + Math.round(start / 1000) + "-" + Math.round(end / 1000);
  }

  /**
   * Move the viewport, clamped to what can actually be drawn.
   *
   * The right edge cannot pass now, the span is held between a minute and the
   * longest preset, and running into either end slides the window rather than
   * squashing it -- a pan that hits `now` stops moving instead of stretching.
   * Landing on now re-arms `follow`, so dragging back to the right edge is how
   * you rejoin the live chart without reaching for the presets.
   */
  _setView(start, end) {
    const now = Date.now();
    const span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, end - start));
    let t1 = Math.min(now, end);
    let t0 = t1 - span;
    if (t0 < now - MAX_SPAN) { t0 = now - MAX_SPAN; t1 = Math.min(now, t0 + span); }
    this._view = { start: t0, end: t1, follow: t1 >= now - 1500 };
  }

  /**
   * A gesture in progress: redraw from what is already cached so the chart
   * tracks the finger, and ask the recorder only once it settles. Panning a
   * week at 60 fps would otherwise be a hundred history queries.
   */
  _applyView(start, end) {
    this._setView(start, end);
    this._syncSegs();
    this._drawCached();
    if (this._viewTimer) window.clearTimeout(this._viewTimer);
    this._viewTimer = window.setTimeout(() => {
      this._viewTimer = null;
      this._refreshChart();
    }, 220);
  }

  /** Zoom `base` by `factor` about `anchor`, which stays under the finger. */
  _zoomFrom(base, anchor, factor) {
    const span = base.t1 - base.t0;
    const next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, span / factor));
    const frac = span > 0 ? (anchor - base.t0) / span : 0.5;
    const t0 = anchor - frac * next;
    this._applyView(t0, t0 + next);
  }

  _resetView() {
    if (this._viewTimer) window.clearTimeout(this._viewTimer);
    this._viewTimer = null;
    this._view = null;
    this._syncSegs();
    this._refreshChart();
  }

  /** Time under a client x, in the domain currently drawn. */
  _timeAt(clientX, rect, base) {
    return base.t0 + (clientX - rect.left) / Math.max(1, rect.width) * (base.t1 - base.t0);
  }

  _onPointerDown(ev) {
    if (!this._dom || (ev.button !== undefined && ev.button > 0)) return;
    this._pointers.set(ev.pointerId, ev.clientX);
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* not fatal */ }
    this._beginGesture(ev.currentTarget);
  }

  /**
   * Snapshot the domain and the pointers the gesture starts from.
   *
   * Every move is then measured against THIS snapshot rather than against the
   * previous move. Accumulating deltas drifts -- each clamp at the edge of now
   * would be baked in and the window would creep away from the finger.
   */
  _beginGesture(node) {
    const xs = Array.from(this._pointers.values());
    const rect = node.getBoundingClientRect();
    this._gesture = {
      base: { t0: this._dom.t0, t1: this._dom.t1 },
      rect: rect,
      xs: xs.slice(),
      dist: xs.length > 1 ? Math.abs(xs[0] - xs[1]) : 0,
      mid: xs.length > 1 ? (xs[0] + xs[1]) / 2 : xs[0],
    };
    this._dragging = xs.length > 0;
    if (this._el.plot) this._el.plot.classList.toggle("grabbing", this._dragging);
  }

  _onPointerMove(ev) {
    if (!this._pointers.has(ev.pointerId)) return;
    this._pointers.set(ev.pointerId, ev.clientX);
    const g = this._gesture;
    if (!g) return;
    const xs = Array.from(this._pointers.values());

    if (xs.length >= 2) {
      // Pinch: fingers apart is a shorter span. Both stay over the times they
      // grabbed, which is what makes the gesture feel attached to the data.
      const dist = Math.abs(xs[0] - xs[1]);
      if (g.dist > 8 && dist > 8) {
        this._zoomFrom(g.base, this._timeAt(g.mid, g.rect, g.base), dist / g.dist);
      }
      return;
    }
    const dx = xs[0] - g.xs[0];
    if (!this._dragging && Math.abs(dx) < 3) return;
    const span = g.base.t1 - g.base.t0;
    const dt = -(dx / Math.max(1, g.rect.width)) * span;
    this._applyView(g.base.t0 + dt, g.base.t1 + dt);
  }

  _onPointerUp(ev) {
    if (!this._pointers.delete(ev.pointerId)) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
    // A pinch that loses one finger becomes a drag, from where that finger is.
    if (this._pointers.size) { this._beginGesture(ev.currentTarget); return; }
    this._gesture = null;
    this._dragging = false;
    if (this._el.plot) this._el.plot.classList.remove("grabbing");
  }

  /**
   * Wheel zooms, and takes the event: over a 260px plot the alternative is a
   * dashboard that scrolls out from under the gesture. A trackpad pinch lands
   * here as ctrl+wheel and needs no separate handling; deltaMode 1 is a mouse
   * reporting lines rather than pixels.
   */
  _onWheel(ev) {
    if (!this._dom) return;
    ev.preventDefault();
    const rect = ev.currentTarget.getBoundingClientRect();
    const base = { t0: this._dom.t0, t1: this._dom.t1 };
    const step = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 0.5 : 0.0022;
    const f = Math.max(0.25, Math.min(4, Math.exp(-ev.deltaY * step)));
    this._zoomFrom(base, this._timeAt(ev.clientX, rect, base), f);
  }

  /**
   * Draw the viewport from whatever is already in hand, for the frames between
   * a gesture and the fetch that sharpens it.
   *
   * A window with nothing in it yet leaves the previous frame standing rather
   * than blanking to "no history": panning into data that has not arrived is
   * not the same statement as the recorder having none, and a flash of the
   * wrong answer is worse than 200ms of the old one.
   */
  _drawCached() {
    const spec = this._spec(this._sel);
    const v = this._view;
    const rec = (v && !v.follow && this._hist.get(this._pinKey(spec, v.start, v.end)))
      || this._hist.get(spec.key + "|" + this._range);
    if (!rec || !rec.pts.length) return;
    const d = this._domain(rec);
    if (!this._slice(rec.pts, d.t0, d.t1).length) return;
    this._drawChart(spec, rec);
  }

  /** The samples the viewport covers, plus the one on each side of it. */
  _slice(pts, t0, t1) {
    let a = 0;
    while (a < pts.length && pts[a][0] < t0) a++;
    if (a > 0) a--;
    let b = pts.length - 1;
    while (b >= 0 && pts[b][0] > t1) b--;
    if (b < pts.length - 1) b++;
    return a <= b ? pts.slice(a, b + 1) : [];
  }

  /** How long a fetched window stays good: a minute up to 1h, five beyond. */
  _ttl(rangeKey) {
    return RANGES[rangeKey].hours <= 1 ? 60000 : 300000;
  }

  /** True when a _fetch for the drawn window would really hit the recorder. */
  _stale() {
    // A pinned window is history: it has already happened and the recorder
    // has nothing to add to it.
    if (this._view && !this._view.follow) return false;
    const hit = this._hist.get(this._drawnKey || (this._sel + "|" + this._range));
    return !hit || Date.now() - hit.at >= this._ttl(this._range);
  }

  /**
   * The live tail.
   *
   * The recorder is polled at most once a TTL, so between polls the chart held
   * whatever it last fetched: on the long windows that is five minutes of a
   * frozen line and a frozen Now/Min/Max/Mean row, sitting under tiles that
   * move every few seconds. It read as a screenshot of a live card.
   *
   * `set hass` already carries the sample the recorder is about to store, so
   * take it from there. Every cached window gets the state it has not seen
   * appended, slides its right edge to now and drops what has scrolled off the
   * left; the drawn one redraws. The poll in _tick REPLACES a window rather
   * than adding to it, so a sample counted twice here cannot survive one.
   *
   * A window that came back empty is left alone. "no history recorded" is a
   * true statement about the recorder, and one live point stretched across 24
   * hours would be a worse answer than the note.
   */
  _ingest() {
    const now = Date.now();
    // Pinned windows are keyed with an @ and are not live, so the RANGES
    // lookup below drops them: only the preset windows grow a tail.
    const drawn = this._drawnKey || (this._sel + "|" + this._range);
    let redraw = false;

    this._hist.forEach((rec, key) => {
      const bar = key.indexOf("|");
      const spec = this._spec(key.slice(0, bar));
      const rg = RANGES[key.slice(bar + 1)];
      if (!rg || !rec.pts.length) return;

      const st = this._stateObj(this._config[spec.cfg]);
      if (!st) return;
      const v = parseFloat(st.state);
      if (!Number.isFinite(v)) return;
      const t = Date.parse(st.last_updated || st.last_changed || "");
      // A stamp the window already ends on is the same row twice: an unchanged
      // state fires a state *report*, which is neither recorded nor plotted.
      if (!Number.isFinite(t) || t <= rec.pts[rec.pts.length - 1][0]) return;

      rec.pts.push([t, v]);
      rec.end = Math.max(now, t);
      rec.start = rec.end - rg.hours * 3600000;

      /*
       * Keep the last sample from before the window. history_during_period
       * opens every reply with the state as it stood at start_time and _path
       * clamps x to the frame, so this is the same left edge the next fetch
       * will draw; dropping it would walk the line's start rightwards between
       * polls on any sensor that updates slowly.
       */
      let drop = 0;
      while (drop + 1 < rec.pts.length && rec.pts[drop + 1][0] < rec.start) drop++;
      if (drop) rec.pts.splice(0, drop);

      if (key === drawn) redraw = true;
    });

    if (redraw) this._drawChart(this._spec(this._sel), this._hist.get(drawn));
  }

  /**
   * Recorder rows for one sensor over one window.
   *
   * `minimal_response` drops everything but the state and the last-updated
   * stamp; `no_attributes` keeps the reply from carrying a friendly_name per
   * row. Both matter on the 14d window, which can be tens of thousands of rows
   * before downsampling.
   */
  _fetch(spec, rangeKey) {
    const rg = RANGES[rangeKey];
    const now = Date.now();
    return this._load(spec, spec.key + "|" + rangeKey, now - rg.hours * 3600000, now,
      rg.points, this._ttl(rangeKey));
  }

  /**
   * A window the user panned to. It is over, so it cannot change: it is cached
   * until the cache is trimmed rather than on a TTL, and the poll in _tick
   * leaves it alone.
   */
  _fetchSpan(spec, start, end) {
    return this._load(spec, this._pinKey(spec, start, end), start, end, 1500, Infinity);
  }

  async _load(spec, key, start, end, cap, ttl) {
    const now = Date.now();
    const hit = this._hist.get(key);
    if (hit && now - hit.at < ttl) return hit;
    if (this._inflight.has(key)) return this._inflight.get(key);

    const entity = this._config[spec.cfg];
    const p = (async () => {
      const rec = { at: now, start: start, end: end, pts: [], note: null };
      try {
        // Raw states are kept two days (recorder purge_keep_days), so a window
        // reaching further back than that drew a sliver at its right edge
        // under a "last 14 days" label -- with min/max/mean worked out from
        // that sliver. Past the horizon the hourly long-term statistics carry
        // it instead, the same road the climate card takes. An entity with no
        // state_class has none, and falls back to what raw history exists.
        let raw = [];
        let fromStats = false;
        if (start < now - RAW_HORIZON) {
          const stats = await this._hass.callWS({
            type: "recorder/statistics_during_period",
            start_time: new Date(start).toISOString(),
            end_time: new Date(end).toISOString(),
            statistic_ids: [entity],
            period: "hour",
            types: ["mean"],
          });
          raw = this._parseStats(stats, entity);
          fromStats = raw.length > 0;
        }
        if (!fromStats) {
          const reply = await this._hass.callWS({
            type: "history/history_during_period",
            start_time: new Date(start).toISOString(),
            end_time: new Date(end).toISOString(),
            entity_ids: [entity],
            minimal_response: true,
            no_attributes: true,
            significant_changes_only: false,
          });
          raw = this._parse(reply, entity);
        }
        rec.pts = this._decimate(raw, cap);
        if (!rec.pts.length) {
          rec.note = raw.length ? "no numeric history" : "no history recorded";
        } else if (!fromStats && start < now - RAW_HORIZON
                   && rec.pts[0][0] > start + RAW_HORIZON) {
          rec.note = "only the last two days are kept for this sensor";
        }
      } catch (err) {
        rec.note = "history unavailable"
          + (err && (err.message || err.code) ? " — " + (err.message || err.code) : "");
      }
      this._hist.set(key, rec);
      this._inflight.delete(key);
      this._trimPinned();
      return rec;
    })();
    this._inflight.set(key, p);
    return p;
  }

  /**
   * Pinned windows accumulate one entry per place the user stopped panning,
   * and nothing expires them -- history does not go stale. Keep the dozen most
   * recently fetched; the preset windows are never trimmed, they are the live
   * ones and there are only as many as there are buttons.
   */
  _trimPinned() {
    const pinned = [];
    this._hist.forEach((rec, key) => {
      if (key.indexOf("|@") > 0) pinned.push([key, rec.at]);
    });
    if (pinned.length <= 12) return;
    pinned.sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < pinned.length - 12; i++) this._hist.delete(pinned[i][0]);
  }

  /**
   * Hourly means from recorder/statistics_during_period, in the [ms, value]
   * shape _parse() produces. Plotted at the start of each hour, as the History
   * panel does; `start` is epoch ms on current releases, ISO on older ones.
   */
  _parseStats(reply, entity) {
    const rows = reply && reply[entity];
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      if (!r) continue;
      const v = parseFloat(r.mean);
      if (!Number.isFinite(v)) continue;
      const t = typeof r.start === "number" ? r.start : Date.parse(r.start);
      if (Number.isFinite(t)) out.push([t, v]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  /**
   * The reply shape has moved around between HA releases, so read both: the
   * compact form is {entity_id: [{s, lu}, ...]} with `lu` in epoch SECONDS,
   * the older one carries {state, last_updated} ISO strings.
   */
  _parse(reply, entity) {
    if (!reply) return [];
    const rows = reply[entity] || reply[Object.keys(reply)[0]] || [];
    const out = [];
    for (const r of rows) {
      if (!r) continue;
      const raw = r.s !== undefined ? r.s : r.state;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) continue;
      let t = null;
      if (typeof r.lu === "number") t = r.lu * 1000;
      else if (r.last_updated) t = Date.parse(r.last_updated);
      else if (r.last_changed) t = Date.parse(r.last_changed);
      if (t) out.push([t, v]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  /**
   * The window's mean, weighted by TIME rather than by sample count.
   *
   * Two reasons, and the second one is the reason it changed.
   *
   * A Home Assistant state is a step function: it holds the value it was given
   * until the next row replaces it. Recorder rows are irregular -- a sensor
   * fires a hundred times through a noisy minute and once through a quiet hour
   * -- so averaging the ROWS lets that one noisy minute outvote the hour it
   * sat inside. Weighting by the interval each row actually held is simply the
   * correct definition of "mean over this window", and always was.
   *
   * It also has to be, now that _decimate keeps each bucket's extremes rather
   * than an even stride. Those two rows are no longer a fair sample of their
   * bucket -- they are, on purpose, its most unusual pair -- so counting them
   * equally would pull the mean toward whichever way the series happened to
   * spike. Weighting by time gives an extreme exactly the share of the window
   * it really occupied, which is usually a sliver.
   */
  _mean(pts) {
    if (!pts.length) return 0;
    if (pts.length === 1) return pts[0][1];
    let span = 0, acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dt = pts[i + 1][0] - pts[i][0];
      if (dt <= 0) continue;
      acc += pts[i][1] * dt;
      span += dt;
    }
    // Every row sharing one timestamp leaves nothing to weight; the last value
    // is the only defensible answer.
    return span > 0 ? acc / span : pts[pts.length - 1][1];
  }

  /**
   * Recorder samples, thinned to what the plot can resolve -- KEEPING EVERY
   * EXTREME.
   *
   * WHY THIS IS NOT A STRIDE, WHICH IS WHAT IT USED TO BE
   * -----------------------------------------------------
   * It took every Nth row. That is cheap, it is unbiased, and on this data it
   * lied. A 24h window of grid voltage is about 27,000 recorder rows against a
   * budget of 1,500, so a stride threw away nineteen samples in twenty -- and
   * with them the peaks. The window reported Max 240 V. Zooming into an hour
   * of it fetched the 1h window instead, dropped almost nothing, and reported
   * Max 249 V: the same nine volts had been in the database the whole time and
   * the wider view had simply not kept the row. Every zoom uncovered numbers
   * the level above had denied, which is indistinguishable from data loss and
   * was in fact exactly that.
   *
   * So the series is bucketed and each bucket contributes THE TWO ROWS THAT
   * MATTER -- its lowest and its highest -- in the order they were stored. The
   * cost is the same budget; what changes is which rows are spent on.
   *
   * The invariant this buys is the point: the minimum and maximum of a drawn
   * window are the true minimum and maximum of every row the recorder holds
   * for it. A global extreme is its own bucket's extreme, so it cannot be the
   * row that gets dropped. Zooming in can now only ever narrow the range it
   * reports, never widen it.
   *
   * Still true, and still the reason nothing is averaged into buckets: every
   * value plotted is a value the recorder actually stored, at the timestamp it
   * stored it. Whole rows are chosen, never blended. What a mean would have
   * done to a 249 V excursion sitting between two 238 V neighbours is erase
   * it, which is the bug above wearing a different hat.
   */
  _decimate(pts, cap) {
    if (pts.length <= cap) return pts;
    // Two samples leave each bucket -- its lowest and its highest -- so the
    // budget buys half as many buckets.
    const buckets = Math.max(1, Math.floor(cap / 2));
    const width = pts.length / buckets;
    const out = [];
    let taken = -1;
    const take = (i) => { if (i !== taken) { out.push(pts[i]); taken = i; } };
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor(b * width);
      const to = Math.min(pts.length, Math.floor((b + 1) * width));
      if (to <= from) continue;
      let lo = from, hi = from;
      for (let i = from + 1; i < to; i++) {
        if (pts[i][1] < pts[lo][1]) lo = i;
        if (pts[i][1] > pts[hi][1]) hi = i;
      }
      // Emitted in the order the recorder stored them, or the path would run
      // backwards in time across the bucket. take() collapses the two when a
      // flat bucket makes them the same sample.
      take(Math.min(lo, hi));
      take(Math.max(lo, hi));
    }
    // The window's own edges, so the line still begins and ends where the data
    // does rather than at the first and last bucket's extreme.
    if (out[0] !== pts[0]) out.unshift(pts[0]);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * Points are [timestamp, value], and x comes from the timestamp rather than
   * the sample index -- recorder rows are irregular, so an index-based x makes
   * a quiet hour occupy the same width as a busy one and misplaces every
   * reading against the time axis under it.
   */
  _path(pts, w, h, pad, t0, t1) {
    let min = Infinity, max = -Infinity;
    for (const q of pts) { if (q[1] < min) min = q[1]; if (q[1] > max) max = q[1]; }
    let lo = min, hi = max;

    /*
     * Robust y domain. The values stay raw -- nothing is averaged or dropped --
     * but the AXIS is not allowed to be set by a single bad sample. One 21 V
     * blip in a day of 238 V grid squeezes everything else into 8% of the plot
     * and the chart reads as a flat line.
     *
     * So when the full extent is more than 3x the 1..99 percentile band, scale
     * to that band instead and let the outlier run off the frame (the path is
     * clipped). It is still in the data: the stats row reports the true Min and
     * Max, the window label counts what went off-scale, and hovering the spike
     * gives its exact recorded value.
     */
    const sorted = pts.map((q) => q[1]).sort((a, b) => a - b);
    const at = (f) => sorted[Math.min(sorted.length - 1,
      Math.max(0, Math.round(f * (sorted.length - 1))))];
    const band = at(0.99) - at(0.01);
    if (sorted.length >= 20 && band > 0 && (max - min) > 3 * band) {
      const room = band * 0.15;
      lo = at(0.01) - room;
      hi = at(0.99) + room;
    }

    // A dead-flat series would divide by zero and draw on the frame edge.
    if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
    const span = hi - lo;
    const tspan = (t1 - t0) || 1;
    const xy = pts.map(([t, v]) => [
      Math.max(0, Math.min(w, (t - t0) / tspan * w)),
      h - pad - (v - lo) / span * (h - pad * 2),
    ]);
    const line = xy.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" ");
    // Close the area under the data it actually has, not the whole frame.
    const area = xy.length
      ? line + " L" + xy[xy.length - 1][0].toFixed(1) + " " + h
             + " L" + xy[0][0].toFixed(1) + " " + h + " Z"
      : "";
    let off = 0;
    for (const q of pts) if (q[1] < lo || q[1] > hi) off++;
    return { line, area, lo, hi, min, max, off, xy };
  }

  /**
   * Six stamps across the drawn span. The format follows the span rather than
   * the preset it came from: zoom into two minutes and HH:MM would print the
   * same label six times, so seconds appear; zoom out past a day and the clock
   * stops meaning anything, so dates do.
   */
  _timeLabels(count, t0, t1) {
    const out = [];
    const p = (n) => String(n).padStart(2, "0");
    const span = t1 - t0;
    for (let i = 0; i < count; i++) {
      const d = new Date(t0 + span * i / (count - 1));
      out.push(span > 24 * 3600000 ? p(d.getDate()) + "." + p(d.getMonth() + 1)
        : span < 5 * 60000
          ? p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
          : p(d.getHours()) + ":" + p(d.getMinutes()));
    }
    return out;
  }

  /** "8 minutes", "2.5 hours", "3 days" -- for a span with no preset name. */
  _spanWords(ms) {
    const m = ms / 60000;
    if (m < 90) return Math.max(1, Math.round(m)) + (Math.round(m) === 1 ? " minute" : " minutes");
    const h = m / 60;
    if (h < 36) {
      const v = h < 10 ? Number(h.toFixed(1)) : Math.round(h);
      return v + (v === 1 ? " hour" : " hours");
    }
    const dy = Math.round(h / 24);
    return dy + (dy === 1 ? " day" : " days");
  }

  /**
   * What the window is, in words. A preset keeps the name it was given; a
   * viewport ending at now is still "last <span>"; one panned into the past
   * has no relationship to now left to describe, so it states its two edges.
   */
  _winLabel(d) {
    if (!this._view) return RANGES[this._range].label;
    const span = d.t1 - d.t0;
    if (this._view.follow) return "last " + this._spanWords(span);
    return this._stamp(d.t0, span) + " – " + this._stamp(d.t1, span);
  }

  _refreshChart() {
    const el = this._el;
    if (!el.chLine || !this._hass) return;
    const spec = this._spec(this._sel);
    const v = this._view;

    /*
     * Where the data comes from follows what is being looked at.
     *
     * A window that ends at now is served by a preset, and the preset picked
     * is the smallest one that covers the span -- which is what makes zooming
     * in sharpen the line rather than magnify it. Ten minutes taken out of the
     * 14d window is one point per thirteen minutes and draws nothing; the same
     * ten minutes off the 30m window is every sample the recorder kept.
     *
     * A window panned into the past is fetched as itself. No preset can serve
     * it -- they all end at now -- and it needs no tail, because it is over.
     */
    let key, pending;
    if (!v || v.follow) {
      if (v) {
        this._range = this._presetFor(v.end - v.start);
        /*
         * A following window the size of its own preset IS that preset, so let
         * it go back to being one. Without this a drag that hit the edge of now
         * and moved nothing would still leave the segment dark and the window
         * labelled by its span, which says something changed when nothing did.
         */
        if (Math.abs((v.end - v.start) - RANGES[this._range].hours * 3600000) < 1500) {
          this._view = null;
        }
      }
      key = spec.key + "|" + this._range;
      pending = this._fetch(spec, this._range);
    } else {
      key = this._pinKey(spec, v.start, v.end);
      pending = this._fetchSpan(spec, v.start, v.end);
    }
    this._drawnKey = key;
    this._token = key;
    this._syncSegs();

    el.chName.textContent = spec.name;
    el.chName.dataset.tip = tip(spec.name, "ch_name");
    // Clicking the chart's title opens the entity the chart is drawing.
    el.chName.setAttribute("data-more", this._config[spec.cfg]);

    Promise.resolve(pending).then((rec) => {
      // A slower fetch for a window the user has already left must not paint.
      if (this._token !== key) return;
      this._drawChart(spec, rec);
    });
  }

  _drawChart(spec, rec) {
    const el = this._el;
    // Belt and braces for the token: no history block, nothing to draw on.
    if (!el.chLine) return;
    this._hideHover();

    /*
     * Colour is applied here and not in _refreshChart because the live tail
     * redraws through this function alone: a grid crossing 240 V between two
     * recorder polls has to take the line, the fill, the readout and the tab
     * chip with it at the moment the tile above changes word.
     */
    const col = this._seriesColor(spec);
    el.chLine.setAttribute("stroke", col);
    el.chArea.setAttribute("fill", col);
    const tab = el.tabs && el.tabs.querySelector('[data-val="' + spec.key + '"]');
    if (tab) tab.style.setProperty("--tc", col);

    /*
     * The viewport, and only the samples under it. Everything below reads from
     * this slice and not from rec.pts: a y axis scaled to a day of readings
     * flattens the ten minutes actually on screen, and Min/Max/Mean would
     * report a window the reader is not looking at.
     */
    const d = this._domain(rec);
    this._dom = d;
    const pts = this._slice(rec.pts, d.t0, d.t1);
    el.chWin.textContent = this._winLabel(d);
    el.chWin.dataset.tip = tip("Window — " + el.chWin.textContent, "ch_win");

    if (!pts.length) {
      el.chLine.setAttribute("d", "");
      el.chArea.setAttribute("d", "");
      el.yax.innerHTML = "";
      el.xax.innerHTML = "";
      el.stats.innerHTML = "";
      el.chNote.textContent = rec.note
        || (this._view ? "no readings in this window" : "no history");
      el.chNote.classList.add("show");
      this._hv = null;
      return;
    }
    el.chNote.classList.remove("show");

    const p = this._path(pts, CH_W, CH_H, CH_PAD, d.t0, d.t1);
    el.chLine.setAttribute("d", p.line);
    el.chArea.setAttribute("d", p.area);
    this._hv = { spec: spec, span: d.t1 - d.t0, pts: pts, xy: p.xy, col: col };

    const span = p.hi - p.lo;
    el.yax.innerHTML = [0, 1, 2, 3, 4]
      .map((i) => "<span>" + (p.hi - span * i / 4).toFixed(spec.dec) + "</span>").join("");
    el.xax.innerHTML = this._timeLabels(6, d.t0, d.t1)
      .map((t) => "<span>" + t + "</span>").join("");

    // Appended on every draw and not only when there is a count: the live tail
    // redraws through here alone, so a stale "3 readings off-scale" would
    // otherwise outlive the three readings it counted.
    if (p.off) {
      el.chWin.textContent += " · " + p.off
        + (p.off === 1 ? " reading" : " readings") + " off-scale";
    }
    el.chWin.dataset.tip = tip("Window — " + el.chWin.textContent, "ch_win");

    const now = this._num(this._config[spec.cfg]);
    const mean = this._mean(pts);
    el.stats.innerHTML = [
      ["Now", now === null ? pts[pts.length - 1][1] : now],
      ["Min", p.min], ["Max", p.max], ["Mean", mean],
    ].map(([label, v]) =>
      "<div class='stat' data-tip=\"" + this._esc(tip(label + " — " + v.toFixed(spec.dec) + " " + spec.unit, "stat"))
      + "\"><b>" + label + "</b><span>"
      + v.toFixed(spec.dec) + " " + spec.unit + "</span></div>").join("");

    /*
     * _hideHover above cleared a readout the cursor is still sitting on, so
     * put it back against the series just drawn.
     *
     * The alternative was to hold the redraw back until the pointer left,
     * which is the freeze this whole change is about: a cursor parked on the
     * plot -- or one a touch left there, since a tap sends no mouseleave --
     * would stop the chart for as long as it sat there. The readout follows
     * the data instead of blocking it.
     */
    if (this._hovering && !this._dragging && this._hoverX !== null) {
      this._onHover({ clientX: this._hoverX });
    }
  }

  _stamp(t, span) {
    const d = new Date(t);
    const p = (v) => String(v).padStart(2, "0");
    const hm = p(d.getHours()) + ":" + p(d.getMinutes());
    return span > 24 * 3600000
      ? p(d.getDate()) + "." + p(d.getMonth() + 1) + " " + hm
      : hm + ":" + p(d.getSeconds());
  }

  /**
   * Nearest sample to the cursor, by x. The plot is drawn with
   * preserveAspectRatio="none", so viewBox units and CSS pixels differ on the
   * x axis only -- pick the point in viewBox space, then place the readout in
   * pixel space.
   */
  _onHover(ev) {
    const el = this._el;
    const hv = this._hv;
    if (!hv || !hv.xy.length || this._dragging) return;
    const rect = el.chSvg.getBoundingClientRect();
    if (!rect.width) return;
    this._hovering = true;
    this._hoverX = ev.clientX;
    const vx = (ev.clientX - rect.left) / rect.width * CH_W;

    let best = 0, bd = Infinity;
    for (let i = 0; i < hv.xy.length; i++) {
      const d = Math.abs(hv.xy[i][0] - vx);
      if (d < bd) { bd = d; best = i; }
    }
    const x = hv.xy[best][0];
    const y = Math.max(0, Math.min(CH_H, hv.xy[best][1]));
    const px = x / CH_W * rect.width;
    const py = y / CH_H * rect.height;

    el.hvLine.style.left = px + "px";
    el.hvLine.classList.add("on");
    el.hvDot.style.left = px + "px";
    el.hvDot.style.top = py + "px";
    el.hvDot.style.background = hv.col;
    el.hvDot.classList.add("on");

    el.tip.innerHTML = "<b>" + this._esc(hv.pts[best][1].toFixed(hv.spec.dec) + " " + hv.spec.unit)
      + "</b><i>" + this._esc(this._stamp(hv.pts[best][0], hv.span)) + "</i>";
    el.tip.style.color = hv.col;
    // Keep the bubble inside the plot at both edges.
    el.tip.style.left = Math.max(52, Math.min(rect.width - 52, px)) + "px";
    el.tip.style.top = Math.max(34, py - 12) + "px";
    el.tip.classList.add("on");
  }

  /** The pointer left the plot, so the readout stops being put back. */
  _leave() {
    this._hovering = false;
    this._hoverX = null;
    this._hideHover();
  }

  _hideHover() {
    const el = this._el;
    if (!el.tip) return;
    el.tip.classList.remove("on");
    el.hvLine.classList.remove("on");
    el.hvDot.classList.remove("on");
  }
}

installFonts();

if (!customElements.get(CARD)) customElements.define(CARD, PowmrInverterConsoleCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "PowMr Inverter Console",
    description: "Live power flow, inverter controls and history for the PowMr hybrid inverter.",
    preview: false,
    documentationURL: "https://github.com/",
  });
}

console.info("%c " + CARD + " %c v" + VERSION + " ",
  "background:#0E1014;color:#AE8446;border-radius:3px 0 0 3px",
  "background:#AE8446;color:#0E1014;border-radius:0 3px 3px 0");
