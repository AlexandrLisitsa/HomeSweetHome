/**
 * JK BMS Battery Console card.
 *
 * Draws the whole Battery tab of the Power station dashboard: the pack-state
 * meters, the live DC flow between the inverter and the pack, the per-cell
 * balance chart, timing and temperatures, and a history chart. Registered as a
 * Lovelace resource, so it is handed `hass` directly -- no token, no iframe,
 * no CORS.
 *
 * THIS IS THE BATTERY HALF OF powmr-inverter-console-card.js
 * ----------------------------------------------------------
 * Same shape, same reasons, and that file is the one to read first: why a flow
 * diagram needs a custom element rather than a stack of tiles (card-mod,
 * button-card and power-flow-card-plus are not installed and HA's markdown
 * filter drops `style`), why the DOM is built once and then patched, and why
 * the history chart is kept live by `set hass` rather than by polling. Every
 * one of those arguments applies here unchanged and is not repeated.
 *
 * WHAT IS DIFFERENT IS THE PALETTE AND THE TYPE
 * ---------------------------------------------
 * The Inverter tab is drawn on neutral graphite in Space Grotesk. This tab has
 * its own design -- a green-tinted dark ground in IBM Plex Sans, with IBM Plex
 * Mono on every number -- and the two are deliberately not merged. The tab bar
 * is the boundary: Inverter is the AC side, Battery is the DC side, and the
 * ground colour says which one you are looking at before you have read a word.
 *
 * The three semantic colours are the design's own and they are literal, for
 * the same reason they are literal in the inverter card: every track gradient
 * below hardcodes these three stops, so a themed number would sit above a band
 * painted in a different green. One palette, used by both.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * The JK BMS, over the ESPHome gateway (PowerStation/power-station.yaml), for
 * everything pack-side: SOC, pack voltage and current, remaining capacity, the
 * eight cell voltages and the two bank temperatures. The inverter contributes
 * only what the BMS cannot see -- its own idea of battery voltage, its charge
 * and discharge currents, and the power priority the charge is running under.
 *
 * sensor.jkbms_gateway_bms_power is SIGNED (+ charging, - discharging), so
 * every direction on this card is read off that one number rather than
 * inferred from the inverter's two unsigned currents.
 *
 * THREE PLACES THIS CARD REFUSES TO COPY ITS OWN DESIGN
 *
 *   1. The design's TEMPERATURES panel has a third row, MOSFET. This BMS
 *      reports two probes, both in the pack, and there is no MOSFET sensor to
 *      read. Two rows are drawn. Inventing the third would be inventing the
 *      reading.
 *   2. The design's CURRENT FLOW meter fills from the left over 0..70 A. Pack
 *      current here is signed and runs to +-200 A, and a left-anchored fill
 *      draws a 100 A charge and a 100 A discharge identically. The fill is
 *      anchored at the centre instead: right of the middle is charge, left is
 *      discharge, and the track's coloured bands are mirrored about zero.
 *   3. The design's meter ticks are laid out by `justify-content:
 *      space-between`, which puts "0 20 50 100" at 0/33/66/100% of a bar whose
 *      bands are at 0/20/50/100%. Every tick here is positioned at the value
 *      it names, so a mark sitting in the amber band always has the amber
 *      band's numbers either side of it.
 *
 * CELL DELTA IS PLOTTED IN MILLIVOLTS AND THE SENSOR IS IN VOLTS
 * --------------------------------------------------------------
 * sensor.jkbms_gateway_bms_delta_cell_voltage reports 0.005 V. Three decimals
 * of a volt is a chart of a flat line at zero, and the number that matters --
 * is the pack drifting apart -- lives in the third and fourth decimal. So the
 * delta series carries `mul: 1000` and is drawn, hovered and summarised in mV.
 * The scaling is applied once, where recorder rows are parsed and where the
 * live tail is appended, so nothing downstream has to know about it. The BAND
 * functions still take raw volts -- thresholds are stated in the sensor's own
 * unit, not the chart's.
 *
 * TWO THINGS THAT WILL WASTE YOUR AFTERNOON
 *
 *   1. Bump VERSION below on EVERY edit to this file, then re-register it.
 *      The browser caches an ES module hard and you will be debugging the new
 *      card while looking at the old one. The resource URL's ?v= IS the
 *      VERSION -- MAJOR.MINOR.PATCH, see "Versions" in the top-level README --
 *      and --card reads it from this file rather than trusting a typed one:
 *
 *        python HomeAssistant/tools/ha_dashboard.py --card jkbms-battery-console-card.js
 *
 *   2. Do NOT re-render this card by replacing innerHTML. `set hass` fires on
 *      every state change across all ~331 entities here; rebuilding the DOM
 *      would recreate the rails and restart their CSS animations, so the
 *      dashes would snap back to phase zero several times a minute. _build()
 *      runs once, _patch() only writes custom properties and textContent.
 */

const CARD = "jkbms-battery-console-card";
import { cardTip } from "./card-tip.js?v=1.0.0";

const VERSION = "1.6.0";

/*
 * The design's palette, literal. Names are what the design calls them: two
 * greys for text, four grounds from the page up to a highlighted tile, three
 * rules, and the three semantic colours.
 */
/*
 * THE GROUNDS ARE THE INVERTER TAB'S, NOT THE DESIGN'S.
 *
 * The design draws this tab on a green-tinted near-black (#0b100e) with every
 * panel, tile and rule tinted to match. On its own it is handsome; one tab
 * away from powmr-inverter-console-card.js it reads as a different product,
 * and switching between them looks like the page failed to finish loading.
 *
 * So every GROUND and every RULE below is lifted literally from that card --
 * same card background and radial wash, same panel, same tile, same hairlines,
 * same four greys of text. Tab to tab, only the content changes.
 *
 * What stays the design's own is COLOUR THAT MEANS SOMETHING: the semantic
 * trio, the gauge tracks mixed from it, and the green wash under a switched-on
 * control. Those are data, not decoration, and the battery tab is entitled to
 * its own green for them.
 */
const BG = "#080909";        // page ground
const BG_WASH = "radial-gradient(1200px 600px at 15% -10%, #14161b 0%, #080909 60%)";
const PANEL = "#0B0C0F";     // panel
const INNER = "#0E1014";     // tile inside a panel
const RAISED = "#080F0C";    // the one tile that is called out
const CARD_EDGE = "#16181d"; // the card's own border
const LINE = "#1C1E24";      // panel border
const LINE2 = "#23262E";     // tile border
const LINE3 = "#191B21";     // hairline: dividers, gridlines, empty track
const EDGE = "#2f5a44";      // border of anything switched on
const HOVER = "#3A3F4A";     // border under the cursor, and an off dot
const TXT = "#E8EAED";
const TXT2 = "#9AA0AB";
const MUTED = "#6E737E";
const DIM = "#2A2E36";

const OK = "#589569";
const WARN = "#ae8446";
const BAD = "#bb635b";

/* The same three, at the weight a gauge track is painted in. */
const TRACK_OK = "#245c40";
const TRACK_WARN = "#6b5520";
const TRACK_BAD = "#5c2f2a";

const ON_BG = "#122019";     // a switched-on chip
const ON_BG2 = "#1a2c22";    // a pressed segment
const ON_HOVER = "#16281f";

const BLOCKS = ["header", "switches", "pack", "flow", "cells", "timing", "temps", "history"];

const DEFAULTS = {
  // Pack, from the BMS -- authoritative for everything it reports
  soc: "sensor.jkbms_gateway_bms_state_of_charge",
  capacity_remaining: "sensor.jkbms_gateway_bms_capacity_remaining",
  pack_voltage: "sensor.jkbms_gateway_bms_total_voltage",
  pack_current: "sensor.jkbms_gateway_bms_current",
  pack_power: "sensor.jkbms_gateway_bms_power",
  cell_min: "sensor.jkbms_gateway_bms_min_cell_voltage",
  cell_max: "sensor.jkbms_gateway_bms_max_cell_voltage",
  cell_delta: "sensor.jkbms_gateway_bms_delta_cell_voltage",
  temp_1: "sensor.jkbms_gateway_bms_temp_1_battery",
  temp_2: "sensor.jkbms_gateway_bms_temp_2_battery",
  // Derived template sensors, both in hours
  time_to_full: "sensor.battery_time_to_full",
  runtime_left: "sensor.battery_runtime_remaining",
  // The inverter's side of the same DC bus
  charge_current: "sensor.powmr_inverter_battery_charge_current",
  discharge_current: "sensor.powmr_inverter_battery_discharge_current",
  inverter_voltage: "sensor.powmr_inverter_battery_voltage_inverter",
  power_priority: "select.powmr_inverter_power_priority",
  // One entity per cell, in series order. The flow tile's bars, the deviation
  // chart and the "N cells in series" line are all sized from this list, so a
  // pack with a different cell count needs nothing here but a longer array.
  cells: [
    "sensor.jkbms_gateway_bms_cell_1",
    "sensor.jkbms_gateway_bms_cell_2",
    "sensor.jkbms_gateway_bms_cell_3",
    "sensor.jkbms_gateway_bms_cell_4",
    "sensor.jkbms_gateway_bms_cell_5",
    "sensor.jkbms_gateway_bms_cell_6",
    "sensor.jkbms_gateway_bms_cell_7",
    "sensor.jkbms_gateway_bms_cell_8",
  ],
  // Nameplate. 280 Ah was already the `max` on the tab's old capacity gauge.
  pack_capacity_ah: 280,
  // The ceiling the current meter and the rail speed scale against. The old
  // tab's current gauge ran -200..200 A, and that is what this keeps.
  max_current_a: 200,
  // What the rails scale their speed against. Deliberately NOT max_current_a
  // times pack voltage -- that is 5.4 kW, a figure this leg cannot reach, and
  // everything real would crawl against it. 1600 W is the ceiling the Inverter
  // tab's battery run already uses, so the same power draws the same speed on
  // both tabs.
  max_power_w: 1600,
  chemistry: "LiFePO4",
  temp_1_label: "Bank 1",
  temp_2_label: "Bank 2",
  title: "Battery Pack",
  blocks: BLOCKS.slice(),
};

/*
 * The three switches on this pack, in the design's order. Charging is the
 * inverter's AC charger; the other two are the BMS's own MOSFETs.
 *
 * The design's bar carries exactly these three and this system has exactly
 * these three, so nothing here is dropped or faked.
 */
const SWITCHES = [
  { label: "Charging", cfg: "sw_charge", ent: "switch.powmr_inverter_ac_charging_enabled",
    icon: "mdi:battery-charging-50", live: "charge" },
  { label: "Discharging", cfg: "sw_discharge", ent: "switch.powmr_inverter_bms_discharging_switch",
    icon: "mdi:battery-arrow-down-outline", live: "discharge" },
  { label: "Balancer", cfg: "sw_balancer", ent: "switch.powmr_inverter_bms_balancer_switch",
    icon: "mdi:scale-balance", live: "balance" },
];
SWITCHES.forEach((s) => { DEFAULTS[s.cfg] = s.ent; });

/*
 * History tabs. `cfg` names the DEFAULTS key, so an override follows through.
 *
 * `band` names the threshold the series is judged against, and a series that
 * has one is DRAWN IN ITS BAND'S COLOUR rather than in `color` -- see
 * _seriesColor. A pack sitting at 26.9 V is nominal, so its line is the same
 * green as the word NOMINAL in the meter above it, and it turns amber with the
 * meter. `color` is the identity colour, and it is what the two series with no
 * threshold keep: current and power are numbers whose SIGN this card has an
 * opinion about and whose MAGNITUDE it does not.
 *
 * `mul` scales the recorder's value for display only -- see the header.
 */
const SERIES = [
  { key: "soc", cfg: "soc", name: "State of Charge", short: "SOC", unit: "%", dec: 1, band: "soc", color: OK, help: "s_soc" },
  // Three decimals, not one: the BMS resolves remaining capacity to the
  // milliamp-hour and a tenth of an amp-hour throws away the digits that move
  // between two samples. Same reason the meter's sub line carries three.
  { key: "cap", cfg: "capacity_remaining", name: "Remaining Capacity", short: "Capacity", unit: "Ah", dec: 3, band: "cap", color: OK, help: "s_cap" },
  { key: "volt", cfg: "pack_voltage", name: "Pack Voltage", short: "Pack voltage", unit: "V", dec: 3, band: "pack", color: OK, help: "s_volt" },
  { key: "amp", cfg: "pack_current", name: "Pack Current", short: "Current", unit: "A", dec: 2, color: WARN, help: "s_amp" },
  { key: "watt", cfg: "pack_power", name: "Pack Power", short: "Power", unit: "W", dec: 1, color: WARN, help: "s_watt" },
  { key: "delta", cfg: "cell_delta", name: "Cell Delta", short: "Cell delta", unit: "mV", dec: 1, mul: 1000, band: "delta", color: OK, help: "s_delta" },
  { key: "t1", cfg: "temp_1", name: "Bank 1 Temperature", short: "Temp 1", unit: "°C", dec: 1, band: "temp", color: BAD, help: "s_temp" },
  { key: "t2", cfg: "temp_2", name: "Bank 2 Temperature", short: "Temp 2", unit: "°C", dec: 1, band: "temp", color: BAD, help: "s_temp" },
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

const MIN_SPAN = 60000;
const MAX_SPAN = Math.max.apply(null, Object.keys(RANGES)
  .map((k) => RANGES[k].hours)) * 3600000;

// How far back raw states reach: the recorder keeps two days
// (configuration.yaml, purge_keep_days: 2). A window starting before this is
// drawn from hourly long-term statistics instead. 36 h, not 48, so a window
// that would lean on the last hours before a purge takes statistics too.
const RAW_HORIZON = 36 * 3600000;

const CH_W = 1000;
const CH_H = 230;
const CH_PAD = 10;

const RAIL = 16; // px, one gradient period -- must match @keyframes railShift

/*
 * Tooltips, lines 2-4 (docs/dashboard-tooltips.md). Line 1 -- the name and
 * the live state -- is built where the element is patched; these are the
 * static half and are assigned after it with `=`, never appended.
 *
 * The numbers are this pack's and this card's: 8S LiFePO4, 280 Ah, the band
 * constants below, the 23:00-07:00 night window the charge gate opens on, and
 * the sensors in packages/battery_runtime.yaml. Change them together.
 */
const HELP = {
  sw_charge: "The BMS charge MOSFET: whether the pack may take any charge at all.\n"
    + "E.g. with Night only on, it is switched on at 23:00 and off at 07:00.\n"
    + "Icon or dot: toggles. Name: opens its dialog. A lit dot: charging now.",
  sw_discharge: "The BMS discharge MOSFET: whether the pack may supply the inverter.\n"
    + "E.g. off during an outage, the pack cannot carry the house.\n"
    + "Icon or dot: toggles. Name: opens its dialog. A lit dot: discharging now.",
  sw_balancer: "The BMS's passive cell balancer, which evens out the eight cells.\n"
    + "E.g. the dot lights at a spread over 10 mV and turns amber past 20 mV.\n"
    + "Icon or dot: toggles. Name: opens its dialog.",
  cap: "State of charge from the BMS, and the amp-hours left of the 280 Ah pack.\n"
    + "E.g. 55 % is about 154 Ah: red below 20 %, amber below 70 %, green from 70 %.",
  amp: "Pack current from the BMS: right of centre is charging, left is discharging.\n"
    + "E.g. about +19 A on a charge, −6.5 A with the house idling on the pack.\n"
    + "The bar runs ±200 A; amber past 100 A, red past 160 A.",
  volt: "Total pack voltage from the BMS, banded on what one of its 8 cells reads.\n"
    + "E.g. 26.8 V is 3.35 V a cell; amber below 24.8 V or above 28.0 V.\n"
    + "Red below 23.2 V or above 28.8 V, the 2.90 / 3.60 V cell limits.",
  bus: "Power between the inverter's DC bus and the pack, signed by the BMS.\n"
    + "E.g. 164 W out is a typical draw while the house runs on the battery.\n"
    + "The rail moves faster with more power, up to 1600 W.",
  pack: "The eight cells in miniature, each bar its own voltage on 2.80–3.65 V.\n"
    + "E.g. a cell over 20 mV off the median turns amber: out of tolerance.",
  cell: "One of the 8 LiFePO4 cells in series, as its BMS sensor reads it.\n"
    + "E.g. 3.35 V is normal; amber below 3.10 V, above 3.50 V or 20 mV off the median.",
  cellDev: "How far this cell sits from the mean of all eight, in millivolts.\n"
    + "E.g. +1.0 mV is level; past 20 mV off the median the bar turns amber.",
  cellMin: "The lowest of the eight cell voltages, as the BMS reports it.\n"
    + "E.g. 3.349 V; under 3.10 V a cell turns amber, under 2.90 V red.",
  cellMax: "The highest of the eight cell voltages, as the BMS reports it.\n"
    + "E.g. 3.351 V; over 3.50 V a cell turns amber, over 3.60 V red.",
  cellDelta: "The spread: highest cell minus lowest, as the BMS reports it.\n"
    + "E.g. 2.0 mV is level; amber past 20 mV, red past 50 mV.\n"
    + "Past 10 mV the Balancer chip's dot lights: it has work to do.",
  ttf: "Hours until 280 Ah at the current charge rate, recomputed every 30 s.\n"
    + "E.g. 140 Ah short at 20 A reads 7h 0m, with the clock time it lands on.\n"
    + "Unknown while discharging, idle or under 0.2 A; capped at 99 h.",
  rtl: "Hours until the pack is flat at the current draw, recomputed every 30 s.\n"
    + "E.g. 140 Ah left at a 10 A draw reads 14h 0m, with the clock time it lands on.\n"
    + "Unknown while charging, idle or under 0.2 A; capped at 99 h.",
  temp: "A BMS temperature probe on the pack; the bar runs 0–60 °C.\n"
    + "E.g. 25 °C is green; amber under 10 °C or over 40 °C, red under 0 °C or over 50 °C.\n"
    + "Charging a LiFePO4 pack below 0 °C damages it.",
  range: "Sets the chart's window, and brings a dragged or zoomed chart back to live.\n"
    + "E.g. 24h shows the night charge as a climb from 23:00 to 07:00.\n"
    + "Windows starting over 36 h back are drawn from hourly statistics.",
  chart: "The series on the chart below; tap the name to open its entity.\n"
    + "E.g. drag the chart back to 23:00, scroll or pinch to zoom, double-click for live.",
  s_soc: "Charts the BMS state of charge, in its band colour.\n"
    + "E.g. a climb from 23:00 to 07:00 is the night charge on the cheap tariff.",
  s_cap: "Charts the amp-hours left in the 280 Ah pack, to the milliamp-hour.\n"
    + "E.g. a fall of 6.5 Ah an hour is the house idling on the battery.",
  s_volt: "Charts the total pack voltage, coloured on volts per cell like the meter.\n"
    + "E.g. 26.8 V is 3.35 V a cell; the line dips while a load pulls on the pack.",
  s_amp: "Charts the signed pack current: above zero charging, below discharging.\n"
    + "E.g. about +19 A on a charge, −6.5 A with the house idling on the pack.",
  s_watt: "Charts the signed pack power: above zero charging, below discharging.\n"
    + "E.g. a sudden 895 W step down is a compressor starting on the battery.",
  s_delta: "Charts the spread between the highest and lowest cell, in millivolts.\n"
    + "E.g. under 10 mV the pack is level; past 20 mV the line turns amber.",
  s_temp: "Charts one BMS temperature probe on the pack.\n"
    + "E.g. the line turns amber under 10 °C or over 40 °C, red under 0 °C or over 50 °C.",
  stat_now: "The series' latest reading, live from the sensor.\n"
    + "E.g. Now 55.0 % while the chart shows the 24 hours that led to it.",
  stat_min: "The lowest reading in the window on screen, off-scale ones included.\n"
    + "E.g. SOC zoomed to 23:00–07:00: Min is where the night charge started.",
  stat_max: "The highest reading in the window on screen, off-scale ones included.\n"
    + "E.g. SOC zoomed to 23:00–07:00: Max is where the night charge ended.",
  stat_mean: "The time-weighted average of the readings in the window on screen.\n"
    + "E.g. a Power mean below zero: the pack gave more than it took.",
};

/*
 * SOC bands, taken from the Battery tab's old gauge severity on the same
 * entity (green 70, yellow 20, red 0). The capacity meter's track stops and
 * the tick labels under it use the same two numbers -- change them together.
 */
const SOC_RED = 20;
const SOC_GREEN = 70;

/*
 * Per-cell voltage, in volts. A LiFePO4 cell is flat between about 3.15 and
 * 3.40 for most of its charge, so these are not SOC boundaries -- they are the
 * edges the BMS protects on, and they are what the pack meter, the cell bars
 * and the cell chart all colour against.
 *
 * AXIS_LO/HI are the span a bar is drawn over, wide enough that a cell sitting
 * at either protection limit is still inside the frame.
 */
const CELL_BAD_LO = 2.90;
const CELL_WARN_LO = 3.10;
const CELL_WARN_HI = 3.50;
const CELL_BAD_HI = 3.60;
const CELL_AXIS_LO = 2.80;
const CELL_AXIS_HI = 3.65;

/* Cell spread, in volts. 20 mV is the design's own "this one is drifting". */
const DELTA_WARN = 0.020;
const DELTA_BAD = 0.050;

/*
 * The spread at which a balancer stops waiting and starts working -- the point
 * the Balancer chip's dot lights up at. See _activity.
 *
 * Deliberately half of DELTA_WARN, because it answers a different question.
 * DELTA_WARN is about a CELL: at 20 mV one of them is far enough from its
 * neighbours to be called out of tolerance, coloured amber in the chart and
 * counted in "N cells out of tolerance". This is about the PACK and the JOB:
 * long before any single cell is in trouble, a 10 mV spread is one the
 * balancer will be shunting current to close, and a balancer that has been
 * working on it for days is the early sign of a cell going bad. Raising this
 * to 20 would mean the word only lit up once the chart was already amber,
 * which is the point at which it has stopped being early.
 */
const DELTA_BALANCING = 0.010;

/* Pack temperature, in °C. Below zero is the one that ruins a LiFePO4 pack. */
const TEMP_BAD_LO = 0;
const TEMP_WARN_LO = 10;
const TEMP_WARN_HI = 40;
const TEMP_BAD_HI = 50;
const TEMP_AXIS_HI = 60;

/*
 * IBM Plex Sans is the design's text face and IBM Plex Mono every number in
 * it. Both carry a Cyrillic subset, which is the one that matters: this HA is
 * configured in Cyrillic, so a friendly_name landing in either face has to
 * render without falling back to system-ui.
 *
 * Sans ships from Google as a VARIABLE font -- one file per subset covers the
 * whole 400..600 range this card uses, which is why those three entries carry
 * a weight RANGE and no weight in the filename. Served locally: no request
 * leaves the house and the card still renders with the network down.
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
  ["IBM Plex Sans", "400 600", "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Sans", "400 600", "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Sans", "400 600", "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
].map(function (f) {
  var sans = f[0] === "IBM Plex Sans";
  var file = sans
    ? "ibm-plex-sans-" + f[2] + ".woff2"
    : "ibm-plex-mono-" + f[1] + "-" + f[2] + ".woff2";
  return "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1]
    + ";font-display:swap;src:url('/local/fonts/" + file + "') format('woff2');"
    + "unicode-range:" + f[3] + "}";
}).join("\n");

/*
 * THE FACES ARE REGISTERED ON THE DOCUMENT, NOT IN THIS CARD'S SHADOW ROOT,
 * AND THAT IS NOT A STYLE PREFERENCE.
 *
 * Chrome does not apply an @font-face rule declared inside a shadow tree. The
 * rule parses, CSSOM keeps it -- sheet.cssRules lists every one of them, with
 * the right family, weight and src -- and the font is never fetched or used.
 * document.fonts never hears about it. Nothing warns. The text just renders in
 * the fallback, which on a box that happens to have IBM Plex Mono installed
 * looks exactly right for the mono face and exactly wrong for the sans one, so
 * the failure hides until somebody measures a glyph.
 *
 * That is how it hid here: this card's sibling, powmr-inverter-console-card.js,
 * has shipped its Space Grotesk inside its own shadow root since it was
 * written, and that face has never once loaded.
 *
 * So the rules go in a <style> on document.head instead, where @font-face is
 * honoured. The id makes it idempotent -- both cards can be on a dashboard at
 * once, and a Lovelace re-render must not stack a second copy.
 */
const FONT_STYLE_ID = "jkbms-battery-console-fonts";

function installFonts() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(FONT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = FONTS;
  document.head.appendChild(style);
}

const STYLE = `
:host { display: block; container-type: inline-size; container-name: bcard; }

ha-card {
  /* Type scale. 1.0 is the design at its own width. */
  --s: 1;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  background: ${BG};
  background-image: ${BG_WASH};
  color: ${TXT};
  font-family: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  border: 1px solid ${CARD_EDGE};
  box-shadow: none;
  overflow: hidden;
}
.root { padding: 30px 34px 34px; display: flex; flex-direction: column; gap: 18px; }
.mono { font-family: var(--mono); }

/* --- header ------------------------------------------------------------- */
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.kicker { font-family: var(--mono); font-size: calc(11px * var(--s)); letter-spacing: .18em;
  color: ${MUTED}; text-transform: uppercase; }
.title { font-size: calc(32px * var(--s)); font-weight: 600; letter-spacing: -.02em; margin-top: 8px; line-height: 1; }
.tools { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
.pill { display: flex; align-items: center; border: 1px solid ${LINE}; border-radius: 8px;
  padding: 9px 13px; background: ${PANEL}; font-family: var(--mono); font-size: calc(12px * var(--s));
  flex: none; }
.pclock { color: ${MUTED}; font-variant-numeric: tabular-nums; }

/*
 * The controls, in the same shape and with the same three hit areas as the
 * Inverter tab's chips: the icon and the dot toggle the switch, the LABEL
 * opens the entity dialog. One control, three targets, and which one you hit
 * decides whether you are changing the house or asking about it.
 */
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { display: flex; align-items: center; gap: 8px; padding: 7px 9px 7px 7px; border-radius: 10px;
  font-family: var(--mono); font-size: calc(12px * var(--s)); transition: all .16s;
  border: 1px solid ${LINE2}; background: ${INNER}; color: ${MUTED}; }
/* The chip's own lit state is the SWITCH: enabled or not. */
.chip.on { border-color: ${EDGE}; background: ${ON_BG}; color: ${OK}; }
.chip .ic { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border-radius: 7px; flex: none; cursor: pointer; transition: background .15s; }
.chip .ic:hover { background: #ffffff14; }
.chip .ic ha-icon { --mdc-icon-size: calc(16px * var(--s));
  width: calc(16px * var(--s)); height: calc(16px * var(--s)); }
.chip .lbl { cursor: pointer; white-space: nowrap; }
.chip .lbl:hover { text-decoration: underline; text-underline-offset: 3px; }
.chip .dw { display: flex; align-items: center; justify-content: center; width: 16px; height: 22px;
  border-radius: 6px; flex: none; cursor: pointer; }
.chip .dw:hover { background: #ffffff14; }
/*
 * The dot is NOT the switch -- the chip around it already says that. The dot
 * is whether the thing is happening RIGHT NOW, which is a different fact and
 * frequently the opposite one: the AC charger can be enabled all night and
 * charging for ten minutes of it.
 *
 * Grey and still means not happening. Pulsing in --dc means it is.
 */
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: ${HOVER};
  flex: none; transition: background .2s; }
.chip .dot.live { background: var(--dc); box-shadow: 0 0 8px var(--dc);
  animation: bcpulse 1.1s ease-in-out infinite; }
@keyframes bcpulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }

/* --- panels ------------------------------------------------------------- */
.panel { border: 1px solid ${LINE}; border-radius: 10px; background: ${PANEL}; min-width: 0; }
.panel.pack, .panel.flow { padding: 18px 20px 22px; }
.panel.cells, .panel.timing, .panel.temps { padding: 18px 20px 20px; }
.panel.hist { padding: 20px 22px 24px; }
.plabel { font-family: var(--mono); font-size: calc(11px * var(--s)); letter-spacing: .18em;
  color: ${MUTED}; text-transform: uppercase; }
.cols { display: grid; grid-template-columns: minmax(0, 2.1fr) minmax(0, 1fr); gap: 18px;
  align-items: stretch; }
/* stretch, not start: the point of one grid is that the two panels sharing a
   row are the same height, and start is what let them drift apart. */
.cols > .panel { min-width: 0; }
.cols > .panel.flow   { grid-column: 1; grid-row: 1; }
.cols > .panel.timing { grid-column: 2; grid-row: 1; }
.cols > .panel.cells  { grid-column: 1; grid-row: 2; }
.cols > .panel.temps  { grid-column: 2; grid-row: 2; }
/* One column: placement has to go back to document order, or everything asks
   for a column 2 that is not there.
   Spelled out per class rather than as a bare .cols.one > .panel, because the rules
   above are one class more specific and a container query adds no specificity
   of its own -- a shorter selector here loses to them and the layout silently
   stays in two columns on a phone. */
.cols.one { grid-template-columns: minmax(0, 1fr); }
.cols.one > .panel.flow, .cols.one > .panel.timing,
.cols.one > .panel.cells, .cols.one > .panel.temps { grid-column: 1; grid-row: auto; }

/* --- meters ------------------------------------------------------------- */
.meters { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 16px; }
.meter { border: 1px solid ${LINE2}; border-radius: 8px; background: ${INNER}; padding: 15px 16px 14px;
  min-width: 0; cursor: pointer; transition: border-color .15s; }
.meter:hover { border-color: ${HOVER}; }
.m-head { display: flex; justify-content: space-between; gap: 10px; font-family: var(--mono);
  font-size: calc(10px * var(--s)); letter-spacing: .16em; color: ${MUTED}; text-transform: uppercase; }
.m-val { display: flex; align-items: baseline; gap: 5px; margin-top: 10px; font-family: var(--mono); }
.m-val b { font-size: calc(31px * var(--s)); font-weight: 400; line-height: 1; }
.m-val i { font-size: calc(13px * var(--s)); font-style: normal; color: ${MUTED}; }
.m-sub { font-family: var(--mono); font-size: calc(11px * var(--s)); color: ${MUTED}; margin-top: 8px; }
.track { position: relative; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 12px; background: ${LINE3}; }
.fill { position: absolute; top: 0; bottom: 0; left: 0; width: 0; transition: width .4s, left .4s; }
/* The zero line on the signed meter. Without it the centre is a guess. */
.track.mid::after { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
  background: ${BG}; opacity: .8; }
.ticks { position: relative; height: 12px; margin-top: 6px; font-family: var(--mono);
  font-size: calc(10px * var(--s)); color: ${MUTED}; }
.ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.ticks span.l0 { left: 0; transform: none; }
.ticks span.r0 { right: 0; left: auto; transform: none; }

/* --- flow --------------------------------------------------------------- */
.flowgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;
  margin-top: 16px; align-items: start; }
.fcard { min-width: 0; border: 1px solid ${LINE2}; border-radius: 8px; background: ${INNER};
  padding: 0 0 14px; overflow: hidden; cursor: pointer; transition: border-color .15s; }
.fcard:hover { border-color: ${HOVER}; }
.fcard.lit { border-color: ${EDGE}; background: ${RAISED}; }
/*
 * THE RAIL -- the point of the whole panel.
 *
 * One 16px gradient period, translated exactly one period by the keyframe, so
 * the loop is seamless. --dur is the seconds per period and is the ONLY thing
 * that changes with power: 2.4s barely moving, down to 0.3s flat out. Writing
 * it retunes the running animation rather than restarting it, which is the
 * whole reason this card patches properties instead of rebuilding its DOM.
 *
 * Idle pauses through animation-play-state, NOT by dropping the animation --
 * removing and re-adding it would restart the phase, which is the stutter this
 * design is trying to avoid. Discharge reverses it, so the dashes run back
 * toward the inverter.
 */
.rail { height: 3px;
  background-image: repeating-linear-gradient(90deg, var(--c, ${OK}) 0 7px, transparent 7px ${RAIL}px);
  animation-name: railShift;
  animation-duration: var(--dur, 1.2s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-direction: var(--dir, normal);
  animation-play-state: var(--play, running);
  opacity: var(--op, 1);
  transition: opacity .35s; }
@keyframes railShift { from { background-position: 0 0 } to { background-position: ${RAIL}px 0 } }
.f-head { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-family: var(--mono);
  font-size: calc(10px * var(--s)); letter-spacing: .16em; color: ${MUTED}; padding: 14px 16px 0;
  text-transform: uppercase; }
.f-big { display: flex; align-items: baseline; gap: 5px; margin-top: 10px; padding: 0 16px; font-family: var(--mono); }
.f-big b { font-size: calc(28px * var(--s)); font-weight: 400; line-height: 1; }
.f-big i { font-size: calc(13px * var(--s)); font-style: normal; color: ${MUTED}; }
.f-small { display: flex; align-items: baseline; gap: 5px; margin-top: 6px; padding: 0 16px; font-family: var(--mono); }
.f-small b { font-size: calc(18px * var(--s)); font-weight: 400; color: ${MUTED}; }
.f-small i { font-size: calc(12px * var(--s)); font-style: normal; color: ${MUTED}; }
.f-sub { font-family: var(--mono); font-size: calc(11px * var(--s)); color: ${MUTED}; margin-top: 8px; padding: 0 16px; }
.pack-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 0 16px; }
.pack-cells { display: flex; gap: 4px; flex: 1; min-width: 0; }
.pcell { flex: 1; min-width: 0; height: 44px; border: 1px solid ${DIM}; border-radius: 3px;
  background: ${INNER}; display: flex; align-items: flex-end; overflow: hidden; }
.pcell i { display: block; width: 100%; height: 0; transition: height .4s, background .3s; }
/* The pack's positive terminal, so the row of cells reads as a battery. */
.nub { width: 10px; height: 18px; border: 1px solid ${DIM}; border-left: none; border-radius: 0 3px 3px 0; flex: none; }

/* --- cell deviation ----------------------------------------------------- */
.c-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.c-title { font-size: calc(19px * var(--s)); font-weight: 600; margin-top: 6px; }
.c-title span { font-family: var(--mono); font-size: calc(12px * var(--s)); font-weight: 400; color: ${MUTED}; }
.c-stats { display: flex; gap: 18px; font-family: var(--mono); font-size: calc(11px * var(--s)); color: ${MUTED}; }
.c-stats span b { font-weight: 400; color: ${TXT}; }
.c-plot { display: flex; align-items: stretch; gap: 10px; margin-top: 18px; height: 150px; }
.c-yax { display: flex; flex-direction: column; justify-content: space-between; font-family: var(--mono);
  font-size: calc(10px * var(--s)); color: ${MUTED}; text-align: right; width: 52px; flex: none; }
.c-field { flex: 1; min-width: 0; position: relative; border-left: 1px solid ${LINE2}; }
.c-zero { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed ${LINE2}; }
.c-bars { position: absolute; inset: 0; display: flex; align-items: center; gap: 8px; padding: 0 6px; }
.c-bar { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: center;
  cursor: pointer; }
.c-up { height: 50%; display: flex; flex-direction: column; justify-content: flex-end; }
.c-up i, .c-down i { display: block; height: 0; transition: height .4s, background .3s; }
.c-up i { border-radius: 2px 2px 0 0; }
.c-down { height: 50%; }
.c-down i { border-radius: 0 0 2px 2px; }
.c-names { display: flex; gap: 8px; padding: 0 6px; margin-left: 62px; margin-top: 8px; }
.c-name { flex: 1; min-width: 0; text-align: center; font-family: var(--mono);
  font-size: calc(10px * var(--s)); color: ${MUTED}; cursor: pointer; }
.c-name b { display: block; color: ${TXT}; font-size: calc(11px * var(--s)); font-weight: 400; }
.c-name span { display: block; margin-top: 3px; letter-spacing: .08em; }
.c-name:hover b { color: ${OK}; }

/* --- timing ------------------------------------------------------------- */
/* One under the other, not side by side. Two tiles across a 1fr column were
   narrow enough that "tomorrow 05:32" wrapped, and stacking them lets the
   panel fill the height of Live power flow beside it rather than stopping
   short and leaving the row ragged. */
.panel.timing { display: flex; flex-direction: column; }
.tgrid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin-top: 14px;
  flex: 1; grid-auto-rows: 1fr; }
/* 1fr rows so the two tiles share whatever height the row turned out to be,
   evenly, instead of sitting at their natural size with a gap underneath. */
.ttile { border: 1px solid ${LINE2}; border-radius: 8px; background: ${INNER}; padding: 12px 14px;
  cursor: pointer; transition: border-color .15s;
  display: flex; flex-direction: column; justify-content: center; }
.ttile:hover { border-color: ${HOVER}; }
.ttile b { display: block; font-family: var(--mono); font-size: calc(10px * var(--s)); letter-spacing: .14em;
  color: ${MUTED}; font-weight: 400; text-transform: uppercase; }
/* Duration left, date right, on one baseline.
   Stacked, the pair left a tall tile mostly empty and a wide tile mostly
   unused -- the two halves of the same answer, each wasting the other's
   space.

   Both are sized to fill the tile rather than to sit politely in a corner:
   this panel is as tall as Live power flow beside it, and small type in a
   big box is what made it read as empty. The date is the quieter of the two
   only in colour, not in size -- the duration is the headline, the date is
   the one you act on.

   It wraps rather than overflows. Sixteen characters of date plus a duration
   is wide, and between 1000px and about 1300px of card the right column is a
   third of it; margin-left:auto keeps the date against the right edge on
   whichever line it lands. */
.tline { display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.ttile span { font-family: var(--mono); font-size: calc(26px * var(--s)); min-width: 0; }
.ttile i { font-family: var(--mono); font-style: normal; font-size: calc(19px * var(--s));
  color: ${MUTED}; white-space: nowrap; margin-left: auto; }

/* --- temperatures ------------------------------------------------------- */
.trows { display: flex; flex-direction: column; gap: 16px; margin-top: 16px; }
.trow { cursor: pointer; }
.trow .th { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.trow .tl { font-size: calc(13px * var(--s)); }
.trow:hover .tl { color: ${OK}; }
.trow .tv { font-family: var(--mono); font-size: calc(14px * var(--s)); }
.trow .track { margin-top: 8px; height: 5px; }
.trow .ticks { margin-top: 5px; }

/* --- history ------------------------------------------------------------ */
.hhead { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
.hname { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
.hname .n { font-size: calc(23px * var(--s)); font-weight: 600; letter-spacing: -.01em; cursor: pointer; }
.hname .n:hover { text-decoration: underline; text-underline-offset: 4px; }
.hname .w { font-family: var(--mono); font-size: calc(12px * var(--s)); color: ${MUTED}; }
.segs { display: flex; gap: 2px; border: 1px solid ${LINE2}; border-radius: 7px; padding: 3px; background: ${INNER}; }
.seg { background: transparent; color: ${MUTED}; border: none; border-radius: 5px; padding: 6px 12px;
  font-family: var(--mono); font-size: calc(11px * var(--s)); cursor: pointer; transition: all .15s; }
.seg:hover { color: ${TXT}; }
.seg[aria-pressed="true"] { background: ${ON_BG2}; color: ${OK}; }
.tabs { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.tab { background: ${INNER}; border: 1px solid ${LINE2}; color: ${TXT2}; border-radius: 20px;
  padding: 6px 14px; font-family: inherit; font-size: calc(12px * var(--s)); cursor: pointer; transition: all .15s; }
.tab:hover { border-color: ${HOVER}; color: ${TXT}; }
/* 12% and 42% are the alpha the design gives a selected pill. Written as a mix
   of --tc so the chip follows a colour that changes under it. */
.tab[aria-pressed="true"] { color: var(--tc);
  border-color: color-mix(in srgb, var(--tc) 42%, transparent);
  background: color-mix(in srgb, var(--tc) 12%, transparent); }
.chart { display: flex; gap: 10px; margin-top: 18px; align-items: flex-start; }
.yax { width: 58px; flex: 0 0 58px; display: flex; flex-direction: column; justify-content: space-between;
  height: ${CH_H}px; padding: ${CH_PAD}px 0; box-sizing: border-box; text-align: right;
  font-family: var(--mono); font-size: calc(10px * var(--s)); color: ${MUTED}; }
.yax span { display: block; height: 0; line-height: 0; white-space: nowrap; }
.plot { flex: 1; min-width: 0; position: relative;
  /*
   * pan-y hands vertical scrolling back to the page and keeps everything
   * else: a horizontal drag and a two-finger pinch arrive here as pointer
   * events instead of scrolling or zooming the dashboard.
   */
  touch-action: pan-y; cursor: grab; user-select: none; -webkit-user-select: none; }
.plot.grabbing { cursor: grabbing; }
svg.ch { width: 100%; height: ${CH_H}px; display: block;
  border-left: 1px solid ${LINE2}; border-bottom: 1px solid ${LINE2}; cursor: crosshair; }
.xax { display: flex; justify-content: space-between; gap: 4px; margin-top: 8px;
  font-family: var(--mono); font-size: calc(10px * var(--s)); color: ${MUTED}; }
.hv { position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 1; }
.hv.on { opacity: 1; }
.hvline { top: 0; height: ${CH_H}px; width: 1px; background: ${HOVER}; }
.hvdot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid ${PANEL}; transform: translate(-50%, -50%); }
.tip { position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
  transform: translate(-50%, -100%); z-index: 2; background: ${RAISED}; border: 1px solid ${EDGE};
  border-radius: 8px; padding: 6px 10px; font-family: var(--mono); font-size: calc(12px * var(--s));
  color: ${TXT}; white-space: nowrap; box-shadow: 0 10px 30px -12px #000; }
.tip.on { opacity: 1; }
.tip b { display: block; font-weight: 600; font-size: calc(13px * var(--s)); }
.tip i { display: block; font-style: normal; color: ${MUTED}; font-size: calc(10px * var(--s));
  letter-spacing: .08em; margin-top: 2px; }
.note { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  font-family: var(--mono); font-size: calc(12px * var(--s)); color: ${MUTED}; text-align: center; padding: 0 12px; }
.note.show { display: flex; }
.stats { display: flex; gap: 44px; margin-top: 20px; padding-top: 18px; border-top: 1px solid ${LINE3}; flex-wrap: wrap; }
.stat b { display: block; font-family: var(--mono); font-size: calc(10px * var(--s)); letter-spacing: .16em;
  color: ${MUTED}; font-weight: 400; text-transform: uppercase; }
.stat span { display: block; font-family: var(--mono); font-size: calc(19px * var(--s)); color: ${TXT}; margin-top: 7px; }
.foot { font-family: var(--mono); font-size: calc(11px * var(--s)); color: ${MUTED}; text-align: center; margin-top: 4px; }

@container bcard (min-width: 1250px) { ha-card { --s: 1.05; } }
@container bcard (min-width: 1500px) { ha-card { --s: 1.10; } }
@container bcard (min-width: 1750px) { ha-card { --s: 1.16; } }
@container bcard (min-width: 2100px) { ha-card { --s: 1.24; } }

/* --- narrow ------------------------------------------------------------- */
@container bcard (max-width: 1000px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .cols > .panel.flow, .cols > .panel.timing,
  .cols > .panel.cells, .cols > .panel.temps { grid-column: 1; grid-row: auto; }
}
@container bcard (max-width: 640px) {
  .root { padding: 18px 14px 22px; }
  .panel.pack, .panel.flow, .panel.cells, .panel.timing, .panel.temps, .panel.hist { padding: 16px 14px 18px; }
  .title { font-size: calc(25px * var(--s)); }
  .c-yax { width: 40px; }
  .c-names { margin-left: 50px; }
  .yax { width: 44px; flex-basis: 44px; }
  .stats { gap: 24px; }
}

/*
 * The rail SPEED is information here, so this card cannot simply drop the
 * animation -- but it must still honour the preference. Paused rails keep the
 * direction and the dimming, and every value is on screen as a number anyway.
 */
@media (prefers-reduced-motion: reduce) {
  .rail { animation-play-state: paused; }
  /*
   * Stopped outright rather than paused, unlike the rail. A paused blink
   * settles wherever the phase happened to be, and a dot left at .35 opacity
   * is hard to tell from the grey one next to it. Colour and glow carry the
   * signal; the pulse was only ever how it got your attention.
   */
  .chip .dot.live { animation: none; opacity: 1; }
  .fill, .pcell i, .c-up i, .c-down i { transition: none; }
}
`;

class JkbmsBatteryConsoleCard extends HTMLElement {
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
    // 30m by default. The meters above answer "what is the pack doing now";
    // the shortest window is the one that answers "and what did it just do",
    // which is the question asked of a card someone opened during an outage.
    this._range = "30m";
    this._sel = SERIES[0].key;
    this._hist = new Map();
    this._inflight = new Map();
    this._token = null;
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
    if (!Array.isArray(cfg.cells) || !cfg.cells.length) {
      throw new Error(CARD + ": cells must be a non-empty list of cell entity ids");
    }
    cfg.cells.forEach((id) => {
      if (typeof id !== "string" || id.indexOf(".") < 1) {
        throw new Error(CARD + ": every entry in cells must be an entity id, got " + id);
      }
    });
    ["pack_capacity_ah", "max_current_a", "max_power_w"].forEach((k) => {
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
    if (this._config) this._render();
  }

  connectedCallback() {
    // Cheap and idempotent. Done here as well as at module load because a
    // module can be evaluated before <head> exists, and because this is the
    // first moment the card is certain to be in a document.
    installFonts();
    // The clock is the only thing that moves without a state change.
    if (!this._timer) this._timer = window.setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    // switches is 0: the controls now share the header's row rather than
    // occupying a band of their own.
    const per = { header: 4, switches: 0, pack: 6, flow: 8, cells: 9, timing: 0, temps: 0, history: 12 };
    return this._config
      ? this._config.blocks.reduce((t, b) => t + (per[b] || 0), 0)
      : 40;
  }

  static getStubConfig() {
    return {};
  }

  /*
   * A sections view lays each section out as a 12-column sub-grid, and a card
   * that does not answer this gets a narrow default slot -- which would squeeze
   * the two-column body into ~350px however wide the section itself was.
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

  _name(id, fallback) {
    const st = this._stateObj(id);
    return (st && st.attributes && st.attributes.friendly_name) || fallback || id;
  }

  _fmt(v, dec) {
    return v === null || v === undefined ? "—" : v.toFixed(dec);
  }

  /** Every cell voltage, in series order; nulls where a sensor is out. */
  _cellVolts() {
    return this._config.cells.map((id) => this._num(id));
  }

  // --- derivation ----------------------------------------------------------

  _socColor(p) {
    if (p === null) return MUTED;
    return p < SOC_RED ? BAD : p < SOC_GREEN ? WARN : OK;
  }

  _socLabel(p) {
    if (p === null) return "NO DATA";
    return p < SOC_RED ? "CRITICAL" : p < SOC_GREEN ? "MODERATE" : p < 95 ? "NOMINAL" : "FULL";
  }

  /** Bands for ONE cell, in volts. The pack meter divides before calling this. */
  _cellColor(v) {
    if (v === null) return MUTED;
    if (v < CELL_BAD_LO || v > CELL_BAD_HI) return BAD;
    if (v < CELL_WARN_LO || v > CELL_WARN_HI) return WARN;
    return OK;
  }

  _cellLabel(v) {
    if (v === null) return "NO DATA";
    if (v > CELL_BAD_HI) return "OVERVOLTAGE";
    if (v < CELL_BAD_LO) return "UNDERVOLTAGE";
    if (v > CELL_WARN_HI) return "HIGH";
    if (v < CELL_WARN_LO) return "LOW";
    return "NOMINAL";
  }

  _deltaColor(v) {
    if (v === null) return MUTED;
    return v > DELTA_BAD ? BAD : v > DELTA_WARN ? WARN : OK;
  }

  _tempColor(t) {
    if (t === null) return MUTED;
    if (t < TEMP_BAD_LO || t > TEMP_BAD_HI) return BAD;
    if (t < TEMP_WARN_LO || t > TEMP_WARN_HI) return WARN;
    return OK;
  }

  /**
   * The current meter's bands, as a fraction of the configured ceiling. Sign
   * is direction and is read elsewhere; this is about magnitude only.
   */
  _currentColor(a) {
    if (a === null) return MUTED;
    const r = Math.abs(a) / this._config.max_current_a;
    return r > 0.8 ? BAD : r > 0.5 ? WARN : OK;
  }

  /**
   * Whether a control's function is HAPPENING, as opposed to being allowed.
   *
   * The chip around the dot already shows the switch. This is the other half,
   * and the two disagree most of the time: the AC charger sits enabled all
   * night and charges for ten minutes of it, and the discharge MOSFET is on
   * around the clock while the pack only supplies the house during an outage.
   *
   * Charging and discharging are read off the BMS's signed power -- the one
   * number on this card that knows which way current is going.
   *
   * BALANCING HAS NO SENSOR, SO IT IS INFERRED, AND NARROWLY
   *
   * This BMS reports no balancing current, so there is nothing to read that
   * says the shunts are on. What can be said honestly is that a passive
   * balancer only has something to do when the cells have drifted: enabled
   * plus a spread past DELTA_BALANCING is the closest true statement to "it is
   * working", and enabled with the pack level is not balancing, it is waiting.
   *
   * Past DELTA_WARN it stays lit but turns amber. That is the same threshold
   * at which a cell is called out of tolerance everywhere else on this card,
   * and it is the point where the balancer having work to do stops being
   * routine.
   *
   * Returns null when nothing is happening -- the caller leaves the dot grey.
   */
  _activity(kind, on) {
    const c = this._config;
    if (kind === "charge") {
      return this._dir() > 0 ? { color: OK, word: "charging now" } : null;
    }
    if (kind === "discharge") {
      return this._dir() < 0 ? { color: OK, word: "discharging now" } : null;
    }
    if (kind === "balance") {
      if (!on) return null;
      const d = this._num(c.cell_delta);
      if (d === null || d <= DELTA_BALANCING) return null;
      return d > DELTA_WARN
        ? { color: WARN, word: "balancing " + (d * 1000).toFixed(1) + " mV spread" }
        : { color: OK, word: "balancing " + (d * 1000).toFixed(1) + " mV spread" };
    }
    return null;
  }

  /** What the grey dot means, which is not the same "off" in each case. */
  _idleWord(kind, on) {
    if (!on) return "switched off";
    if (kind === "charge") return "enabled, not charging";
    if (kind === "discharge") return "enabled, not discharging";
    if (kind === "balance") {
      const d = this._num(this._config.cell_delta);
      return d === null ? "enabled, spread unknown"
        : "enabled, cells level (" + (d * 1000).toFixed(1) + " mV)";
    }
    return "enabled";
  }

  /** +1 charging, -1 discharging, 0 idle. The BMS sign is the only source. */
  _dir() {
    const w = this._num(this._config.pack_power);
    if (w === null) return 0;
    return w > 2 ? 1 : w < -2 ? -1 : 0;
  }

  _pct(v, lo, span) {
    if (v === null) return 0;
    return Math.max(0, Math.min(100, (v - lo) / span * 100));
  }

  /** Where a per-cell voltage sits on the cell axis, as a percentage. */
  _cellPct(v) {
    return this._pct(v, CELL_AXIS_LO, CELL_AXIS_HI - CELL_AXIS_LO);
  }


  /**
   * Hours, as the two sensors report them, in the words a dashboard uses.
   * `unknown` is a real answer from both -- there is no runtime to predict
   * while the pack is charging -- so it is printed rather than blanked.
   */
  _hours(id) {
    const st = this._state(id);
    if (st === "unknown" || st === "unavailable") return { text: st, known: false };
    const h = this._num(id);
    if (h === null) return { text: "—", known: false };
    if (h < 1 / 60) return { text: "0m", known: true };
    const mins = Math.round(h * 60);
    return {
      text: mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h " + (mins % 60) + "m",
      known: true,
    };
  }

  /**
   * "in 2h 30m" turned into the date and time it lands on.
   *
   * A duration answers "how long", and every question anyone actually has --
   * will it be full before I leave, will it last the night, do I need to
   * start the generator before bed -- is about a clock. Doing that
   * subtraction in your head while looking at a battery is a small tax
   * charged every time.
   *
   * YYYY-MM-DD HH:MM, in full, always. "tomorrow 08:47" was friendlier and
   * worse: on a pack with thirty hours left the reader has to work out which
   * tomorrow, and a relative word is exactly the thing that goes stale on a
   * dashboard left open on a wall overnight. A date is never ambiguous and
   * never needs re-reading.
   *
   * Returns "" only for a duration that is not a number, so the tile does not
   * print a date derived from nothing. There is no upper cutoff: this is the
   * same estimate the duration beside it already shows, and refusing to
   * render it past some hour would leave half the tile blank while the other
   * half cheerfully claims 200h.
   */
  _clockAfter(hours) {
    if (hours === null || !Number.isFinite(hours) || hours < 0) return "";
    // A year is not a forecast, it is a division that went wrong upstream.
    if (hours > 24 * 365) return "";
    const then = new Date(Date.now() + hours * 3600000);
    const p = (n) => String(n).padStart(2, "0");
    return then.getFullYear() + "-" + p(then.getMonth() + 1) + "-" + p(then.getDate())
      + " " + p(then.getHours()) + ":" + p(then.getMinutes());
  }

  /**
   * The relative-speed mapping, the same one the inverter card uses.
   *
   *   r   = |watts| / max, clamped to 0..1
   *   dur = 2.4 - 2.1 * r^0.55  seconds per 16px rail period
   *
   * The 0.55 exponent is what keeps low power visibly moving instead of
   * crawling -- a linear map spends most of its range looking idle. Below 5 W
   * the rail dims and pauses rather than animating imperceptibly, and the sign
   * picks the direction, so the dashes run toward the pack while charging and
   * back toward the inverter while discharging.
   */
  _setRail(el, watts, max) {
    if (!el) return;
    const w = watts === null ? 0 : Math.abs(watts);
    const r = Math.max(0, Math.min(1, w / max));
    const dur = (2.4 - 2.1 * Math.pow(r, 0.55)).toFixed(2);
    const idle = w < 5;
    el.style.setProperty("--dur", dur + "s");
    el.style.setProperty("--op", idle ? ".2" : "1");
    el.style.setProperty("--play", idle ? "paused" : "running");
    el.style.setProperty("--dir", (watts || 0) < 0 ? "reverse" : "normal");
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
        const ent = node.getAttribute("data-ent");
        if (ent && this._hass) this._hass.callService("switch", "toggle", { entity_id: ent });
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

  // --- build ---------------------------------------------------------------

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._built) {
      this._build();
      this._refreshChart();
    }
    this._patch();
  }

  _tick() {
    if (!this._built) return;
    const el = this._el;
    if (el.clock) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      el.clock.textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    /*
     * The recorder backstop. _ingest carries the chart between polls, so this
     * only has to heal what the browser missed while nothing was telling it --
     * a gap left by a dropped socket or a suspended laptop.
     *
     * Staleness is read off the cached window's own timestamp rather than
     * counted in ticks: a background tab throttles setInterval to one firing a
     * minute, so counting sixty firings would be an hour and not a minute.
     * _stale() is false for all but one second in sixty, and _inflight keeps a
     * slow reply from being asked for again on the next tick.
     */
    if (el.chLine && !this._inflight.size && this._stale()) this._refreshChart();
  }

  /** A gauge track: hard stops at the percentages the bands actually fall on. */
  _trackCss(stops) {
    const parts = [];
    let from = 0;
    stops.forEach(([to, color]) => {
      parts.push(color + " " + from.toFixed(2) + "% " + to.toFixed(2) + "%");
      from = to;
    });
    return "linear-gradient(90deg," + parts.join(",") + ")";
  }

  /** The three meters, built from config so their tracks and ticks agree. */
  _meterSpecs() {
    const c = this._config;
    const cells = c.cells.length;
    const cellPct = (v) => this._cellPct(v);
    const amp = c.max_current_a;

    return [
      {
        key: "cap",
        label: "Capacity",
        more: c.soc,
        track: this._trackCss([[SOC_RED, TRACK_BAD], [SOC_GREEN, TRACK_WARN], [100, TRACK_OK]]),
        ticks: [["0", 0], [String(SOC_RED), SOC_RED], [String(SOC_GREEN), SOC_GREEN], ["100 %", 100]],
        mid: false,
      },
      {
        key: "amp",
        label: "Current flow",
        more: c.pack_current,
        /*
         * Mirrored about the centre: the same three bands either side of zero,
         * so a 160 A discharge is as red as a 160 A charge. The stops are at
         * 0.5 and 0.8 of the ceiling, which is where _currentColor changes.
         */
        track: this._trackCss([[10, TRACK_BAD], [25, TRACK_WARN], [75, TRACK_OK],
          [90, TRACK_WARN], [100, TRACK_BAD]]),
        ticks: [["−" + amp, 0], ["−" + (amp / 2), 25], ["0", 50],
          ["+" + (amp / 2), 75], ["+" + amp + " A", 100]],
        mid: true,
      },
      {
        key: "volt",
        label: "Pack voltage",
        more: c.pack_voltage,
        track: this._trackCss([
          [cellPct(CELL_BAD_LO), TRACK_BAD], [cellPct(CELL_WARN_LO), TRACK_WARN],
          [cellPct(CELL_WARN_HI), TRACK_OK], [cellPct(CELL_BAD_HI), TRACK_WARN],
          [100, TRACK_BAD]]),
        ticks: [
          [(CELL_BAD_LO * cells).toFixed(1), cellPct(CELL_BAD_LO)],
          [(CELL_WARN_LO * cells).toFixed(1), cellPct(CELL_WARN_LO)],
          [(CELL_WARN_HI * cells).toFixed(1), cellPct(CELL_WARN_HI)],
          [(CELL_BAD_HI * cells).toFixed(1) + " V", cellPct(CELL_BAD_HI)],
        ],
        mid: false,
      },
    ];
  }

  _build() {
    const c = this._config;
    const has = (b) => c.blocks.indexOf(b) >= 0;
    const cells = c.cells;
    const parts = [];

    /*
     * The controls live in the header row, beside the clock, and there is no
     * separate bar under the title any more.
     *
     * The bar said the same things twice. Its three buttons lit up for
     * "Charging", "Discharging" and "Balancer" while the pill above them
     * already spelled out "Discharging · balancing" in words, from the same
     * entities -- and neither of them said whether the pack was ACTUALLY doing
     * any of it, only whether the switch allowed it. One row now carries both:
     * the chip is the switch, the dot is the activity, and the sentence that
     * used to repeat them is gone.
     */
    if (has("header") || has("switches")) {
      const chips = !has("switches") ? "" : `
        <div class="chips">${SWITCHES.map((sw, i) => `
          <div class="chip" data-ref="chip${i}">
            <span class="ic" data-act="toggle" data-ent="${c[sw.cfg]}" role="button" tabindex="0"
                  aria-label="Toggle ${this._esc(sw.label)}"><ha-icon icon="${sw.icon}"></ha-icon></span>
            <span class="lbl" data-more="${c[sw.cfg]}" role="button" tabindex="0"
                  >${this._esc(sw.label)}</span>
            <span class="dw" data-act="toggle" data-ent="${c[sw.cfg]}" role="button" tabindex="0"
                  aria-label="Toggle ${this._esc(sw.label)}"><span class="dot" data-ref="dot${i}"></span></span>
          </div>`).join("")}
        </div>`;
      const clock = !has("header") ? "" : `
        <div class="pill"><span class="pclock" data-ref="clock"></span></div>`;
      parts.push(`
      <div class="head">
        ${!has("header") ? "<div></div>" : `<div>
          <div class="kicker">
            <span>${this._esc(c.chemistry)} · ${cells.length}S ${this._esc(String(c.pack_capacity_ah))}AH</span>
          </div>
          <div class="title">${this._esc(c.title)}</div>
        </div>`}
        <div class="tools">${chips}${clock}</div>
      </div>`);
    }

    if (has("pack")) {
      parts.push(`
      <div class="panel pack">
        <div class="plabel">Pack state</div>
        <div class="meters">${this._meterSpecs().map((m, i) => `
          <div class="meter" data-ref="meter${i}" data-more="${m.more}" role="button" tabindex="0">
            <div class="m-head">
              <span>${this._esc(m.label)}</span>
              <span data-ref="mState${i}"></span>
            </div>
            <div class="m-val">
              <b data-ref="mVal${i}"></b><i data-ref="mUnit${i}"></i>
            </div>
            <div class="m-sub" data-ref="mSub${i}"></div>
            <div class="track${m.mid ? " mid" : ""}" style="background:${m.track}">
              <div class="fill" data-ref="mFill${i}"></div>
            </div>
            <div class="ticks">${m.ticks.map(([t, p]) =>
              `<span class="${p <= 0 ? "l0" : p >= 100 ? "r0" : ""}"
                     style="${p > 0 && p < 100 ? "left:" + p.toFixed(2) + "%" : ""}">${this._esc(t)}</span>`
            ).join("")}</div>
          </div>`).join("")}
        </div>
      </div>`);
    }

    const flowPanel = !has("flow") ? "" : `
      <div class="panel flow">
        <div class="plabel">Live power flow</div>
        <div class="flowgrid">
          <div class="fcard" data-ref="busCard" data-more="${c.pack_power}" role="button" tabindex="0">
            <div class="rail" style="--c:${OK}" data-ref="railBus"></div>
            <div class="f-head">
              <span>Inverter · DC bus →</span>
              <span data-ref="busState"></span>
            </div>
            <div class="f-big"><b data-ref="busIn"></b><i>W in</i></div>
            <div class="f-small"><b data-ref="busOut"></b><i data-ref="busOutSub"></i></div>
            <div class="f-sub" data-ref="busSub"></div>
          </div>

          <div class="fcard" data-ref="packCard" data-more="${c.pack_voltage}" role="button" tabindex="0">
            <div class="rail" style="--c:${OK}" data-ref="railPack"></div>
            <div class="f-head">
              <span>→ Pack · ${cells.length}S</span>
              <span data-ref="packV"></span>
            </div>
            <div class="pack-row">
              <div class="pack-cells">${cells.map((id, i) => `
                <div class="pcell" data-more="${id}" role="button" tabindex="0"
                     data-ref="pcellWrap${i}"><i data-ref="pcell${i}"></i></div>`).join("")}
              </div>
              <div class="nub"></div>
            </div>
            <div class="f-sub" data-ref="packSub"></div>
          </div>
        </div>
      </div>`;

    const cellPanel = !has("cells") ? "" : `
      <div class="panel cells">
        <div class="c-head">
          <div>
            <div class="plabel">Cell voltages</div>
            <div class="c-title">Deviation from mean <span data-ref="cvMean"></span></div>
          </div>
          <div class="c-stats">
            <span data-ref="cvMinTip" data-more="${c.cell_min}" role="button" tabindex="0">MIN <b data-ref="cvMin"></b></span>
            <span data-ref="cvMaxTip" data-more="${c.cell_max}" role="button" tabindex="0">MAX <b data-ref="cvMax"></b></span>
            <span data-ref="cvDeltaTip" data-more="${c.cell_delta}" role="button" tabindex="0">Δ <b data-ref="cvDelta"></b></span>
          </div>
        </div>
        <div class="c-plot">
          <div class="c-yax">
            <span data-ref="cvAxTop"></span><span>0</span><span data-ref="cvAxBot"></span>
          </div>
          <div class="c-field">
            <div class="c-zero"></div>
            <div class="c-bars">${cells.map((id, i) => `
              <div class="c-bar" data-ref="cvBar${i}" data-more="${id}" role="button" tabindex="0">
                <div class="c-up"><i data-ref="cvUp${i}"></i></div>
                <div class="c-down"><i data-ref="cvDown${i}"></i></div>
              </div>`).join("")}
            </div>
          </div>
        </div>
        <div class="c-names">${cells.map((id, i) => `
          <div class="c-name" data-ref="cvName${i}" data-more="${id}" role="button" tabindex="0">
            <b data-ref="cvVolt${i}"></b><span>C${i + 1}</span>
          </div>`).join("")}
        </div>
      </div>`;

    const timingPanel = !has("timing") ? "" : `
      <div class="panel timing">
        <div class="plabel">Timing</div>
        <div class="tgrid">
          <div class="ttile" data-ref="ttfTile" data-more="${c.time_to_full}" role="button" tabindex="0">
            <b>Time to full</b>
            <div class="tline"><span data-ref="ttf"></span><i data-ref="ttfAt"></i></div>
          </div>
          <div class="ttile" data-ref="rtlTile" data-more="${c.runtime_left}" role="button" tabindex="0">
            <b>Runtime left</b>
            <div class="tline"><span data-ref="rtl"></span><i data-ref="rtlAt"></i></div>
          </div>
        </div>
      </div>`;

    const tempPanel = !has("temps") ? "" : `
      <div class="panel temps">
        <div class="plabel">Temperatures</div>
        <div class="trows">${[[c.temp_1_label, c.temp_1], [c.temp_2_label, c.temp_2]].map(([label, ent], i) => `
          <div class="trow" data-ref="trow${i}" data-more="${ent}" role="button" tabindex="0">
            <div class="th">
              <span class="tl">${this._esc(label)}</span>
              <span class="tv" data-ref="tVal${i}"></span>
            </div>
            <div class="track"><div class="fill" data-ref="tFill${i}"></div></div>
            <div class="ticks">
              <span class="l0">0</span>
              <span style="left:${(30 / TEMP_AXIS_HI * 100).toFixed(2)}%">30</span>
              <span class="r0">${TEMP_AXIS_HI} °C</span>
            </div>
          </div>`).join("")}
        </div>
      </div>`;

    /*
     * Four panels in ONE grid, rather than two columns each stacking their
     * own.
     *
     * Two independent stacks have no reason to line up and did not: Timing is
     * shorter than Live power flow, so Temperatures started partway up
     * Cell voltages and every horizontal edge on the right was a few pixels
     * off every edge on the left. Nothing was wrong with either column; they
     * simply never agreed on where a row was.
     *
     * Placed explicitly by class, so a panel that is switched off leaves its
     * cell empty instead of pulling the next one into the wrong half.
     *
     *      flow  | timing
     *      cells | temps
     */
    const left = flowPanel + cellPanel;
    const right = timingPanel + tempPanel;
    if (left || right) {
      // One column when a whole side is missing: a 2.1fr/1fr grid with an
      // empty cell leaves a third of the card blank.
      const one = !left || !right ? " one" : "";
      parts.push(`<div class="cols${one}">`
        + flowPanel + timingPanel + cellPanel + tempPanel
        + `</div>`);
    }

    if (has("history")) {
      const gy = [1, 2, 3].map((i) => {
        const y = (CH_PAD + i * (CH_H - CH_PAD * 2) / 4).toFixed(0);
        return `<line x1="0" x2="${CH_W}" y1="${y}" y2="${y}" stroke="${LINE3}"
                      stroke-width="1" vector-effect="non-scaling-stroke"></line>`;
      }).join("");
      parts.push(`
      <div class="panel hist">
        <div class="hhead">
          <div>
            <div class="plabel">History</div>
            <div class="hname">
              <span class="n" data-ref="chName" role="button" tabindex="0"></span>
              <span class="w" data-ref="chWin"></span>
            </div>
          </div>
          <div class="segs" data-ref="ranges">${Object.keys(RANGES).map((r) => `
            <button class="seg" data-act="range" data-val="${r}" aria-pressed="false">${r}</button>`).join("")}
          </div>
        </div>
        <div class="tabs" data-ref="tabs">${SERIES.map((s) => `
          <button class="tab" data-act="tab" data-val="${s.key}" aria-pressed="false"
                  style="--tc:${s.color}">${this._esc(s.short)}</button>`).join("")}
        </div>
        <div class="chart">
          <div class="yax" data-ref="yax"></div>
          <div class="plot" data-ref="plot">
            <svg class="ch" data-ref="chSvg" viewBox="0 0 ${CH_W} ${CH_H}" preserveAspectRatio="none">
              <defs><clipPath id="bcplotclip">
                <rect x="0" y="0" width="${CH_W}" height="${CH_H}"></rect>
              </clipPath></defs>
              ${gy}
              <g clip-path="url(#bcplotclip)">
                <path data-ref="chArea" stroke="none" fill-opacity="0.10"></path>
                <path data-ref="chLine" fill="none" stroke-width="1.6" vector-effect="non-scaling-stroke"
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

    parts.push(`<div class="foot">Tap any tile, cell or row to open its entity dialog.${
      has("history") ? " Drag the chart to move through time, pinch or scroll to zoom;"
        + " double-click or pick a range to go back to live." : ""}</div>`);

    this.shadowRoot.innerHTML = "<style>" + STYLE + "</style>"
      + '<ha-card><div class="root">' + parts.join("") + "</div></ha-card>";

    this._el = {};
    this.shadowRoot.querySelectorAll("[data-ref]").forEach((n) => {
      this._el[n.getAttribute("data-ref")] = n;
    });

    // The tooltips with no live state: a range is its name, a tab its series.
    if (this._el.ranges) {
      this._el.ranges.querySelectorAll(".seg").forEach((b) => {
        b.dataset.tip = this._tip(b.getAttribute("data-val"), "range");
      });
    }
    if (this._el.tabs) {
      this._el.tabs.querySelectorAll(".tab").forEach((b) => {
        const spec = this._spec(b.getAttribute("data-val"));
        b.dataset.tip = this._tip(spec.name, spec.help);
      });
    }

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
    this._syncSegs();
    // _tick guards on this flag, so it is set here rather than by the caller:
    // the clock and the recorder poll start the moment there is a DOM to
    // write into, not a second later.
    this._built = true;
    this._tick();
  }

  /** A whole tooltip: line 1 as given, then the static lines from HELP. */
  _tip(head, key) {
    return head + "\n" + HELP[key];
  }

  /** A value for line 1 of a tooltip, or the reason there is none. */
  _reading(v, dec, unit) {
    return v === null ? "no reading" : v.toFixed(dec) + " " + unit;
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
   * The rails are deliberately NOT behind it -- they are four property writes
   * each and they are what the panel is for.
   */
  _fingerprint() {
    const c = this._config;
    const ids = [
      c.soc, c.capacity_remaining, c.pack_voltage, c.pack_current, c.pack_power,
      c.cell_min, c.cell_max, c.cell_delta, c.temp_1, c.temp_2,
      c.time_to_full, c.runtime_left,
      c.charge_current, c.discharge_current, c.inverter_voltage,
      c.power_priority,
    ].concat(c.cells).concat(SWITCHES.map((s) => c[s.cfg]));
    return ids.map((id) => this._state(id)).join("|")
      + "|" + this._range + "|" + this._sel;
  }

  _patch() {
    const c = this._config;
    const el = this._el;

    // --- the rails, every time ---------------------------------------------
    const watts = this._num(c.pack_power);
    this._setRail(el.railBus, watts, c.max_power_w);
    this._setRail(el.railPack, watts, c.max_power_w);

    const print = this._fingerprint();
    if (print === this._print) return;
    const first = this._print === null;
    this._print = print;

    const soc = this._num(c.soc);
    const amps = this._num(c.pack_current);
    const volts = this._num(c.pack_voltage);
    const dir = this._dir();
    const cellCount = c.cells.length;
    const perCell = volts === null ? null : volts / cellCount;
    const socCol = this._socColor(soc);

    // --- controls ----------------------------------------------------------
    SWITCHES.forEach((sw, i) => {
      const chip = el["chip" + i];
      const dot = el["dot" + i];
      if (!chip || !dot) return;
      const st = this._state(c[sw.cfg]);
      const on = st === "on";
      chip.classList.toggle("on", on);

      const act = this._activity(sw.live, on);
      dot.classList.toggle("live", !!act);
      if (act) dot.style.setProperty("--dc", act.color);
      chip.dataset.tip = this._tip(this._name(c[sw.cfg], sw.label) + " — " + st
        + " · " + (act ? act.word : this._idleWord(sw.live, on)), sw.cfg);
    });

    // --- meters ------------------------------------------------------------
    if (el.mVal0) {
      // Capacity
      const cap = this._num(c.capacity_remaining);
      el.mState0.textContent = this._socLabel(soc);
      el.mState0.style.color = socCol;
      el.mVal0.textContent = this._fmt(soc, 0);
      el.mVal0.style.color = socCol;
      el.mUnit0.textContent = "%";
      // Raw, to the BMS's own resolution. Rounding this to a tenth hid the
      // only digits that change while you watch it.
      el.mSub0.textContent = this._fmt(cap, 3) + " / " + c.pack_capacity_ah.toFixed(3) + " Ah remaining";
      el.mFill0.style.left = "0%";
      el.mFill0.style.width = (soc === null ? 0 : Math.max(0, Math.min(100, soc))).toFixed(2) + "%";
      el.mFill0.style.background = socCol;
      if (el.meter0) {
        el.meter0.dataset.tip = this._tip("Capacity — " + (soc === null ? "no reading"
          : this._fmt(soc, 0) + " % · " + this._socLabel(soc)), "cap");
      }
    }

    if (el.mVal1) {
      // Current flow, anchored at the centre -- see the header note.
      const aCol = this._currentColor(amps);
      const cRate = amps === null ? null : Math.abs(amps) / c.pack_capacity_ah;
      // This meter keys off CURRENT, not power: it is the current sensor being
      // out that makes this meter unreadable, and "IDLE" over an em dash reads
      // as a measured zero.
      el.mState1.textContent = amps === null ? "NO DATA"
        : dir > 0 ? "CHG" : dir < 0 ? "DIS" : "IDLE";
      el.mState1.style.color = amps === null ? MUTED
        : dir > 0 ? OK : dir < 0 ? TXT2 : MUTED;
      el.mVal1.textContent = this._fmt(amps, 2);
      el.mVal1.style.color = aCol;
      el.mUnit1.textContent = "A";
      /*
       * Magnitude, not the signed value: the word before it already says the
       * direction, and "discharging at 0.16 C · -1200.0 W" states it twice,
       * the second time in a form that reads like a negative amount of work.
       * The C-rate is dropped entirely on an idle pack, where "at 0.00 C" is
       * three words for nothing.
       */
      el.mSub1.textContent = (amps === null ? "no reading"
          : dir > 0 ? "charging" : dir < 0 ? "discharging" : "idle")
        + (cRate ? " at " + cRate.toFixed(2) + " C" : "")
        + " · " + this._fmt(watts === null ? null : Math.abs(watts), 1) + " W";
      const half = amps === null ? 0
        : Math.max(-50, Math.min(50, amps / c.max_current_a * 50));
      el.mFill1.style.left = (half < 0 ? 50 + half : 50).toFixed(2) + "%";
      el.mFill1.style.width = Math.abs(half).toFixed(2) + "%";
      el.mFill1.style.background = aCol;
      if (el.meter1) {
        el.meter1.dataset.tip = this._tip("Current flow — " + (amps === null ? "no reading"
          : (amps > 0 ? "+" : "") + amps.toFixed(2) + " A · "
            + (dir > 0 ? "charging" : dir < 0 ? "discharging" : "idle")), "amp");
      }
    }

    if (el.mVal2) {
      // Pack voltage, banded on what one cell of it is doing.
      const vCol = this._cellColor(perCell);
      el.mState2.textContent = this._cellLabel(perCell);
      el.mState2.style.color = vCol;
      el.mVal2.textContent = this._fmt(volts, 3);
      el.mVal2.style.color = vCol;
      el.mUnit2.textContent = "V";
      el.mSub2.textContent = this._fmt(perCell, 3) + " V/cell · " + cellCount + "S · inverter reads "
        + this._fmt(this._num(c.inverter_voltage), 2) + " V";
      el.mFill2.style.left = "0%";
      el.mFill2.style.width = this._cellPct(perCell).toFixed(2) + "%";
      el.mFill2.style.background = vCol;
      if (el.meter2) {
        el.meter2.dataset.tip = this._tip("Pack voltage — " + (volts === null ? "no reading"
          : volts.toFixed(3) + " V · " + this._cellLabel(perCell)), "volt");
      }
    }

    // --- flow --------------------------------------------------------------
    const cells = this._cellVolts();
    const known = cells.filter((v) => v !== null);
    const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
    /*
     * DRIFT IS MEASURED AGAINST THE MEDIAN, NOT THE MEAN, AND THAT IS THE POINT.
     *
     * One cell 190 mV above its neighbours drags the mean of eight up by 24 mV
     * -- past the 20 mV tolerance -- so every healthy cell in the pack reads as
     * drifting and the card says "8 cells out of tolerance" about a pack with
     * one bad cell. The median does not move: seven cells agree, it sits on
     * them, and the outlier is the only thing that stands out.
     *
     * The CHART still plots deviation from the mean, because that is what its
     * heading says it plots. This is the tolerance TEST, and it is a different
     * question -- which cell disagrees with the others.
     */
    const ranked = known.slice().sort((a, b) => a - b);
    const median = ranked.length
      ? (ranked.length % 2
        ? ranked[(ranked.length - 1) / 2]
        : (ranked[ranked.length / 2 - 1] + ranked[ranked.length / 2]) / 2)
      : null;
    // In whole millivolts: 3.32 - 3.30 is 0.020000000000000018 in floats, and a
    // cell exactly on the 20 mV line is within tolerance, as _deltaColor says.
    const drifting = (v) => v !== null && median !== null
      && Math.round(Math.abs(v - median) * 1000) > Math.round(DELTA_WARN * 1000);

    if (el.busIn) {
      const inW = watts === null ? null : Math.max(0, watts);
      const outW = watts === null ? null : Math.max(0, -watts);
      el.busState.textContent = watts === null ? "NO DATA"
        : dir > 0 ? "CHARGING" : dir < 0 ? "DISCHARGING" : "IDLE";
      el.busState.style.color = watts === null ? MUTED
        : dir > 0 ? OK : dir < 0 ? TXT2 : MUTED;
      el.busIn.textContent = this._fmt(inW, 1);
      el.busIn.style.color = dir > 0 ? OK : MUTED;
      el.busOut.textContent = this._fmt(outW, 1);
      el.busOut.style.color = dir < 0 ? TXT : MUTED;
      // The inverter's own current, where it has one -- it is the meter that
      // sits between the AC side and this bus, and it disagrees sometimes.
      const iAmps = dir > 0 ? this._num(c.charge_current)
        : dir < 0 ? this._num(c.discharge_current) : null;
      el.busOutSub.textContent = "W out"
        + (iAmps ? " · inverter " + this._fmt(iAmps, 1) + " A" : " · DC load idle");
      el.busSub.textContent = String(this._state(c.power_priority)).toLowerCase()
        + " · " + (this._state(c[SWITCHES[0].cfg]) === "on" ? "AC charge" : "AC charge off");
      if (el.busCard) {
        el.busCard.dataset.tip = this._tip("DC bus — " + (watts === null ? "no reading"
          : (dir > 0 ? "charging" : dir < 0 ? "discharging" : "idle") + " · "
            + Math.abs(watts).toFixed(1) + " W"), "bus");
      }
    }

    if (el.packV) {
      const vCol = this._cellColor(perCell);
      el.packV.textContent = this._fmt(volts, 3) + " V";
      el.packV.style.color = vCol;
      // Lit while current is moving: the tile is the live end of the rail.
      if (el.packCard) el.packCard.classList.toggle("lit", dir !== 0);

      let out = 0;
      cells.forEach((v, i) => {
        const bar = el["pcell" + i];
        if (!bar) return;
        const col = this._cellColor(v);
        const drift = drifting(v);
        bar.style.height = this._cellPct(v).toFixed(2) + "%";
        bar.style.background = drift && col === OK ? WARN : col;
        // A cell whose sensor is unavailable has not failed a tolerance test,
        // it has failed to answer. Counting it as out of tolerance would say
        // something about the pack that nothing measured.
        if (v !== null && (col !== OK || drift)) out++;
        const wrap = el["pcellWrap" + i];
        if (wrap) wrap.dataset.tip = this._tip("C" + (i + 1) + " — " + this._reading(v, 3, "V"), "cell");
      });
      const tolerance = !known.length ? "no cell data"
        : out ? out + (out === 1 ? " cell" : " cells") + " out of tolerance"
              : "all within tolerance";
      el.packSub.textContent = cellCount + " cells in series · " + tolerance;
      if (el.packCard) {
        el.packCard.dataset.tip = this._tip("Pack — " + this._reading(volts, 3, "V") + " · " + tolerance, "pack");
      }
    }

    // --- cell deviation ----------------------------------------------------
    if (el.cvMean) {
      const dv = this._num(c.cell_delta);
      el.cvMean.textContent = this._fmt(mean, 4) + " V";
      el.cvMin.textContent = this._fmt(this._num(c.cell_min), 3) + " V";
      el.cvMax.textContent = this._fmt(this._num(c.cell_max), 3) + " V";
      el.cvDelta.textContent = dv === null ? "—" : (dv * 1000).toFixed(1) + " mV";
      el.cvDelta.style.color = this._deltaColor(dv);
      if (el.cvMinTip) {
        el.cvMinTip.dataset.tip = this._tip("Lowest cell — " + this._reading(this._num(c.cell_min), 3, "V"), "cellMin");
        el.cvMaxTip.dataset.tip = this._tip("Highest cell — " + this._reading(this._num(c.cell_max), 3, "V"), "cellMax");
        el.cvDeltaTip.dataset.tip = this._tip("Cell spread — "
          + this._reading(dv === null ? null : dv * 1000, 1, "mV"), "cellDelta");
      }

      /*
       * The axis follows the pack rather than being fixed, because a balanced
       * pack drifts by a millivolt and an unbalanced one by fifty -- one scale
       * cannot show both. It snaps to a round number so the label stays
       * readable, and never goes below 3 mV: a pack that is perfectly level
       * would otherwise amplify its own rounding noise to full height.
       */
      let maxDev = 0;
      cells.forEach((v) => {
        if (v !== null && mean !== null) maxDev = Math.max(maxDev, Math.abs(v - mean) * 1000);
      });
      /*
       * Rounded to a tenth of a millivolt BEFORE the axis is picked, and that
       * is not cosmetic. The BMS reports whole millivolts, but it reports them
       * as floats: eight cells a millivolt apart give a mean that lands on
       * 3.36400001 and a spread that comes out of the subtraction as 3.0001 mV,
       * not 3. Unrounded, `3 >= maxDev` is false, the axis jumps to 5 mV, and
       * the tightest pack there is draws every bar at 60% of its true height.
       */
      const spread = Math.round(maxDev * 10) / 10;
      const axis = [3, 5, 10, 20, 50, 100, 200, 500].find((n) => n >= spread) || 1000;
      el.cvAxTop.textContent = "+" + axis + " mV";
      el.cvAxBot.textContent = "−" + axis + " mV";

      cells.forEach((v, i) => {
        const up = el["cvUp" + i];
        const down = el["cvDown" + i];
        const volt = el["cvVolt" + i];
        if (!up || !down) return;
        const dev = v === null || mean === null ? null : (v - mean) * 1000;
        // A floor of 4%, so a cell that is exactly on the mean still draws a
        // mark. A bar of zero height reads as a missing cell.
        const pct = dev === null ? 0
          : Math.max(4, Math.min(100, Math.round(Math.abs(dev) * 10) / 10 / axis * 100));
        const col = dev === null ? MUTED
          : drifting(v) ? WARN : this._cellColor(v);
        up.style.height = (dev !== null && dev >= 0 ? pct : 0).toFixed(2) + "%";
        down.style.height = (dev !== null && dev < 0 ? pct : 0).toFixed(2) + "%";
        up.style.background = col;
        down.style.background = col;
        if (volt) {
          volt.textContent = this._fmt(v, 3);
          volt.style.color = col === OK ? TXT : col;
        }
        const bar = el["cvBar" + i];
        if (bar) {
          // Rounded before the sign is read, or float noise prints "−0.0".
          const mv = dev === null ? null : Math.round(dev * 10) / 10;
          bar.dataset.tip = this._tip("C" + (i + 1) + " — " + (mv === null ? "no reading"
            : (mv < 0 ? "−" : "+") + Math.abs(mv).toFixed(1) + " mV from the mean"), "cellDev");
        }
        const name = el["cvName" + i];
        if (name) name.dataset.tip = this._tip("C" + (i + 1) + " — " + this._reading(v, 3, "V"), "cell");
      });
    }

    // --- timing ------------------------------------------------------------
    if (el.ttf) {
      const f = this._hours(c.time_to_full);
      el.ttf.textContent = f.text;
      // Green only while it is actually counting down to something.
      const charging = f.known && dir > 0;
      el.ttf.style.color = charging ? OK : MUTED;
      const r = this._hours(c.runtime_left);
      el.rtl.textContent = r.text;
      const draining = r.known && dir < 0;
      el.rtl.style.color = draining ? OK : MUTED;

      /*
       * The clock line, and only in the direction that is happening.
       *
       * "Full at 14:35" while the pack is discharging is not a forecast, it
       * is arithmetic on a number that stopped meaning anything the moment
       * the current changed sign -- the sensor keeps publishing its last
       * estimate and the card would dress it up as a time. A duration greyed
       * out reads as stale; a CLOCK TIME greyed out reads as a plan.
       */
      // No "full"/"empty" prefix: the tile's own label already says which
      // event this is, and on one line the word only pushed the time away
      // from the edge it is aligned to.
      const when = (on, ent) => (on ? this._clockAfter(this._num(ent)) : "");
      if (el.ttfAt) el.ttfAt.textContent = when(charging, c.time_to_full);
      if (el.rtlAt) el.rtlAt.textContent = when(draining, c.runtime_left);
      const at = (t) => (t && t.textContent ? " · " + t.textContent : "");
      if (el.ttfTile) el.ttfTile.dataset.tip = this._tip("Time to full — " + f.text + at(el.ttfAt), "ttf");
      if (el.rtlTile) el.rtlTile.dataset.tip = this._tip("Runtime left — " + r.text + at(el.rtlAt), "rtl");
    }

    // --- temperatures ------------------------------------------------------
    [c.temp_1, c.temp_2].forEach((ent, i) => {
      const val = el["tVal" + i];
      if (!val) return;
      const t = this._num(ent);
      const col = this._tempColor(t);
      val.textContent = this._fmt(t, 1) + " °C";
      val.style.color = col;
      el["tFill" + i].style.width = this._pct(t, 0, TEMP_AXIS_HI).toFixed(2) + "%";
      el["tFill" + i].style.background = col;
      const row = el["trow" + i];
      if (row) {
        row.dataset.tip = this._tip((i ? c.temp_2_label : c.temp_1_label) + " — "
          + this._reading(t, 1, "°C"), "temp");
      }
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

  /** The recorder's number as this chart draws it -- see the header on `mul`. */
  _scale(spec, raw) {
    return spec.mul ? raw * spec.mul : raw;
  }

  /**
   * The colour a series is drawn in: its band's colour where it has one, its
   * own identity colour where it has none.
   *
   * The band reads the SAME entity the meter does, which is the point -- a
   * chart in one green and a meter in another, drawn from one sensor, is a
   * reader's problem to resolve and there is nothing to resolve. Pack voltage
   * is the one that has to be said out loud: the meter bands on volts PER
   * CELL, so the series does too, not on the pack total it plots.
   */
  _seriesColor(spec) {
    const c = this._config;
    if (spec.band === "soc") return this._socColor(this._num(c.soc));
    if (spec.band === "cap") {
      const ah = this._num(c.capacity_remaining);
      return this._socColor(ah === null ? null : ah / c.pack_capacity_ah * 100);
    }
    if (spec.band === "pack") {
      const v = this._num(c.pack_voltage);
      return this._cellColor(v === null ? null : v / c.cells.length);
    }
    if (spec.band === "delta") return this._deltaColor(this._num(c.cell_delta));
    if (spec.band === "temp") return this._tempColor(this._num(c[spec.cfg]));
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
   * squashing it. Landing on now re-arms `follow`, so dragging back to the
   * right edge is how you rejoin the live chart without reaching for the
   * presets.
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
   * Wheel zooms, and takes the event: over a 230px plot the alternative is a
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
   * frozen line and a frozen Now/Min/Max/Mean row, sitting under meters that
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

      rec.pts.push([t, this._scale(spec, v)]);
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
          raw = this._parseStats(stats, entity, spec);
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
          raw = this._parse(reply, entity, spec);
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
  _parseStats(reply, entity, spec) {
    const rows = reply && reply[entity];
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      if (!r) continue;
      const v = parseFloat(r.mean);
      if (!Number.isFinite(v)) continue;
      const t = typeof r.start === "number" ? r.start : Date.parse(r.start);
      if (Number.isFinite(t)) out.push([t, this._scale(spec, v)]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  /**
   * The reply shape has moved around between HA releases, so read both: the
   * compact form is {entity_id: [{s, lu}, ...]} with `lu` in epoch SECONDS,
   * the older one carries {state, last_updated} ISO strings.
   */
  _parse(reply, entity, spec) {
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
      if (t) out.push([t, this._scale(spec, v)]);
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
     * but the AXIS is not allowed to be set by a single bad sample. One 0 V
     * blip in a day of 26.9 V pack squeezes everything else into 8% of the plot
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
    el.chName.dataset.tip = this._tip(spec.name, "chart");
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
     * redraws through this function alone: a cell delta crossing 20 mV between
     * two recorder polls has to take the line, the fill, the readout and the
     * tab pill with it at the moment the panel above changes colour.
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

    const raw = this._num(this._config[spec.cfg]);
    const now = raw === null ? null : this._scale(spec, raw);
    const mean = this._mean(pts);
    el.stats.innerHTML = [
      ["Now", now === null ? pts[pts.length - 1][1] : now],
      ["Min", p.min], ["Max", p.max], ["Mean", mean],
    ].map(([label, v]) => {
      const val = v.toFixed(spec.dec) + " " + spec.unit;
      const tip = this._tip(label + " — " + val, "stat_" + label.toLowerCase());
      return "<div class='stat' data-tip=\"" + this._esc(tip) + "\"><b>" + label + "</b><span>"
        + this._esc(val) + "</span></div>";
    }).join("");

    /*
     * _hideHover above cleared a readout the cursor is still sitting on, so
     * put it back against the series just drawn.
     *
     * The alternative was to hold the redraw back until the pointer left,
     * which is the freeze this whole design is about: a cursor parked on the
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

if (!customElements.get(CARD)) customElements.define(CARD, JkbmsBatteryConsoleCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "JK BMS Battery Console",
    description: "Pack state, cell balance, temperatures and history for the JK BMS LiFePO4 pack.",
    preview: false,
    documentationURL: "https://github.com/",
  });
}

console.info("%c " + CARD + " %c v" + VERSION + " ",
  "background:#0f1613;color:#589569;border-radius:3px 0 0 3px",
  "background:#589569;color:#0f1613;border-radius:0 3px 3px 0");
