/**
 * Climate console card.
 *
 * Draws all three tabs of the Climate dashboard: the room sensors, the hall
 * A/C (infrared, write-only) and the bedroom A/C (local network, two-way).
 * One element, three layouts, chosen by `tab:` -- see TABS. Registered as a
 * Lovelace resource, so it is handed `hass` directly: no token, no iframe,
 * no CORS.
 *
 * WHY THIS IS NOT A STACK OF STOCK CARDS
 * --------------------------------------
 * What it replaces was one `history-graph` with six entities on it and
 * nothing else -- three temperatures and three humidities sharing one axis,
 * so the humidity traces sat at 50 and flattened every temperature into a
 * band a few pixels tall. Neither A/C was on the dashboard at all.
 *
 * Stock cards cannot draw the rest of it. The `thermostat` card has one dial
 * and no room for the eleven readouts the bedroom unit publishes or the ten
 * meter-derived tiles the hall one does; the hall's whole point -- that every
 * control is a belief and only the meter is a measurement -- has nowhere to
 * live on it. A layout that says that needs `style`, and every shortcut to
 * one is absent on this box: card-mod, button-card and mushroom are not
 * installed, HACS carries no frontend cards here, and HA sanitises markdown
 * through filterXSS (frontend/src/resources/markdown-worker.ts) whose
 * allowlist has no `style` attribute and no <style> tag. A custom element has
 * its own shadow root and none of those limits. Same reasoning and the same
 * shape as dtek-shutdowns-card.js, powmr-inverter-console-card.js and
 * jkbms-battery-console-card.js.
 *
 * THE TAB BAR IS HOME ASSISTANT'S, NOT THIS CARD'S
 * ------------------------------------------------
 * The design draws its own header and tab strip. Here each tab is a Lovelace
 * VIEW holding one instance of this card, exactly as the Power station
 * dashboard splits Inverter and Battery -- so the strip is HA's real one,
 * which keeps the URL, the back button and the sidebar working. Nothing in
 * here paints a hamburger or a title bar.
 *
 * WHAT IS MEASURED AND WHAT IS BELIEVED
 * -------------------------------------
 * The single most important thing this card has to communicate, and the
 * reason the two A/C tabs look different from each other:
 *
 *   HALL     -- infrared, write-only. Mode, setpoint, fan and swing are
 *               records of what was transmitted. Only three values are real:
 *               the two ambient readings (from the Aqara sensor in the room)
 *               and the activity, which irbridge_ac_energy.yaml derives from
 *               the plug meter on the A/C circuit. The drift banner is what
 *               names the disagreement out loud; see binary_sensor.a_c_drift.
 *   BEDROOM  -- midea_ac_lan over the LAN, full feedback. Every value on that
 *               tab is a reading, which is why it is the tab that carries
 *               coil and discharge-pipe temperatures and a compressor
 *               frequency, and why it can go `unavailable` as a whole. It
 *               does, often -- the unit drops off the network when its plug
 *               is cut. That is a state the tab draws, not a bug.
 *
 * So the hall tab says "last sent" on its controls and the bedroom tab does
 * not. Removing that distinction would make the hall tab lie.
 *
 * THREE DELIBERATE DEPARTURES FROM THE DESIGN
 * -------------------------------------------
 *   1. The design's "Filter - 4.7 h/day -> Clean in 19 d" row has no entity
 *      behind it and no way to acquire one: there is no runtime counter on
 *      the filter and no service-hours input. It is replaced by the bridge's
 *      assumed state, which is real, and which is the other half of the drift
 *      story already on that tab.
 *   2. The design's per-room "Today min / max" is drawn from a separate
 *      midnight-to-now window rather than from the chart's, so switching the
 *      chart to 30 d does not silently change what "today" means.
 *   3. The design draws the target line as a flat dashed line at the current
 *      setpoint. This fetches the climate entity's `temperature` ATTRIBUTE
 *      history instead, so a setpoint changed three hours ago shows as a step
 *      where it happened. It falls back to the flat line when the recorder
 *      has no attribute rows -- which is what a fresh database looks like.
 *
 * TWO THINGS THAT WILL WASTE YOUR AFTERNOON
 *
 *   1. Bump VERSION below on EVERY edit to this file, then re-register it.
 *      The browser caches an ES module hard and you will be debugging the new
 *      card while looking at the old one. The resource URL's ?v= IS the
 *      VERSION -- MAJOR.MINOR.PATCH, see "Versions" in the top-level README --
 *      and --card reads it from this file rather than trusting a typed one:
 *
 *        python HomeAssistant/tools/ha_dashboard.py --card climate-console-card.js
 *
 *   2. `set hass` fires on every state change across all ~331 entities on
 *      this box. _build() runs once and _patch() only writes textContent and
 *      inline styles, for the same reason the inverter card does: rebuilding
 *      the DOM would restart the dial's CSS transition, so the arc would snap
 *      back to zero several times a minute. The one thing that DOES force a
 *      rebuild is a changed option list -- see _optKey.
 */

const CARD = "climate-console-card";
const VERSION = "1.1.1";

const TABS = ["rooms", "hall", "bedroom"];

/* --- palette ---------------------------------------------------------------
 *
 * The design's own values, literal. They are not themed for the same reason
 * the inverter card's are not: every accent below is paired with a background
 * mixed against it by hand, and a theme reassigning one half leaves a number
 * sitting on a ground that disagrees with it.
 */
const BG = "#0f1214";
const PANEL = "#1a1e21";
const WELL = "#15191c";
const INPUT_BG = "#171b1e";
const INPUT_EDGE = "#2a3035";
const BTN_BG = "#1d2225";
const BTN_EDGE = "#33393f";
const EDGE = "#262b30";
const HAIR = "#23282c";
const TXT = "#e8eaed";
const TXT2 = "#c9ced3";
const MUTED = "#9aa0a6";
const DIM = "#7d838a";

const OK = "#5bd48a";
const WARN = "#e3b341";
const BAD = "#f2664a";

/*
 * One accent per thing the unit can be DOING -- not per mode it was set to.
 * Cooling is blue, heating orange, drying violet, fan teal; idle and off are
 * grey, because "on but not working" is the state people misread as broken.
 * The hero's background is mixed against the same hue, so the dial, the badge
 * and the ground never disagree.
 */
const ACC = {
  cooling: { c: "#38b6ff", soft: "#0e2f42", glow: "#38b6ff66",
    bg: "radial-gradient(130% 150% at 12% -10%, #10405c 0%, #14202a 45%, #14181b 100%)",
    ghost: "radial-gradient(130% 150% at 12% -10%, #14313f 0%, #151c22 45%, #131619 100%)" },
  heating: { c: "#ff9b45", soft: "#3a2410", glow: "#ff9b4566",
    bg: "radial-gradient(130% 150% at 12% -10%, #5a3010 0%, #2a1e17 45%, #14181b 100%)",
    ghost: "radial-gradient(130% 150% at 12% -10%, #3a2412 0%, #1f1a17 45%, #131619 100%)" },
  drying: { c: "#a78bfa", soft: "#291f47", glow: "#a78bfa55",
    bg: "radial-gradient(130% 150% at 12% -10%, #33265e 0%, #1e1b2a 45%, #14181b 100%)",
    ghost: "radial-gradient(130% 150% at 12% -10%, #241d3e 0%, #191822 45%, #131619 100%)" },
  fan: { c: "#4ad6c0", soft: "#0f3733", glow: "#4ad6c055",
    bg: "radial-gradient(130% 150% at 12% -10%, #114a43 0%, #152422 45%, #14181b 100%)",
    ghost: "radial-gradient(130% 150% at 12% -10%, #133430 0%, #151e1e 45%, #131619 100%)" },
  idle: { c: "#9aa0a6", soft: "#23282c", glow: "#9aa0a633",
    bg: "linear-gradient(180deg, #1d2226 0%, #14181b 100%)",
    ghost: "linear-gradient(180deg, #1d2226 0%, #14181b 100%)" },
  off: { c: "#7d838a", soft: "#1f2428", glow: "#00000000",
    bg: "linear-gradient(180deg, #191d20 0%, #131619 100%)",
    ghost: "linear-gradient(180deg, #191d20 0%, #131619 100%)" },
};

/*
 * The hue a unit's CONTROLS are drawn in, from the mode it is SET to.
 *
 * Two accents, not one, and the split is the whole point. What the unit is
 * DOING grounds the hero -- a unit set to Cool and drawing 3 W is idle, and
 * a blue background would say otherwise. But a feature switch that is ON has
 * to look on whether or not the compressor happens to be running: an off
 * unit painted the design's grey leaves `Sound` and `Ionizer` reading
 * exactly like the eleven switches that are off, which is the one thing a
 * grid of toggles exists to tell apart.
 *
 * So the switches, the pills and the segments take their colour from the
 * mode instead. While the unit works the two accents ARE the same object and
 * nothing here is any different from the design.
 */
const MODE_ACC = {
  cool: "cooling", heat: "heating", dry: "drying", fan_only: "fan",
  auto: "cooling", heat_cool: "cooling",
};
const ACC_UNKNOWN = {
  c: "#5c616b", soft: "#1c2024", glow: "#00000000",
  bg: "linear-gradient(180deg, #17191c 0%, #121517 100%)",
};

/*
 * Room hues. These identify a SERIES: the dot on the room card, the line on
 * both charts and the swatch in both legends are the same colour, which is
 * the only thing tying three unlabelled traces to three cards above them.
 */
const ROOM_C = { living: "#4d8ef7", bedroom: "#e3b341", kitchen: "#f2664a" };

const DEFAULTS = {
  tab: "rooms",

  // --- room sensors (Aqara, over Zigbee2MQTT) ------------------------------
  living_temp: "sensor.0xa4c13858c97f07f8_temperature",
  living_hum: "sensor.0xa4c13858c97f07f8_humidity",
  bedroom_temp: "sensor.0xa4c138437ae3f5a6_temperature",
  bedroom_hum: "sensor.0xa4c138437ae3f5a6_humidity",
  kitchen_temp: "sensor.0xa4c1383900dd497c_temperature",
  kitchen_hum: "sensor.0xa4c1383900dd497c_humidity",

  // --- hall A/C: the IR bridge ---------------------------------------------
  hall_climate: "climate.daewoo_a_c",
  hall_activity: "sensor.a_c_activity",
  hall_action: "sensor.a_c_hvac_action",
  hall_assumed: "sensor.a_c_assumed_state",
  hall_bridge: "binary_sensor.ir_bridge_online",
  hall_running: "binary_sensor.a_c_running",
  hall_compressor: "binary_sensor.a_c_compressor",
  hall_drift: "binary_sensor.a_c_drift",
  hall_power_now: "sensor.0x70b3d52b600fddcb_power",
  hall_plug_switch: "switch.0x70b3d52b600fddcb",
  hall_avg_draw: "sensor.a_c_average_draw_today",
  hall_energy_today: "sensor.a_c_energy_today",
  hall_energy_month: "sensor.a_c_energy_this_month",
  hall_cost_today: "sensor.a_c_cost_today",
  hall_cost_month: "sensor.a_c_cost_this_month",
  hall_runtime_today: "sensor.a_c_runtime_today",
  hall_compressor_hours: "sensor.a_c_compressor_hours_today",
  hall_compressor_cycles: "sensor.a_c_compressor_cycles_today",
  hall_setpoint_delta: "sensor.a_c_setpoint_delta",
  hall_standby_watts: "input_number.irbridge_ac_standby_watts",
  hall_compressor_watts: "input_number.irbridge_ac_compressor_watts",
  hall_script_resend: "script.irbridge_ac_resend",
  hall_script_swing_step: "script.irbridge_ac_swing_step",
  hall_script_swing_toggle: "script.irbridge_ac_swing_force_toggle",

  // --- bedroom A/C: midea_ac_lan -------------------------------------------
  bed_climate: "climate.153931629566331_climate",
  bed_fan_fine: "number.153931629566331_fan_speed",
  bed_indoor_temp: "sensor.153931629566331_indoor_temperature",
  bed_indoor_hum: "sensor.153931629566331_indoor_humidity",
  bed_outdoor_temp: "sensor.153931629566331_outdoor_temperature",
  bed_compressor_freq: "sensor.153931629566331_compressor_frequency",
  bed_fan_rpm: "sensor.153931629566331_indoor_fan_speed",
  bed_error: "sensor.153931629566331_error_code",
  bed_indoor_ambient: "sensor.153931629566331_indoor_ambient_temperature",
  bed_indoor_coil: "sensor.153931629566331_indoor_coil_temperature",
  bed_outdoor_coil: "sensor.153931629566331_outdoor_coil_temperature",
  bed_outdoor_ambient: "sensor.153931629566331_outdoor_ambient_temperature",
  bed_discharge_pipe: "sensor.153931629566331_discharge_pipe_temperature",

  // --- bedroom A/C: the plug-derived half, bedroom_ac_energy.yaml ----------
  bed_activity: "sensor.bedroom_a_c_activity",
  bed_action: "sensor.bedroom_a_c_hvac_action",
  bed_running: "binary_sensor.bedroom_a_c_running",
  bed_compressor: "binary_sensor.bedroom_a_c_compressor",
  bed_avg_draw: "sensor.bedroom_a_c_average_draw_today",
  bed_energy_today: "sensor.bedroom_a_c_energy_today",
  bed_energy_month: "sensor.bedroom_a_c_energy_this_month",
  bed_cost_today: "sensor.bedroom_a_c_cost_today",
  bed_cost_month: "sensor.bedroom_a_c_cost_this_month",
  bed_runtime_today: "sensor.bedroom_a_c_runtime_today",
  bed_compressor_hours: "sensor.bedroom_a_c_compressor_hours_today",
  bed_compressor_cycles: "sensor.bedroom_a_c_compressor_cycles_today",
  bed_setpoint_delta: "sensor.bedroom_a_c_setpoint_delta",
  bed_standby_watts: "input_number.bedroom_ac_standby_watts",
  bed_compressor_watts: "input_number.bedroom_ac_compressor_watts",

  // --- the two-zone tariff, shared: ac_tariffs.yaml ------------------------
  tariff_zone: "sensor.electricity_tariff_zone",
  tariff_now: "sensor.electricity_tariff_now",
  tariff_day: "input_number.electricity_tariff_day",
  tariff_night: "input_number.electricity_tariff_night",

  // --- bedroom metered plug (Zigbee) ---------------------------------------
  plug_switch: "switch.0xa4c13820fe9ec412",
  plug_power: "sensor.0xa4c13820fe9ec412_power",
  plug_current: "sensor.0xa4c13820fe9ec412_current",
  plug_voltage: "sensor.0xa4c13820fe9ec412_voltage",
  plug_energy: "sensor.0xa4c13820fe9ec412_energy",
  plug_child_lock: "switch.0xa4c13820fe9ec412_child_lock",
  plug_countdown: "number.0xa4c13820fe9ec412_countdown",
  plug_outage_memory: "select.0xa4c13820fe9ec412_power_outage_memory",
  plug_indicator: "select.0xa4c13820fe9ec412_indicator_mode",
};

/*
 * The unit's feature switches, in the order the design lists them. The prefix
 * is the Midea appliance id and is shared by every entity on that device, so
 * one constant rewrites all of them rather than a config key each doing it
 * one at a time.
 *
 * Four of the unit's switches are deliberately absent, for two different
 * reasons, and docs/ac-features.md keeps both lists so the inventory stays
 * complete while the grid stays short.
 *
 * `Fresh air` has no entity at all: the unit supports it, this installation
 * has it switched off, and midea_ac_lan then creates nothing. It used to be
 * drawn dashed and dimmed to say "this exists and you cannot have it here",
 * and every reader read that as a broken tile instead. It is in the doc's
 * `unexposed` list.
 *
 * `Aux heating`, `Comfort mode` and `Sound` DO have entities and do work.
 * They are off the grid because they are not wanted here, not because they
 * are broken -- so they are in the doc's `hidden` list, and putting any of
 * them back is one line. A grid earns its space by what someone reaches for.
 */
const BED_SWITCH_PREFIX = "switch.153931629566331_";
const BED_FEATURES = [
  ["Boost mode", "boost_mode"],
  ["Eco mode", "eco_mode"],
  ["Sleep mode", "sleep_mode"],
  ["Dry", "dry"],
  ["Frost protect", "frost_protect"],
  ["Self clean", "self_clean"],
  ["Ionizer", "anion"],
  ["Screen display", "screen_display"],
  ["Screen display alternate", "screen_display_alternate"],
  ["Prompt tone", "prompt_tone"],
];

/*
 * Mode and fan ids differ between the two units -- the MQTT climate entity
 * speaks SmartIR's vocabulary (`mid`, `heat_cool`), midea_ac_lan speaks its
 * own (`medium`, `auto`) -- so labels are looked up rather than title-cased.
 * An id with no entry here falls through to its own name, which is how a new
 * mode appears as a usable button instead of vanishing.
 */
const MODE_LABEL = {
  cool: "Cool", heat: "Heat", auto: "Auto", heat_cool: "Auto",
  fan_only: "Fan only", dry: "Dry", off: "Off",
  cooling: "Cooling", heating: "Heating", drying: "Drying",
  fan: "Fan", idle: "Idle",
};
const FAN_LABEL = {
  silent: "Silent", low: "Low", mid: "Medium", medium: "Medium",
  high: "High", full: "Full", auto: "Auto",
};
const SWING_LABEL = {
  off: "Off", on: "On", vertical: "Vertical",
  horizontal: "Horizontal", both: "Both",
};

/*
 * Fallback option lists, used only when the entity is unavailable AND the
 * registry has not kept its attributes -- which is what a restart into a
 * dropped-off unit looks like. Without these the bedroom tab would draw a
 * hero with no buttons at all and read as broken rather than as offline.
 * They match the Bedroom "Feature toggles" table in docs/ac-features.md.
 */
const FALLBACK = {
  hall: {
    modes: ["cool", "heat", "heat_cool", "fan_only", "dry"],
    fans: ["low", "mid", "high"],
    swings: ["off", "on"], min: 18, max: 30, step: 1,
  },
  bed: {
    modes: ["auto", "cool", "heat", "dry", "fan_only"],
    fans: ["silent", "low", "medium", "high", "full", "auto"],
    swings: ["off", "vertical", "horizontal", "both"],
    min: 16, max: 30, step: 0.5,
  },
};

/*
 * Modes in which a unit ignores the setpoint entirely.
 *
 * The bedroom unit in `fan_only` drops every set_temperature on the floor: it
 * does not clamp the value, does not answer with one of its own, it simply
 * keeps the setpoint it had. Measured against the live unit, each value sent
 * and then watched for 15-30s:
 *
 *              fan_only        cool
 *      16.0    ignored         taken, held
 *      16.5    ignored         taken, held
 *      17.0    ignored         taken, held
 *
 * which is the unit being reasonable -- a fan has no temperature to aim at --
 * and the card being dishonest about it. min_temp stays 16.0 in `fan_only`,
 * `supported_features` still claims TARGET_TEMPERATURE, so the "-" drew itself
 * live, took the press, moved the number, and then lost it again when SENT_TTL
 * handed the entity's unchanged reading back. That reads as a button that
 * works sometimes. It never worked in this mode.
 *
 * So the steps and the ring go inert here and the banner says why. `dry`,
 * `heat` and `auto` are NOT measured and are deliberately not listed: guessing
 * a mode into this list disables a control that may well work.
 *
 * The hall unit is infrared and never answers anything, so nothing about it
 * can be measured this way and it is not listed.
 */
const NO_SETPOINT_MODES = { bed: ["fan_only"] };

/*
 * How long a setpoint gets to be answered before the card stops claiming it.
 *
 * This unit drops setpoints. Not at a particular value and not in a pattern:
 * the same request, from the same starting point, in `cool`, with the
 * compressor running and 12s to answer in, landed 5 times out of 8. A miss
 * comes in one of two shapes -- the unit keeps the setpoint it already had,
 * or it comes to rest a full degree ABOVE the one asked for.
 *
 *      from 17.0, asked 16.5  ->  16.5   16.5   17.5   17.5
 *      from 17.0, asked 16.0  ->  17.0   16.0   16.0   16.0
 *
 * Both values land and both values fail, so there is no hole in the range to
 * route around and no floor above 16.0 to clamp to. Every earlier reading
 * that looked like either -- a floor at 16.5, a floor at 17, a hole at 16.5 --
 * was three or four samples of a coin toss, and the sweeps that produced them
 * ran just after a mode change with the compressor still at 4W, which is when
 * this unit drops the most.
 *
 * What the card can do is not pretend. A press is re-sent once if the unit has
 * not echoed it, which is what a person does anyway, and if it still has not
 * landed the tab says so in as many words rather than sliding the number back
 * and letting a dropped command read as a dead button.
 */
/*
 * The switch a swing command turns on behind your back, and how long to watch
 * for it.
 *
 * Asked for `horizontal`, the bedroom unit switches Frost protect on -- its
 * own switch entity flips and the unit puts `FP` on its front panel. Watched
 * every two seconds against the live unit:
 *
 *      t=0s    swing off          frost protect off   <- the command goes out
 *      t=2s    swing horizontal   frost protect off
 *      t=4s    swing horizontal   frost protect ON
 *      t=16s   swing horizontal   frost protect ON
 *      t=18s   swing horizontal   frost protect off   <- clears itself
 *
 * `both` did it in one run out of two; `off` and `vertical` never did. So it
 * is not one option to route around, it is what this unit does with swing.
 *
 * Not offering `horizontal` was the first answer and the wrong one -- it is
 * wanted. Fourteen seconds of 8-degree heating that nobody asked for is the
 * part to get rid of, so the card turns it straight back off: it knows it
 * sent a swing command, it knows Frost protect was off when it did, and a
 * switch that comes on inside the window between those two facts is the
 * unit's doing, not a decision anyone made.
 *
 * It is deliberately narrow. Nothing is undone unless the card itself sent
 * the swing, and nothing is undone if Frost protect was already on -- the
 * grid has a toggle for it, and someone pressing that means it.
 */
const SWING_SIDE_EFFECT = { bed: BED_SWITCH_PREFIX + "frost_protect" };
const SWING_GUARD_MS = 25000;

const SENT_RETRY = 6000;
const MISS_SHOWN = 30000;

/*
 * How long after a send a disagreeing reading is still just noise.
 *
 * The unit does not go straight to a new setpoint, it wanders to one. Asked
 * for 16.5 from 17.0, the entity's own history reads:
 *
 *      20:45:49   17.5     one second after the press: asked + 1.0
 *      20:45:52   16.5     three seconds later, the value asked for
 *      20:46:08   17.5     and sixteen seconds after that, back up again
 *
 * The rule under this one -- anything that is not ours IS the unit's word --
 * is right for a unit that answers once, and wrong for this one: it took the
 * 17.5 at the top of that list as the answer, so a press on "-" drew as a
 * jump UP half a degree, and it threw away the pending send that the repeat
 * above needs. Hence the window: inside it the card keeps drawing what was
 * asked for, and only what the unit is still saying at the end of it counts.
 */
const SENT_GRACE = 10000;

/* --- charts --------------------------------------------------------------- */

const RANGES = {
  "3h": { label: "3 h", hours: 3, points: 500 },
  "24h": { label: "24 h", hours: 24, points: 900 },
  "7d": { label: "7 d", hours: 168, points: 1200 },
  "30d": { label: "30 d", hours: 720, points: 1200 },
};
const RANGE_ORDER = ["3h", "24h", "7d", "30d"];

const CH_W = 1000;
const CH_H = 250;
const TR_W = 600;
const TR_H = 220;
const CH_PAD = 14;
const TICKS = 7;
const GRID_LINES = 5;

/*
 * The two room charts, which are the same chart twice over one axis each.
 * `pad` and `minSpan` are in the chart's own unit: a room that held 24.6 all
 * day still needs three degrees of axis around it, or the noise floor gets
 * magnified into a mountain range.
 */
const CHARTS = [
  { id: "tc", title: "Temperature", unit: "°C", field: "temp", prefix: "t-", dec: 1, pad: 0.4, minSpan: 3 },
  { id: "hc", title: "Humidity", unit: "%", field: "hum", prefix: "h-", dec: 1, pad: 2, minSpan: 8 },
];

/*
 * Viewport limits. A minute is the floor because the recorder cannot fill
 * anything narrower; the longest preset is the ceiling because a window wider
 * than that has nothing cached to draw and a fetch nobody asked for.
 */
const MIN_SPAN = 60000;
const MAX_SPAN = Math.max.apply(null, Object.keys(RANGES).map((k) => RANGES[k].hours * 3600000));

/*
 * The dial, in its own 220-unit box: ring radius, the band a press counts as
 * the ring, and how near the knob a press has to be to be a GRAB rather than
 * a move.
 *
 * The middle of this dial is a readout -- the setpoint, the room temperature
 * and the humidity live there -- and it used to be wired as the control:
 * pressing anywhere in the square took the angle of that point from the
 * centre and threw the setpoint at it. With 25 on screen, pressing the
 * number itself set 28, just above it 24, just below it 18, and the empty
 * corner of the box 22. That is the jump.
 *
 * The band is wider than the 12-unit stroke it follows, because a finger is
 * wider than a line. The grab radius is wider still: landing a few degrees
 * off the knob's own angle must not snap a step before the drag has started.
 */
const DIAL_CX = 110;
const DIAL_R = 90;
const RING_IN = 66;
const RING_OUT = 110;
const KNOB_GRAB = 22;

/*
 * And what the ring LOOKS like, which used to be literals in the markup and
 * in two paint routines. They are one shape rather than four numbers: the
 * stroke and the knob riding it move together, and the only hard constraint
 * is that nothing leaves the 220-unit box --
 *
 *      DIAL_R + DIAL_W / 2 = 99    the outer edge of the stroke
 *      DIAL_R + KNOB_R     = 101   the outer edge of the knob
 *
 * The room mark rides the ring itself, at DIAL_R, small enough to sit inside
 * the stroke: MARK_R * 2 = 7 against a stroke of 18.
 */
const DIAL_W = 18;
const KNOB_R = 11;
const MARK_R = 3.5;

/*
 * Inside this radius the pointer's ANGLE stops carrying information at all,
 * and the drag holds until the pointer comes back out.
 *
 * Sensitivity goes as 1/r, so at the centre a pixel of mouse is most of the
 * range. This is only that singularity, though, and it is deliberately far
 * inside where a hand works. Measured on the real thing: a hand dragging
 * this dial ranges from 45 to 139 units out, so a threshold anywhere near
 * that band makes a third of the drag do nothing -- a worse bug than the
 * one it was put there to fix.
 */
const DRAG_MIN_R = 25;

/*
 * How far past the halfway line the pointer must go before the value
 * changes, as a fraction of one step. This is the whole of the anti-shake.
 *
 * Rounding alone puts a boundary every step, and a hand resting on one
 * flicks the value between its two neighbours -- on a twelve-step dial that
 * is the knob teleporting 22.5 degrees back and forth, and a setpoint you
 * cannot land on. Hysteresis makes the value already held sticky, so noise
 * has to be most of a step before anything moves.
 *
 * 0.25 covers a pointer's noise across the whole band a hand actually
 * works in -- 45 to 139 units out, measured -- including at the 80%
 * browser zoom where one mouse pixel is 1.25 CSS pixels. It still leaves
 * three quarters of a step of travel to reach the next one, so every
 * setpoint stays easy to land on.
 */
const DRAG_HYST = 0.25;

/*
 * How long a value we have SENT keeps the screen, waiting for the entity to
 * report it back.
 *
 * Long enough for an infrared frame to go out and the plug meter to answer,
 * short enough that a command the unit ignored stops being drawn as though
 * it had landed. A unit that never confirms falls back to its own reading
 * after this, which is the honest answer.
 */
const SENT_TTL = 15000;

/*
 * How far back raw states can be asked for.
 *
 * `recorder.purge_keep_days` is 2 on this box: past it the states table has
 * nothing and history_during_period answers with the two days it kept, which
 * is what a 30 d window drawn as a stub of a line in its last twentieth was.
 * What survives is the hourly long-term statistics, which are never purged --
 * so a window reaching further back than this is served from those instead,
 * the same swap the History panel makes over the same data. 36 h rather than
 * 48 leaves a margin for a purge that has just run.
 */
const RAW_HORIZON = 36 * 3600000;

/*
 * How long a fetched window is trusted before the recorder is asked again.
 * Short windows move fast and are cheap; a 30 d window is settled history and
 * re-fetching it every minute buys nothing.
 */
const TTL = { "3h": 60000, "24h": 120000, "7d": 300000, "30d": 900000 };

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
  const sans = f[0] === "IBM Plex Sans";
  const file = sans
    ? "ibm-plex-sans-" + f[2] + ".woff2"
    : "ibm-plex-mono-" + f[1] + "-" + f[2] + ".woff2";
  return "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1]
    + ";font-display:swap;src:url('/local/fonts/" + file + "') format('woff2');"
    + "unicode-range:" + f[3] + "}";
}).join("\n");

/*
 * THE FACES GO ON THE DOCUMENT, NOT IN THIS CARD'S SHADOW ROOT.
 *
 * Chrome does not apply an @font-face rule declared inside a shadow tree: the
 * rule parses, CSSOM keeps it, and the font is never fetched. Nothing warns --
 * the text simply renders in the fallback. jkbms-battery-console-card.js has
 * the long version of this note; it found the bug in its own sibling.
 *
 * The id is shared with nothing: it names the FACES, not the card, so two
 * cards wanting the same Plex subset install it once between them.
 */
const FONT_STYLE_ID = "ha-console-ibm-plex-fonts";

function installFonts() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(FONT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = FONTS;
  document.head.appendChild(style);
}

const STYLE = `
/*
 * A shadow root inherits no page reset, and the design is written in
 * border-box throughout: every fixed-size box here -- the toggle tracks
 * above all -- states the size it should OCCUPY, padding included. Without
 * this the 42x24 switch track becomes a 48x30 one and its 18px knob lands
 * in the top-left corner of it rather than centred, which is the off-centre
 * white dot on every switcher.
 */
*, *::before, *::after { box-sizing: border-box; }

:host { display: block; container-type: inline-size; container-name: cccard; }

ha-card {
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  background: ${BG};
  color: ${TXT};
  font-family: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  border: 1px solid ${EDGE};
  box-shadow: none;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
.root { padding: clamp(16px, 3vw, 28px); display: flex; flex-direction: column; gap: 16px; }
.mono { font-family: var(--mono); }
.grow { flex: 1; }

/* --- page head ----------------------------------------------------------- */
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.h1 { font-size: clamp(20px, 2.6vw, 26px); font-weight: 600; letter-spacing: -.02em; }
.sub { font-size: 13px; color: ${MUTED}; margin-top: 4px; }
.segs { display: flex; gap: 6px; padding: 4px; background: ${PANEL}; border: 1px solid ${EDGE}; border-radius: 10px; }
.seg { padding: 7px 14px; border-radius: 7px; font-size: 13px; font-weight: 500; cursor: pointer;
  background: transparent; color: ${MUTED}; transition: background .15s, color .15s; user-select: none; }
.seg[data-on="1"] { background: #262d33; color: ${TXT}; }
.seg:hover { color: ${TXT}; }

/* --- panels -------------------------------------------------------------- */
.panel { background: ${PANEL}; border: 1px solid ${EDGE}; border-radius: 14px; padding: 18px 20px; }
.panel-t { font-size: 14px; font-weight: 600; }
.panel-n { font-size: 12.5px; color: ${DIM}; }
.cards3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.col { display: flex; flex-direction: column; gap: 14px; }

/* --- room card ----------------------------------------------------------- */
.room-h { display: flex; align-items: center; gap: 9px; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.room-n { font-size: 14px; font-weight: 600; }
.badge { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 6px; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px; }
.badge ha-icon { --mdc-icon-size: 14px; display: inline-flex; }
/* The room card is its own container so its badges can tell when two of them
   no longer fit beside the name: each then shrinks to its icon, and the label
   lives on in the title. A single badge always keeps its words. */
.room { container-type: inline-size; container-name: room; }
@container room (max-width: 330px) {
  .badges:has(.badge + .badge) .badge-t { display: none; }
  .badges:has(.badge + .badge) .badge { padding: 4px 6px; }
}
.room-v { display: flex; align-items: baseline; gap: 18px; margin-top: 16px; flex-wrap: wrap; }
.vbox { display: flex; align-items: baseline; gap: 3px; }
.big { font-family: var(--mono); font-size: clamp(32px, 4.4vw, 44px); font-weight: 500; letter-spacing: -.03em; line-height: 1; }
.mid { font-family: var(--mono); font-size: clamp(20px, 2.6vw, 26px); font-weight: 500; letter-spacing: -.02em; line-height: 1; color: ${TXT2}; }
.unit { font-size: 15px; color: ${MUTED}; }
.unit-s { font-size: 13px; color: ${MUTED}; }
.room-f { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid ${HAIR}; }
.lbl { font-size: 11px; color: ${DIM}; letter-spacing: .04em; text-transform: uppercase; }
.fval { font-family: var(--mono); font-size: 14px; margin-top: 5px; white-space: nowrap; }

/* --- charts -------------------------------------------------------------- */
.ch-h { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.ch-wrap { position: relative; padding-left: 44px; }
.ch-ax { position: absolute; left: 0; transform: translateY(-50%); width: 36px; text-align: right;
  font-family: var(--mono); font-size: 11px; color: ${DIM}; }
.ch-svg { width: 100%; height: clamp(200px, 26vh, 280px); display: block; }
.ch-svg.small { height: 220px; }
.ch-ticks { display: flex; gap: 8px; padding: 6px 0 4px 44px; justify-content: space-between;
  font-family: var(--mono); font-size: 11px; color: ${DIM}; }
.ch-note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: ${DIM}; pointer-events: none; }
.win { font-family: var(--mono); font-size: 11.5px; color: ${DIM}; }

/* --- the plot, which is the thing you can grab ---------------------------- */
.plot { position: relative;
  /*
   * pan-y hands vertical scrolling back to the page and keeps everything
   * else: a horizontal drag and a two-finger pinch arrive here as pointer
   * events instead of scrolling the dashboard out from under the gesture.
   */
  touch-action: pan-y; cursor: grab; user-select: none; -webkit-user-select: none; }
.plot.grabbing { cursor: grabbing; }
.plot .ch-svg { cursor: crosshair; }
.hv { position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 1; }
.hv.on { opacity: 1; }
.hvline { top: 0; bottom: 0; width: 1px; background: #3a4146; }
.hvdot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid ${BG};
  transform: translate(-50%, -50%); }
.tip { position: absolute; top: 8px; pointer-events: none; opacity: 0; transition: opacity .1s;
  transform: translate(-50%, 0); z-index: 2; background: #14171c; border: 1px solid #2a2e36;
  border-radius: 9px; padding: 7px 10px; white-space: nowrap; box-shadow: 0 10px 30px -12px #000; }
.tip.on { opacity: 1; }
.tip i { display: block; font-style: normal; font-family: var(--mono); font-size: 10.5px;
  letter-spacing: .08em; color: ${DIM}; margin-bottom: 5px; }
.tip-r { display: flex; align-items: center; gap: 7px; font-size: 12px; line-height: 1.5; }
.tip-r b { font-family: var(--mono); font-weight: 600; margin-left: auto; padding-left: 14px; color: ${TXT}; }

/* --- the stats block, which replaced a legend ---------------------------- */
.stats { display: grid; grid-template-columns: minmax(96px, auto) repeat(4, minmax(56px, 1fr));
  gap: 4px 10px; align-items: center; border-top: 1px solid ${HAIR}; margin-top: 10px; padding-top: 12px; }
.st-h { font-family: var(--mono); font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
  color: ${DIM}; text-align: right; }
.st-n { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 500; cursor: pointer; }
.st-v { font-family: var(--mono); font-size: 13.5px; text-align: right; color: ${TXT2}; }
.st-v.now { color: ${TXT}; font-weight: 600; }
.hint { font-family: var(--mono); font-size: 11px; color: #4a4e57; text-align: center; }

/* --- the cost box -------------------------------------------------------- */
.cost { background: ${PANEL}; border: 1px solid ${EDGE}; border-radius: 14px; padding: 18px 20px; }
.cost-g { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.cost-c { background: ${WELL}; border: 1px solid ${EDGE}; border-radius: 12px; padding: 14px 16px; cursor: pointer; }
.cost-c:hover { border-color: #39404a; }
.cost-v { display: flex; align-items: baseline; gap: 5px; margin-top: 9px; }
.cost-n { font-family: var(--mono); font-size: 26px; font-weight: 600; letter-spacing: -.02em; }
.cost-u { font-size: 13px; color: ${MUTED}; }
.cost-s { display: flex; gap: 12px; margin-top: 11px; padding-top: 10px; border-top: 1px solid ${HAIR};
  font-family: var(--mono); font-size: 11.5px; flex-wrap: wrap; }
.cost-s > div { display: flex; align-items: center; gap: 5px; }
.zone { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .04em; }
.rate { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
  margin-top: 13px; padding-top: 12px; border-top: 1px solid ${HAIR};
  font-family: var(--mono); font-size: 12px; color: ${MUTED}; }
.rate b { color: ${TXT2}; font-weight: 600; }
.rate .sep { color: ${HAIR}; }
.key { display: flex; gap: 14px; font-size: 12px; color: ${MUTED}; flex-wrap: wrap; }
.key > div { display: flex; align-items: center; gap: 6px; }
.dash { width: 14px; height: 0; border-top: 2px dashed ${MUTED}; }
.solid { width: 14px; height: 2px; }

/* --- hero ---------------------------------------------------------------- */
.hero { border: 1px solid ${EDGE}; border-radius: 16px; overflow: hidden; transition: background .6s ease; }
.hero-g { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: clamp(20px, 3vw, 40px); padding: clamp(20px, 3vw, 32px); align-items: center; }
.dial-col { display: flex; flex-direction: column; align-items: center; gap: 18px; }
.dial { position: relative; width: clamp(250px, 38vw, 340px); aspect-ratio: 1; }
.dial svg { width: 100%; height: 100%; display: block; overflow: visible; }
.dial-arc { transition: stroke .35s ease, opacity .3s ease; }
/*
 * Everything in here has to fit INSIDE the ring. The clear width across a
 * 220-unit dial with an 88 radius and a 12 stroke is 164 units, so the
 * centre gets 12.5% of gutter on each side and the sub-line is clipped
 * rather than allowed to grow past the arc -- which is what a "52 % humidity
 * · living room sensor" footnote did, spilling out of both sides of the ring
 * and dragging a full-width rule along with it.
 */
.dial-c { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 3px; padding: 0 12.5%; text-align: center; }
/* What the unit is DOING, where the word "Target" used to be.
   The label was spending the best line inside the ring to say something the
   ring already says -- a knob on an arc is a setpoint -- while the mode, the
   thing that decides what the setpoint even means, was only in the pills and
   a badge. Cool at 22 and Heat at 22 are opposite instructions. */
.dial-k { font-size: 14.5px; font-weight: 600; letter-spacing: .01em; color: ${TXT2}; }
.dial-v { font-family: var(--mono); font-size: clamp(54px, 8.4vw, 74px); font-weight: 500;
  letter-spacing: -.04em; line-height: 1; }
/* Superscript, not a baseline neighbour: the unit belongs to the number and
   should not compete with it for the eye. */
.dial-u { font-size: 20px; color: ${MUTED}; align-self: flex-start; margin-top: .45em; }
/* The current temperature: the other half of a thermostat, on the design's
   one mono line -- "room 24.0 °C · 52 %" -- rather than in a bordered block
   the ring has no room for. The first word is the provenance. */
.dial-s { font-family: var(--mono); font-size: 12.5px; color: ${MUTED}; margin-top: 3px;
  max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The ring is the control and says so; the middle is a readout and does not,
   because a pointer cursor over a number that cannot be dragged is a lie.
   A stroked path with no fill hit-tests on its stroke, so these land on the
   ring itself rather than on the box around it. */
.dial { touch-action: none; }
.dial svg { cursor: default; }
.dial path, .knob { cursor: grab; }
.dial.dragging path, .dial.dragging .knob { cursor: grabbing; }
.dial[data-dead="1"] svg, .dial[data-dead="1"] path,
.dial[data-dead="1"] .knob { cursor: default; pointer-events: none; }
.dial[data-frozen="1"] svg, .dial[data-frozen="1"] path,
.dial[data-frozen="1"] .knob { cursor: default; pointer-events: none; }
/* The room mark is a marking, not a control: it never takes a press, and a
   drag passing over it must not stop on it -- it sits ON the ring now, so a
   finger dragging the knob crosses it every time. */
.rmark { pointer-events: none; }
.steps { display: flex; align-items: center; gap: 10px; }
.step { width: 46px; height: 46px; border-radius: 14px; border: 1px solid ${BTN_EDGE}; background: ${BTN_BG};
  display: flex; align-items: center; justify-content: center; font-size: 22px; cursor: pointer;
  color: ${TXT}; user-select: none; transition: background .15s; }
.step:hover { background: #262c30; }
.pwr { padding: 0 20px; height: 46px; border-radius: 14px; display: flex; align-items: center; gap: 9px;
  cursor: pointer; font-size: 14px; font-weight: 600; user-select: none; border: 1px solid ${BTN_EDGE};
  transition: background .2s, color .2s, border-color .2s; }
.pdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
/* The same button at title size, for the plug in the hero's top corner. It
   shares a line with the room's name and the badges, and a 46px slab there
   would outweigh both. The margin is what holds it to the right edge rather
   than a spacer: the title row wraps on a narrow card, and an auto margin
   keeps the button hard right on whichever line it lands on, where a
   flex-grow spacer would leave it wrapped to the left. */
.pwr.sm { height: auto; padding: 7px 12px; border-radius: 10px; font-size: 12.5px;
  margin-left: auto; }
[data-dead="1"] { opacity: .4; cursor: not-allowed; pointer-events: none; }

.hero-r { display: flex; flex-direction: column; gap: 20px; }
.hero-t { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hero-d { font-size: 13px; color: ${MUTED}; margin-top: 6px; max-width: 58ch; text-wrap: pretty; }
.ctl { display: flex; flex-direction: column; gap: 14px; }
.ctl-l { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: ${DIM}; margin-bottom: 8px; }
.ctl-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.ctl-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; }
.pill { padding: 10px 16px; border-radius: 11px; font-size: 13.5px; font-weight: 500; cursor: pointer;
  user-select: none; border: 1px solid ${INPUT_EDGE}; background: #191d20; color: ${TXT2};
  transition: background .18s, color .18s, border-color .18s, box-shadow .18s; }
.bar { display: flex; gap: 6px; padding: 4px; background: ${INPUT_BG}; border: 1px solid ${INPUT_EDGE}; border-radius: 12px; }
.bar.wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(62px, 1fr)); }
.tick { flex: 1; text-align: center; padding: 9px 6px; border-radius: 9px; font-size: 13px; font-weight: 500;
  cursor: pointer; user-select: none; background: transparent; color: ${MUTED}; transition: background .18s, color .18s; }
.sw { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; cursor: pointer;
  user-select: none; background: ${INPUT_BG}; border: 1px solid ${INPUT_EDGE}; }
.track { width: 42px; height: 24px; border-radius: 24px; background: #3a4146; padding: 3px; display: flex;
  align-items: center; justify-content: flex-start; transition: background .2s, justify-content .2s; flex: none; }
.track > div { width: 18px; height: 18px; border-radius: 50%; background: #fff; }
.track[data-on="1"] { justify-content: flex-end; }
.sw-l { font-size: 13.5px; font-weight: 500; color: ${MUTED}; }
/*
 * The fan trim, which is a control.
 *
 * The unit takes a percentage as well as the six named speeds, and the bar
 * under them was drawing that percentage without offering it -- so it is a
 * slider now. The hit area is 20px tall and the bar inside it is the
 * design's 6px: a 6px target is not one anybody hits on a phone. Like the
 * dial, the drag paints a preview and the RELEASE sends the one call.
 */
.fine { margin-top: 10px; padding: 7px 0; position: relative; cursor: pointer;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.fine-t { height: 6px; border-radius: 6px; background: #22282c; overflow: hidden; }
.fine-t > div { height: 100%; width: 0; transition: width .3s, background .2s; }
.fine-k { position: absolute; top: 50%; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; border: 2px solid ${BG}; transform: translate(-50%, -50%);
  transition: left .3s; cursor: grab; }
.fine.dragging { cursor: grabbing; }
.fine.dragging .fine-k { cursor: grabbing; transition: none; }
.fine.dragging .fine-t > div { transition: none; }
/*
 * The three one-shot scripts under the hall's controls.
 *
 * They were dashed, dimmer and a size of their own, which put them outside
 * the only family on the tab -- and they are controls, pressed for the same
 * reasons and in the same breath as the row above them. They take the pill's
 * metrics and surface, and the mode's accent through --ctl, which _patchHall
 * sets from the same value that colours everything else.
 *
 * What they do NOT take is a filled background: a pill fills when it is the
 * one selected, and these select nothing. Accent on the text, the accent at a
 * tenth on the border, and the fill arriving only under the pointer, is the
 * difference between "press this" and "this is on".
 */
.acts { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.act { padding: 10px 16px; border-radius: 11px; font-size: 13px; font-weight: 500;
  border: 1px solid var(--ctl-edge, ${INPUT_EDGE}); background: #191d20;
  color: var(--ctl, ${TXT2}); cursor: pointer; user-select: none;
  transition: background .18s, color .18s, border-color .18s, box-shadow .18s; }
.act:hover { background: var(--ctl-soft, #1f2429); border-color: var(--ctl, #4d565c); }
.act:active { transform: translateY(1px); }

/* --- banner -------------------------------------------------------------- */
.banner { display: flex; align-items: center; gap: 12px; padding: 12px 20px; flex-wrap: wrap;
  background: #2a1f0c; border-top: 1px solid #3d2e12; }
.banner-x { font-size: 13px; color: #f0d79a; }
.banner-a { font-size: 12.5px; font-weight: 600; color: ${WARN}; cursor: pointer; }

/* --- tiles --------------------------------------------------------------- */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile { background: ${PANEL}; border: 1px solid ${EDGE}; border-radius: 12px; padding: 14px 16px; cursor: pointer; }
.tile:hover { border-color: #39404a; }
.tile-v { display: flex; align-items: baseline; gap: 4px; margin-top: 8px; }
.tile-n { font-family: var(--mono); font-size: 22px; font-weight: 500; letter-spacing: -.02em; }
.wells { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.wells.tight { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
.wells.mid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.well { background: ${WELL}; border: 1px solid ${EDGE}; border-radius: 10px; padding: 12px 13px; cursor: pointer; }
.well:hover { border-color: #39404a; }
.well .lbl { line-height: 1.3; }
.well-v { display: flex; align-items: baseline; gap: 3px; margin-top: 7px; }
.well-n { font-family: var(--mono); font-size: 18px; font-weight: 500; }
.well-u { font-size: 11px; color: ${MUTED}; }

/* --- status rows --------------------------------------------------------- */
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid ${HAIR}; cursor: pointer; }
.rows .row:last-child { border-bottom: none; }
.row-l { font-size: 13px; }
.row-v { font-size: 13px; font-family: var(--mono); }

/* --- feature toggles ----------------------------------------------------- */
.feats { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 10px; }
.feat { display: flex; align-items: center; gap: 10px; padding: 12px 13px; border-radius: 12px;
  cursor: pointer; user-select: none; background: ${WELL}; border: 1px solid ${INPUT_EDGE};
  transition: background .18s, border-color .18s, box-shadow .18s; }
.feat .track { width: 30px; height: 18px; padding: 2.5px; }
.feat .track > div { width: 13px; height: 13px; }
/* The label names an entity, so it opens it -- the switch beside it is the
   control, the words are the way in to the dialog. Same everywhere a name
   appears: the title, the badges, the reading under the dial. */
.feat-l { font-size: 12.5px; font-weight: 500; color: ${MUTED}; line-height: 1.25; }
.feat-l, .hero-t .h1[data-more], .badge[data-more], .dial-s[data-more] { cursor: pointer; }
.hero-t .h1[data-more]:hover, .dial-s[data-more]:hover { text-decoration: underline;
  text-decoration-color: ${DIM}; text-underline-offset: 3px; }

@container cccard (max-width: 560px) {
  .room-f { grid-template-columns: 1fr; }
  .ch-wrap { padding-left: 36px; }
  .ch-ticks { padding-left: 36px; }
  .stats { grid-template-columns: minmax(80px, auto) repeat(4, minmax(44px, 1fr)); gap: 4px 6px; }
  .st-v { font-size: 12px; }
}
`;

class ClimateConsoleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._built = false;
    this._el = {};
    this._optPrint = null;
    this._timer = null;
    this._range = "24h";
    this._hist = new Map();
    this._inflight = new Map();
    /*
     * The viewport, shared by both room charts. null is "live": the whole
     * preset window with its right edge at now. A zoom or a pan writes
     * {start, end, follow} and the presets stop being what is drawn -- see
     * _domainX. `follow` means the right edge was left at now, so the window
     * keeps tracking it instead of freezing the moment it was zoomed.
     *
     * One viewport for two charts on purpose: they are the same three rooms
     * over the same time, and letting humidity sit at 24 h while temperature
     * is zoomed into ten minutes would put two different afternoons on screen
     * one above the other.
     */
    this._view = null;
    this._dom = null;
    this._hv = {};
    this._token = null;
    this._pointers = new Map();
    this._gesture = null;
    this._dragging = false;
    this._viewTimer = null;
    // Which chart the cursor is over and where, so a redraw can put the
    // readout back rather than being held off until the pointer leaves.
    this._hovering = null;
    this._hoverX = null;
    // A setpoint drag in progress: {pfx, ent, id, lim, value, moved}. The
    // entity still reads the old value until the release sends one.
    this._drag = null;
    // The same, for the bedroom unit's fan trim: {id, lim, value}.
    this._fine = null;
    // The accent each tab's hero was last painted in, so a drag can repaint
    // the dial alone without recomputing the tab's whole state. NOT `_acc`:
    // that is the method mapping an action to an accent, and an instance
    // property of the same name shadows it -- which threw the hall tab the
    // moment its unit came on, the one path that calls it.
    this._heroAccs = {};
    // The dial's and the trim's nodes, with the last value written to each.
    // Dropped by _build, which replaces the nodes they point at.
    this._dial = {};
    this._fineNodes = null;
    // The root carrying --ctl has just been replaced with one that carries
    // nothing, so the accent has to be written again rather than remembered.
    this._accVar = null;
    /*
     * Values sent and not yet echoed, keyed by entity: {value, at}.
     *
     * Releasing a drag used to hand the number straight back to the entity,
     * which still read the OLD one -- the service call had not completed, let
     * alone the unit answered -- so the knob snapped back to where the drag
     * started and then jumped forward again when the state finally arrived.
     * Every commit writes here first, and what we sent stays on screen until
     * the entity agrees with it or SENT_TTL says it never will.
     */
    this._sent = {};
    // Sends that ran out of answers, per entity: what was asked for and what
    // the unit is actually sitting on. Read by the tab, cleared by the next
    // press. See SENT_RETRY.
    this._missed = {};
    this._resend = {};
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    if (TABS.indexOf(cfg.tab) < 0) {
      throw new Error(CARD + ": tab must be one of " + TABS.join(", ") + ", got " + cfg.tab);
    }
    // Every entity is overridable, so a typo should fail here rather than draw
    // a card full of em dashes.
    Object.keys(DEFAULTS).forEach((k) => {
      if (k === "tab") return;
      if (typeof cfg[k] !== "string" || cfg[k].indexOf(".") < 1) {
        throw new Error(CARD + ": " + k + " must be an entity id, got " + cfg[k]);
      }
    });
    if (config && config.range && RANGE_ORDER.indexOf(config.range) < 0) {
      throw new Error(CARD + ": range must be one of " + RANGE_ORDER.join(", ")
        + ", got " + config.range);
    }
    if (config && config.range) this._range = config.range;
    this._config = cfg;
    // A changed config means a changed DOM, so drop the built tree.
    this._built = false;
    this._optPrint = null;
    this._view = null;
    this._dom = null;
    this._hv = {};
    this._hist.clear();
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._checkSwingGuard();
    if (this._config) this._render();
  }

  connectedCallback() {
    // Cheap and idempotent. Done here as well as at module load because a
    // module can be evaluated before <head> exists.
    installFonts();
    if (!this._timer) this._timer = window.setInterval(() => this._tick(), 30000);
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return { rooms: 32, hall: 30, bedroom: 34 }[this._config ? this._config.tab : "rooms"];
  }

  static getStubConfig() {
    return { tab: "rooms" };
  }

  /*
   * A sections view lays each section out as a 12-column sub-grid, and a card
   * that does not answer this gets a narrow default slot however wide the
   * section is. "full" is what `column_span` on the section was for.
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
    return st ? st.state : "unavailable";
  }

  /** Reporting a real value, as opposed to unknown or unavailable. */
  _live(id) {
    const s = this._state(id);
    return s !== "unavailable" && s !== "unknown";
  }

  /**
   * The number to DRAW for an entity: what we last sent, until it is echoed.
   *
   * `live` is the entity's own reading. The pending value wins over it while
   * it stands, and clears itself the moment the two agree -- so a unit that
   * confirms in 200 ms and one that takes four seconds both draw one move.
   */
  _settle(ent, live) {
    const p = this._sent[ent];
    if (!p) return live;
    const eq = (a, b) => Math.abs(a - b) < 1e-9;
    const known = live !== null && Number.isFinite(live);

    // It came back saying what we last asked for. Done.
    if (known && eq(live, p.value)) { delete this._sent[ent]; return live; }
    // Or it never will. Its own reading is the honest answer after this --
    // and on this unit that happens often enough that quietly sliding the
    // number back is the wrong way to report it, so the miss is kept.
    if (Date.now() - p.at > SENT_TTL) {
      if (known && !eq(live, p.value)) {
        this._missed[ent] = { want: p.value, got: live, at: Date.now() };
      }
      delete this._sent[ent];
      return live;
    }
    if (!known) return p.value;

    /*
     * An echo of an EARLIER press in the same burst.
     *
     * Two taps on + send two calls, and the first landing is not the unit
     * disagreeing with the second -- it is the unit halfway there. Reading
     * it as a disagreement is what made a setpoint taken to 26 settle back
     * on 25.5: the 25.5 we had sent ourselves arrived, looked like the unit
     * speaking, and won.
     */
    if (p.trail.some((v) => eq(v, live))) return p.value;
    // Still sitting on what it read before we said anything: nothing has
    // landed yet.
    if (Number.isFinite(p.was) && eq(live, p.was)) return p.value;
    // Or it is on its way and this is one of the values it passes through --
    // but only where that is a thing that happens. Everywhere else a number
    // we did not ask for is the answer the moment it arrives: a clamp against
    // the entity's own range, a step it rounded to, a knob turned by hand.
    // See SENT_GRACE.
    if (p.noisy && Date.now() - p.last < SENT_GRACE) return p.value;

    // Anything else IS the unit's own word -- clamped to its range, rounded
    // to a step of its own, or set at the physical remote while we waited --
    // and it outranks a request.
    delete this._sent[ent];
    return live;
  }

  /** Record a value on its way to `ent`, and draw it meanwhile. */
  _send(ent, value, was) {
    const p = this._sent[ent];
    // Every value of the burst, not just the last: each one will come back,
    // and each has to be recognised as ours rather than as an answer.
    const trail = p ? p.trail.slice(-15) : [];
    trail.push(value);
    // A new press supersedes whatever the last one failed to do.
    delete this._missed[ent];
    this._sent[ent] = {
      value: value,
      // When this value last went out, which is what the noise window is
      // measured from -- the repeat moves it, `at` stays put so that the
      // whole exchange still has one deadline.
      last: Date.now(),
      // Two presses before the first is answered share one "before": the
      // entity has not moved between them, and reading it again would record
      // our own pending number as the unit's last word.
      was: p ? p.was : was,
      trail: trail,
      at: Date.now(),
    };
  }

  /** A finite number, or null for unknown/unavailable/non-numeric. */
  _num(id) {
    const st = this._stateObj(id);
    if (!st) return null;
    const v = parseFloat(st.state);
    return Number.isFinite(v) ? v : null;
  }

  _attr(id, name) {
    const st = this._stateObj(id);
    return st && st.attributes ? st.attributes[name] : undefined;
  }

  _list(id, name, fallback) {
    const v = this._attr(id, name);
    return Array.isArray(v) && v.length ? v : fallback;
  }

  /**
   * Arm the watch for what a swing command switches on by itself.
   * See SWING_SIDE_EFFECT.
   */
  _guardSwing(ent, pfx) {
    const sw = SWING_SIDE_EFFECT[pfx === "hall" ? "hall" : "bed"];
    // Already on before we said anything: somebody meant that. Leave it.
    if (!sw || this._state(sw) === "on") return;
    this._swingGuard = { sw: sw, until: Date.now() + SWING_GUARD_MS };
  }

  /**
   * Undo it, once, if it happens. Called on every state update, which is the
   * only place the switch coming on can be noticed.
   */
  _checkSwingGuard() {
    const g = this._swingGuard;
    if (!g) return;
    if (Date.now() > g.until) { this._swingGuard = null; return; }
    if (this._state(g.sw) !== "on") return;
    this._swingGuard = null;
    this._call("switch", "turn_off", { entity_id: g.sw });
  }

  _fmt(v, dec) {
    return v === null || v === undefined ? "—" : v.toFixed(dec);
  }

  /** A sensor's own value, or an em dash. */
  _sfmt(id, dec) {
    return this._fmt(this._num(id), dec);
  }

  /**
   * Write text only when it is different.
   *
   * Assigning textContent replaces the text node whether or not the string
   * changed, which dirties layout. Everywhere else on the card that costs
   * nothing; inside the dial's centre it is a flex column that gets re-laid
   * out under a finger that is dragging, so the block visibly twitches.
   */
  _setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  _esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _hhmm(ts) {
    if (!ts) return "—";
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  _title(s) {
    const v = String(s || "");
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : "—";
  }

  // --- derivation ----------------------------------------------------------

  /**
   * Magnus-Tetens dew point. Worth having on a card that already shows both
   * halves of it: 50% at 25 C and 50% at 19 C feel nothing alike, and the dew
   * point is the number that says so.
   */
  _dew(t, rh) {
    if (t === null || rh === null || rh <= 0) return null;
    const a = 17.27, b = 237.7;
    const g = (a * t) / (b + t) + Math.log(Math.min(100, Math.max(1, rh)) / 100);
    const d = (b * g) / (a - g);
    return Number.isFinite(d) ? d : null;
  }

  /**
   * The room's comfort badges. Temperature and humidity are judged on their own
   * axes, so a room that is both warm and humid says both -- the old single
   * verdict let Humid hide Warm. Comfortable only when neither axis complains.
   *
   * Humidity has a mild and a strong step either side of 40-60 %, the same
   * shape as temperature. It is rounded to a whole percent first, so a sensor
   * wobbling across 60.0 does not blink the badge on and off. The four drops
   * are one family -- crossed, hollow, filled, filled with a warning -- so the
   * icon alone says which way and how far.
   */
  _comfort(t, h) {
    if (t === null || h === null) {
      return [{ label: "No data", icon: "mdi:help-circle-outline", bg: "#1f2428", fg: DIM }];
    }
    const out = [];
    if (t >= 32) out.push({ label: "Hot", icon: "mdi:fire", bg: "#3a1a14", fg: BAD });
    else if (t > 26) out.push({ label: "Warm", icon: "mdi:weather-sunny", bg: "#3a2410", fg: "#ffb371" });
    else if (t < 20) out.push({ label: "Cool", icon: "mdi:snowflake", bg: "#12283a", fg: "#8ec5e8" });
    const rh = Math.round(h);
    if (rh < 30) out.push({ label: "Very dry", icon: "mdi:water-off", bg: "#3a2c0c", fg: WARN });
    else if (rh < 40) out.push({ label: "Dry", icon: "mdi:water-outline", bg: "#2a2618", fg: "#d6c08a" });
    else if (rh > 70) out.push({ label: "Very humid", icon: "mdi:water-alert", bg: "#0a2a4a", fg: "#4fb0ff" });
    else if (rh > 60) out.push({ label: "Humid", icon: "mdi:water", bg: "#0e2f42", fg: "#7cc7f0" });
    return out.length ? out
      : [{ label: "Comfortable", icon: "mdi:check-circle-outline", bg: "#14321f", fg: OK }];
  }

  /**
   * The accent for a tab, from what the unit is DOING.
   *
   * The hall's action is measured -- irbridge_ac_energy.yaml derives it from
   * the plug meter and publishes it back into the climate entity -- so it is
   * read from that sensor. The bedroom unit reports its own hvac_action.
   * Either way the mode we ASKED for is not consulted: a unit set to Cool and
   * drawing 3 W is idle, and colouring it blue would say otherwise.
   */
  _acc(action) {
    if (!action) return ACC_UNKNOWN;
    return ACC[String(action).toLowerCase()] || ACC_UNKNOWN;
  }

  /**
   * The accent the controls are painted in, as opposed to the ground.
   *
   * While the unit is working this IS the activity accent and nothing below
   * changes. The moment it stops -- idle, off, or not answering -- the
   * activity accent goes grey, and the switches must not: an `Eco mode` that
   * is on has to look different from the eleven that are off whatever the
   * compressor is doing. So the hue falls back to the mode the unit is SET
   * to, and then to the house blue, which is what this design uses for
   * "selected" when nothing more specific is known.
   */
  _ctlAcc(ent, acc) {
    if (acc !== ACC.idle && acc !== ACC.off && acc !== ACC_UNKNOWN) return acc;
    return ACC[MODE_ACC[String(this._state(ent)).toLowerCase()]] || ACC.cooling;
  }

  /**
   * The hero's ground.
   *
   * Off is flat and grey because nothing is enabled and saying otherwise
   * would be a lie about a dark room. Idle is the ghost of whatever mode is
   * running -- the unit IS on, it has simply reached the setpoint, and a
   * ground that drops to the same grey as "off" loses the only difference
   * between a thermostat resting and a thermostat switched off.
   */
  /**
   * The accent the HERO wears: its ground, the arc, the power button and the
   * activity badge.
   *
   * It is the measured activity wherever there IS one -- that part has not
   * changed, and it is why a unit drawing three watts does not get a blue
   * background. But this bedroom unit publishes no hvac_action at all: on,
   * running its fan, and `null`. That fell to ACC_UNKNOWN, so the whole hero
   * went flat grey and the power button read as though nothing were on,
   * while the controls beside it were correctly teal. A unit that is ON has
   * to look on; with no measurement to contradict it, the mode it is set to
   * is the best thing we know.
   */
  _heroAcc(ent, acc, ctl, dead) {
    if (dead) return ACC_UNKNOWN;
    if (this._state(ent) === "off") return ACC.off;
    return acc === ACC.idle || acc === ACC_UNKNOWN ? ctl : acc;
  }

  /**
   * And its ground. Off is flat and grey because nothing is enabled. Idle is
   * the GHOST of the mode -- the unit is on but resting, and a full ground
   * would claim it was working. Everything else gets the ambient light.
   */
  _ground(ent, acc, ctl, dead) {
    if (dead) return ACC_UNKNOWN.bg;
    if (this._state(ent) === "off") return ACC.off.bg;
    if (acc === ACC.idle) return ctl.ghost;
    return this._heroAcc(ent, acc, ctl, dead).bg;
  }

  /** The point at `frac` along the dial's 270-degree sweep. */
  _polar(cx, cy, r, frac) {
    const a = (135 + 270 * Math.max(0, Math.min(1, frac))) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  /**
   * The inverse: where a pointer is, as a fraction along the sweep.
   *
   * The 90 degrees the dial does NOT cover sit at the bottom, and a finger
   * that strays into them has to resolve to one end or the other rather than
   * to a wild value -- so the dead zone is split down the middle and each
   * half snaps to the end it is nearer. Without that, dragging past the
   * bottom-right of the ring jumps the setpoint from 30 to 18.
   */
  /**
   * Whether a pointer this far from the dial's centre is worth reading.
   *
   * Pure, and separate from the drag, because the threshold is the whole
   * argument: see DRAG_MIN_R.
   */
  _dragUsable(dx, dy, unit) {
    return unit > 0 && Math.hypot(dx, dy) / unit >= DRAG_MIN_R;
  }

  _fracAt(clientX, clientY, rect) {
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    const rel = ((deg - 135) % 360 + 360) % 360;
    if (rel <= 270) return rel / 270;
    return rel < 315 ? 1 : 0;
  }

  /**
   * What a press at (clientX, clientY) landed on: "knob", "ring", or null.
   *
   * `frac` is where the knob currently is, so a press near it is a grab --
   * the drag starts and nothing moves until the pointer does. Anything on
   * the ring band away from the knob is a deliberate "put it there". The
   * middle, the corners, and the 90-degree gap the sweep does not cover are
   * not the control and answer null, which leaves the press to the page.
   */
  _dialHit(clientX, clientY, rect, frac) {
    if (!rect.width || !rect.height) return null;
    // The svg is a square 220-unit box drawn to fit a square element, so one
    // unit is this many pixels and the hit test can be written in the same
    // numbers as the drawing.
    const unit = rect.width / 220;
    if (!unit) return null;
    const dx = (clientX - (rect.left + rect.width / 2)) / unit;
    const dy = (clientY - (rect.top + rect.height / 2)) / unit;

    if (Number.isFinite(frac)) {
      const k = this._polar(0, 0, DIAL_R, frac);
      if (Math.hypot(dx - k[0], dy - k[1]) <= KNOB_GRAB) return "knob";
    }

    const r = Math.hypot(dx, dy);
    if (r < RING_IN || r > RING_OUT) return null;
    // The bottom 90 degrees are not on the dial. A drag that strays into
    // them still clamps to the nearer end -- see _fracAt -- but a press
    // cannot START there, or tapping below the number jumps to an extreme.
    const rel = ((Math.atan2(dy, dx) * 180 / Math.PI - 135) % 360 + 360) % 360;
    return rel <= 270 ? "ring" : null;
  }

  /** 270 degrees of arc, opening at the bottom, starting at 135. */
  /*
   * The ring, as arcs of at most a quarter turn each.
   *
   * It was one `A` command for the whole sweep, and that has a hole in it at
   * exactly half a turn. An SVG arc is given its endpoints and a radius, and
   * the renderer works out the centre -- which is fine until the two ends are
   * nearly opposite each other, where the answer stops being well determined.
   * At 180 degrees the chord IS the diameter, and the spec's rule for a chord
   * that will not fit the radius is to scale the radius up until it does. So
   * a chord a hair over 2r is not drawn as "near enough": it is drawn on a
   * bigger circle, in a different place.
   *
   * On this dial, 270 degrees over a 16-30 range, that lands on 25.5:
   *
   *      T       sweep     chord     2r - chord
   *      25.0    173.6d    175.723     0.277
   *      25.5    183.2d    175.931     0.069     <-- and the ends were
   *      26.0    192.9d    174.893     1.107         rounded to 0.1
   *
   * 0.069 of room, with both ends rounded to a tenth before they reach the
   * renderer. Half the time the rounding spent it, the radius got scaled, and
   * the arc jumped -- which is why it was 25.5 and nowhere else, and why it
   * showed up on the way IN to 25.5 and on the way OUT of it in either
   * direction.
   *
   * Quarter turns have no such point: the longest chord any of them can have
   * is r * sqrt(2), which is 0.71 of the diameter rather than 1.00 of it. The
   * large-arc flag is then always 0 as well, so the one genuinely fragile
   * number in the path is gone rather than merely nursed.
   */
  _arc(cx, cy, r, frac) {
    const f = Math.max(0, Math.min(1, frac));
    const p = (a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
    // A full sweep still stops a tenth of a degree short, so that the ring's
    // two ends stay two ends and its round caps do not sit on each other.
    const total = f >= 0.9999 ? 269.9 : 270 * f;
    const [x0, y0] = p(135);
    const segs = Math.max(1, Math.ceil(total / 90));
    let d = "M " + x0.toFixed(2) + " " + y0.toFixed(2);
    let end = [x0, y0];
    for (let i = 1; i <= segs; i++) {
      end = p(135 + total * i / segs);
      d += " A " + r + " " + r + " 0 0 1 " + end[0].toFixed(2) + " " + end[1].toFixed(2);
    }
    return { d: d, x: +end[0].toFixed(2), y: +end[1].toFixed(2) };
  }

  // --- interaction ---------------------------------------------------------

  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: entityId }, bubbles: true, composed: true,
    }));
  }

  _call(domain, service, data) {
    if (this._hass) this._hass.callService(domain, service, data);
  }

  _onClick(ev) {
    const path = ev.composedPath ? ev.composedPath() : [ev.target];
    for (const node of path) {
      if (!node || node === this.shadowRoot || !node.getAttribute) continue;
      const act = node.getAttribute("data-act");
      if (!act) {
        const more = node.getAttribute("data-more");
        if (more) { ev.stopPropagation(); this._moreInfo(more); return; }
        continue;
      }
      ev.stopPropagation();
      ev.preventDefault();
      const ent = node.getAttribute("data-ent");
      const val = node.getAttribute("data-val");
      switch (act) {
        case "range":
          // Picking a preset is the other way back to live, alongside a
          // double-click: the window it names ends at now by definition.
          this._range = val;
          this._view = null;
          this._syncSegs();
          this._refreshCharts();
          return;
        case "mode":
          this._call("climate", "set_hvac_mode", { entity_id: ent, hvac_mode: val });
          return;
        case "fan":
          this._call("climate", "set_fan_mode", { entity_id: ent, fan_mode: val });
          return;
        case "swing":
          this._guardSwing(ent, this._pfxOf(ent));
          this._call("climate", "set_swing_mode", { entity_id: ent, swing_mode: val });
          return;
        case "swing-toggle":
          this._call("climate", "set_swing_mode", {
            entity_id: ent,
            swing_mode: this._attr(ent, "swing_mode") === "on" ? "off" : "on",
          });
          return;
        case "temp": {
          const step = Number(val);
          // Step from what is on SCREEN, not from what the entity says: two
          // taps before the unit has answered the first must add two steps,
          // not the same one twice.
          const cur = this._settle(ent, Number(this._attr(ent, "temperature")));
          if (!Number.isFinite(cur) || !Number.isFinite(step)) return;
          // The same ends the dial drags between: two ways to the same
          // setpoint that stop in different places is the kind of
          // disagreement nobody reads as deliberate.
          const lim = this._dialLimits(ent, this._pfxOf(ent));
          let next = Math.min(lim.hi, Math.max(lim.lo, cur + step));
          // Halves exist on the bedroom unit and nowhere else; rounding keeps
          // 23.5 + 0.5 from arriving as 24.000000000000004.
          next = Math.round(next * 100) / 100;
          this._send(ent, next, Number(this._attr(ent, "temperature")));
          this._call("climate", "set_temperature", { entity_id: ent, temperature: next });
          this._armResend(ent, "climate", "set_temperature", "temperature");
          this._patch();
          return;
        }
        case "resend": {
          const again = Number(val);
          if (!Number.isFinite(again)) return;
          this._send(ent, again, Number(this._attr(ent, "temperature")));
          this._call("climate", "set_temperature", { entity_id: ent, temperature: again });
          this._armResend(ent, "climate", "set_temperature", "temperature");
          this._patch();
          return;
        }
        case "power":
          this._call("climate", this._state(ent) === "off" ? "turn_on" : "turn_off",
            { entity_id: ent });
          return;
        case "switch":
          this._call("switch", "toggle", { entity_id: ent });
          return;
        case "script":
          this._call("script", "turn_on", { entity_id: ent });
          return;
        default:
          return;
      }
    }
  }

  // --- dragging the dial ---------------------------------------------------

  /**
   * The setpoint is dragged, not only stepped -- which is what HA's own
   * thermostat dial does and the first thing anyone tries here.
   *
   * The service call happens on RELEASE, never during the drag. On the hall
   * unit every set_temperature is an infrared frame: transmitting one per
   * pointermove would fill the bridge's queue with setpoints nobody asked for
   * and leave the unit on whichever one happened to arrive last. So the drag
   * paints a preview from _drag and the release sends one frame.
   */
  _dialLimits(ent, pfx) {
    const fb = FALLBACK[pfx === "hall" ? "hall" : "bed"];
    return {
      lo: Number(this._attr(ent, "min_temp")) || fb.min,
      hi: Number(this._attr(ent, "max_temp")) || fb.max,
      step: Number(this._attr(ent, "target_temp_step")) || fb.step,
    };
  }

  /*
   * Ask once more, quietly, if the unit has not answered.
   *
   * Only for the values this unit drops -- one repeat of a command it has
   * already been given, six seconds later, which is what anyone does when a
   * press appears not to take. It is armed by the press rather than by
   * _send() so that the fan trim, which lands every time, does not get a
   * retry it has no use for.
   *
   * It fires at most once per press: a command that a unit is ignoring on
   * purpose must not turn into a card that keeps shouting it.
   *
   * Arming also marks the send `noisy`, which is what buys it SENT_GRACE. The
   * two belong together: this is the one control whose entity wanders on its
   * way to an answer, and it is the same wandering that makes a repeat worth
   * sending at all.
   */
  _armResend(ent, domain, service, field) {
    const pending = this._sent[ent];
    if (pending) pending.noisy = true;
    if (this._resend[ent]) window.clearTimeout(this._resend[ent]);
    this._resend[ent] = window.setTimeout(() => {
      delete this._resend[ent];
      const p = this._sent[ent];
      if (!p || p.retried) return;
      const live = Number(this._attr(ent, "temperature"));
      // Already landed while the timer ran. Nothing to repeat.
      if (Number.isFinite(live) && Math.abs(live - p.value) < 1e-9) return;
      p.retried = true;
      p.last = Date.now();
      // The repeat gets its own window to be answered in, shorter than the
      // first: by now the number has been on screen for six seconds already.
      p.at = Date.now() - (SENT_TTL - SENT_RETRY);
      const data = { entity_id: ent };
      data[field] = p.value;
      this._call(domain, service, data);
    }, SENT_RETRY);
  }

  /** A miss still worth showing, or null. See SENT_RETRY. */
  _missOf(ent) {
    const m = this._missed[ent];
    if (!m) return null;
    if (Date.now() - m.at > MISS_SHOWN) { delete this._missed[ent]; return null; }
    // The unit came round to it after all, by whatever route.
    const live = Number(this._attr(ent, "temperature"));
    if (Number.isFinite(live) && Math.abs(live - m.want) < 1e-9) {
      delete this._missed[ent];
      return null;
    }
    return m;
  }

  /**
   * Whether this unit, in the mode it is in now, will act on a setpoint at
   * all. See NO_SETPOINT_MODES.
   */
  _setpointFrozen(ent, pfx) {
    const modes = NO_SETPOINT_MODES[pfx === "hall" ? "hall" : "bed"];
    return !!modes && modes.indexOf(this._state(ent)) !== -1;
  }

  /** Which of the two units an entity belongs to. */
  _pfxOf(ent) {
    return this._config && ent === this._config.hall_climate ? "hall" : "bed";
  }

  _onDialDown(ev) {
    const node = ev.currentTarget;
    const pfx = node.getAttribute("data-dial");
    const c = this._config;
    const ent = pfx === "hall" ? c.hall_climate : c.bed_climate;
    if (!this._live(ent)) return;
    // Belt and braces: data-frozen already takes the ring's pointer events
    // away, but the knob is its own element inside the svg.
    if (this._setpointFrozen(ent, pfx)) return;
    if (ev.button !== undefined && ev.button > 0) return;
    const lim = this._dialLimits(ent, pfx);
    if (!(lim.hi > lim.lo)) return;

    // What is on screen, which is what the knob is drawn at -- a value sent
    // and not yet echoed included.
    const live = Number(this._attr(ent, "temperature"));
    const shown = this._settle(ent, Number.isFinite(live) ? live : null);
    const at = Number.isFinite(shown) ? (shown - lim.lo) / (lim.hi - lim.lo) : NaN;
    const hit = this._dialHit(ev.clientX, ev.clientY, node.getBoundingClientRect(), at);
    if (!hit) return;

    ev.preventDefault();
    try { node.setPointerCapture(ev.pointerId); } catch (err) { /* not fatal */ }
    this._drag = {
      pfx: pfx, ent: ent, id: ev.pointerId, lim: lim,
      // Seeded with what is drawn, so a press that snaps to the value
      // already shown is a grab and moves nothing.
      value: Number.isFinite(shown) ? shown : null,
      moved: false,
    };
    node.classList.add("dragging");
    // A press on the ring away from the knob is a deliberate "set it there";
    // a press ON the knob waits for the pointer to move.
    if (hit === "ring") this._dragTo(ev);
    else this._patch();
  }

  _onDialMove(ev) {
    if (!this._drag || this._drag.id !== ev.pointerId) return;
    ev.preventDefault();
    this._drag.moved = true;
    this._dragTo(ev);
  }

  /**
   * Follow the pointer.
   *
   * Two positions, not one. The VALUE snaps to the unit's own step -- and to
   * the step GRID rather than to a multiple of the step, because a unit whose
   * range starts at 16 with a 0.5 step has no setpoint at 16.25. The KNOB
   * does not: it sits wherever the pointer is.
   *
   * That split is the whole fix. A knob that could only stand on the steps
   * had twelve places to be on the living room dial -- it teleported 22.5
   * degrees at a time, and with the cursor near a boundary a few pixels of
   * hand shake flicked it between two of them. Following the pointer costs
   * nothing in honesty: the number underneath is still the value, and the
   * knob is never more than half a step from it.
   *
   * The repaint is the dial alone. The full one walks two cost boxes, ten
   * tiles and ten feature switches, and running that on every
   * pointermove is what made the knob lag the cursor.
   */
  /**
   * The step the pointer is on, sticky against the one already held.
   *
   * The knob is drawn at the VALUE, not at the pointer. Following the
   * pointer was an attempt to make a twelve-position dial feel continuous,
   * and it only moved the problem: it put every bit of a hand's noise on
   * screen, and no amount of filtering separated that noise from a slow
   * deliberate move of the same size. A dial with twelve settings has
   * twelve places for its knob. What it must not do is flicker between two
   * of them, and that is all this stops.
   */
  _snap(lim, frac, held) {
    const step = lim.step > 0 ? lim.step : 1;
    const at = (lim.hi - lim.lo) * Math.max(0, Math.min(1, frac)) / step;
    let n = Math.round(at);
    if (Number.isFinite(held)) {
      const cur = (held - lim.lo) / step;
      // Still nearer what it holds than the hysteresis allows leaving.
      if (Math.abs(at - cur) <= 0.5 + DRAG_HYST) n = Math.round(cur);
    }
    const v = Math.max(lim.lo, Math.min(lim.hi, lim.lo + n * step));
    return Math.round(v * 100) / 100;
  }

  _dragTo(ev) {
    const d = this._drag;
    const rect = ev.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    // Too near the centre to mean an angle. Hold, and wait for the pointer.
    if (!this._dragUsable(ev.clientX - (rect.left + rect.width / 2),
      ev.clientY - (rect.top + rect.height / 2), rect.width / 220)) return;
    const value = this._snap(d.lim,
      this._fracAt(ev.clientX, ev.clientY, rect), d.value);
    if (value === d.value) return;
    d.value = value;
    this._paintDial(d.pfx, (value - d.lim.lo) / (d.lim.hi - d.lim.lo),
      value.toFixed(d.lim.step < 1 ? 1 : 0), this._accOf(d.pfx), true);
  }

  _onDialUp(ev) {
    const d = this._drag;
    if (!d || d.id !== ev.pointerId) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
    ev.currentTarget.classList.remove("dragging");
    const value = d.value;
    const ent = d.ent;
    const was = Number(this._attr(ent, "temperature"));
    this._drag = null;
    // One frame, on release, and only if it actually says something new. The
    // sent value keeps the dial until the entity echoes it -- without that
    // the knob returns to `was` for as long as the call takes and then jumps.
    if (value !== null && !(Number.isFinite(was) && Math.abs(was - value) < 1e-9)) {
      this._send(ent, value, was);
      this._call("climate", "set_temperature", { entity_id: ent, temperature: value });
      this._armResend(ent, "climate", "set_temperature", "temperature");
    }
    this._patch();
  }

  // --- dragging the fan trim -----------------------------------------------

  /** The trim's own range. midea_ac_lan publishes 1-100, step 1. */
  _fineLimits() {
    const id = this._config.bed_fan_fine;
    const lo = Number(this._attr(id, "min"));
    const hi = Number(this._attr(id, "max"));
    const step = Number(this._attr(id, "step"));
    return {
      lo: Number.isFinite(lo) ? lo : 1,
      hi: Number.isFinite(hi) && hi > lo ? hi : 100,
      step: Number.isFinite(step) && step > 0 ? step : 1,
    };
  }

  _onFineDown(ev) {
    const ent = this._config.bed_fan_fine;
    if (!this._live(ent)) return;
    if (ev.button !== undefined && ev.button > 0) return;
    ev.preventDefault();
    const node = ev.currentTarget;
    try { node.setPointerCapture(ev.pointerId); } catch (err) { /* not fatal */ }
    node.classList.add("dragging");
    this._fine = { id: ev.pointerId, lim: this._fineLimits(), value: null };
    this._fineTo(ev);
  }

  _onFineMove(ev) {
    if (!this._fine || this._fine.id !== ev.pointerId) return;
    ev.preventDefault();
    this._fineTo(ev);
  }

  _fineTo(ev) {
    const f = this._fine;
    const rect = ev.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const value = this._snap(f.lim, frac, f.value);
    if (value === f.value) return;
    f.value = value;
    // The bar's own repaint, for the reason the dial has one.
    this._paintFine((value - f.lim.lo) / (f.lim.hi - f.lim.lo) * 100, value);
  }

  _onFineUp(ev) {
    const f = this._fine;
    if (!f || f.id !== ev.pointerId) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
    ev.currentTarget.classList.remove("dragging");
    const value = f.value;
    const ent = this._config.bed_fan_fine;
    const was = this._num(ent);
    this._fine = null;
    // One call, on release, and only when it says something new -- every
    // percentage sent to this unit is a command over its own LAN protocol.
    // The bar holds where it was dropped until the unit reports that number.
    if (value !== null && !(was !== null && Math.abs(was - value) < 1e-9)) {
      this._send(ent, value, was);
      this._call("number", "set_value", { entity_id: ent, value: value });
    }
    this._patch();
  }

  // --- render --------------------------------------------------------------

  _render() {
    if (!this._hass || !this._config) return;
    const print = this._optKey();
    if (!this._built || print !== this._optPrint) {
      this._optPrint = print;
      this._build();
      this._refreshCharts();
    } else if (this._config.tab === "rooms" && !this._dragging) {
      // The sample the recorder is about to store arrived with this hass;
      // put it on the end of every cached window rather than waiting out the
      // TTL. See _ingest.
      this._ingest();
    }
    this._patch();
  }

  /*
   * The one thing that forces a rebuild. Mode, fan and swing buttons
   * are drawn from the entity's own option lists, so a unit that comes back
   * online carrying a list it did not have while unavailable has to grow the
   * buttons for it. Everything else is patched in place.
   */
  _optKey() {
    const c = this._config;
    if (c.tab === "rooms") return "rooms";
    const hall = c.tab === "hall";
    const ent = hall ? c.hall_climate : c.bed_climate;
    const fb = FALLBACK[hall ? "hall" : "bed"];
    return [
      this._list(ent, "hvac_modes", fb.modes).join(","),
      this._list(ent, "fan_modes", fb.fans).join(","),
      this._list(ent, "swing_modes", fb.swings).join(","),
    ].join("|");
  }

  _tick() {
    if (!this._built) return;
    // The recorder backstop. `set hass` carries every live number already;
    // this only heals a window whose TTL has run out, and _inflight keeps a
    // slow reply from being asked for twice.
    if (!this._inflight.size && this._stale()) this._refreshCharts();
  }

  _build() {
    const c = this._config;
    const body = c.tab === "rooms" ? this._roomsHTML()
      : c.tab === "hall" ? this._hallHTML()
        : this._bedHTML();
    this.shadowRoot.innerHTML = "<style>" + STYLE + "</style>"
      + "<ha-card><div class='root'>" + body + "</div></ha-card>";
    // The painters above hold element references and the last value written
    // to each; every one of those elements has just been replaced.
    this._dial = {};
    this._fineNodes = null;
    // The root carrying --ctl has just been replaced with one that carries
    // nothing, so the accent has to be written again rather than remembered.
    this._accVar = null;
    this._el = {
      q: (sel) => this.shadowRoot.querySelector(sel),
      qa: (sel) => Array.from(this.shadowRoot.querySelectorAll(sel)),
    };
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this._el.qa(".dial").forEach((dial) => {
      dial.addEventListener("pointerdown", (ev) => this._onDialDown(ev));
      dial.addEventListener("pointermove", (ev) => this._onDialMove(ev));
      ["pointerup", "pointercancel"].forEach((n) =>
        dial.addEventListener(n, (ev) => this._onDialUp(ev)));
    });
    this._el.qa(".fine").forEach((fine) => {
      fine.addEventListener("pointerdown", (ev) => this._onFineDown(ev));
      fine.addEventListener("pointermove", (ev) => this._onFineMove(ev));
      ["pointerup", "pointercancel"].forEach((n) =>
        fine.addEventListener(n, (ev) => this._onFineUp(ev)));
    });
    this._el.qa(".plot").forEach((plot) => {
      // Pointer events, so one set of handlers covers mouse, pen and touch --
      // and so a drag that leaves the plot is still ours, through capture.
      plot.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
      plot.addEventListener("pointermove", (ev) => this._onPointerMove(ev));
      ["pointerup", "pointercancel"].forEach((n) =>
        plot.addEventListener(n, (ev) => this._onPointerUp(ev)));
      // passive:false, or preventDefault cannot stop the dashboard scrolling
      // out from under a zoom. A trackpad pinch arrives here as ctrl+wheel.
      plot.addEventListener("wheel", (ev) => this._onWheel(ev), { passive: false });
      plot.addEventListener("dblclick", () => this._resetView());
      plot.addEventListener("mousemove", (ev) => this._onHover(ev));
      // Three ways for the pointer to go away, because a touch never sends
      // mouseleave -- and a hover flag left stuck on would stop the live
      // redraw on every phone.
      ["mouseleave", "pointerleave", "pointercancel"].forEach((n) =>
        plot.addEventListener(n, () => this._leave()));
    });
    this._built = true;
  }

  /*
   * A zoomed viewport is not any of the presets, and lighting one up would
   * say it is. Nothing is lit until the view goes back to live.
   */
  _syncSegs() {
    if (!this._built) return;
    const live = this._view === null;
    this._el.qa("[data-act='range']").forEach((n) => {
      n.setAttribute("data-on",
        live && n.getAttribute("data-val") === this._range ? "1" : "0");
    });
  }

  _patch() {
    const tab = this._config.tab;
    if (tab === "rooms") this._patchRooms();
    else if (tab === "hall") this._patchHall();
    else this._patchBed();
  }

  // --- tab: rooms ----------------------------------------------------------

  _rooms() {
    const c = this._config;
    return [
      { key: "living", name: "Living room", temp: c.living_temp, hum: c.living_hum, color: ROOM_C.living },
      { key: "bedroom", name: "Bedroom", temp: c.bedroom_temp, hum: c.bedroom_hum, color: ROOM_C.bedroom },
      { key: "kitchen", name: "Kitchen", temp: c.kitchen_temp, hum: c.kitchen_hum, color: ROOM_C.kitchen },
    ];
  }

  /**
   * One room chart: three series over one axis, inside a plot you can grab.
   *
   * The plot is its own element rather than the svg because the pointer
   * handlers need a box whose width IS the data width -- the axis gutter is a
   * sibling, so a drag that started over the labels would otherwise map to a
   * time 44px to the left of the finger.
   */
  _chartHTML(chart, rooms) {
    const id = chart.id;
    const ax = [];
    const lines = [];
    for (let i = 0; i < GRID_LINES; i++) {
      ax.push("<div class='ch-ax' id='" + id + "-ax" + i + "'></div>");
      lines.push("<line id='" + id + "-gl" + i + "' x1='0' x2='" + CH_W
        + "' y1='0' y2='0' stroke='" + HAIR + "' stroke-width='1'></line>");
    }
    const paths = rooms.map((r) => "<path id='" + id + "-p-" + r.key + "' fill='none' stroke='"
      + r.color + "' stroke-width='1.8' stroke-linejoin='round' stroke-linecap='round'"
      + " vector-effect='non-scaling-stroke'></path>").join("");
    const dots = rooms.map((r) => "<div class='hv hvdot' id='" + id + "-hd-" + r.key
      + "' style='background:" + r.color + "'></div>").join("");
    const ticks = [];
    for (let i = 0; i < TICKS; i++) ticks.push("<div id='" + id + "-t" + i + "'></div>");

    const head = ["", "Now", "Min", "Max", "Mean"].map((h, i) =>
      "<div class='st-h'" + (i ? "" : " style='text-align:left'") + ">"
      + this._esc(h) + "</div>").join("");
    const rows = rooms.map((r) => "<div class='st-n' data-more='" + this._esc(r[chart.field]) + "'>"
      + "<span class='dot' style='background:" + r.color + "'></span>"
      + this._esc(r.name) + "</div>"
      + ["now", "min", "max", "mean"].map((k) => "<div class='st-v" + (k === "now" ? " now" : "")
        + "' id='" + id + "-" + k + "-" + r.key + "'>—</div>").join("")).join("");

    return "<div class='panel'>"
      + "<div class='ch-h'><div class='panel-t'>" + this._esc(chart.title) + "</div>"
      + "<div class='mono panel-n'>" + this._esc(chart.unit) + "</div>"
      + "<div class='grow'></div>"
      + "<div class='win' id='" + id + "-win'></div>"
      + "<div class='panel-n' id='" + id + "-note'></div></div>"
      + "<div class='ch-wrap'>" + ax.join("")
      + "<div class='plot' id='" + id + "-plot' data-chart='" + id + "'>"
      + "<svg class='ch-svg' id='" + id + "-svg' viewBox='0 0 " + CH_W + " " + CH_H
      + "' preserveAspectRatio='none'>"
      + "<defs><clipPath id='" + id + "-clip'><rect x='0' y='0' width='" + CH_W
      + "' height='" + CH_H + "'></rect></clipPath></defs>"
      + lines.join("")
      + "<g clip-path='url(#" + id + "-clip)'>" + paths + "</g></svg>"
      + "<div class='hv hvline' id='" + id + "-hl'></div>" + dots
      + "<div class='tip' id='" + id + "-tip'></div>"
      + "<div class='ch-note' id='" + id + "-empty' style='display:none'></div>"
      + "</div></div>"
      + "<div class='ch-ticks'>" + ticks.join("") + "</div>"
      + "<div class='stats' id='" + id + "-stats'>" + head + rows + "</div></div>";
  }

  _roomsHTML() {
    const rooms = this._rooms();
    const segs = RANGE_ORDER.map((k) => "<div class='seg' data-act='range' data-val='" + k
      + "' data-on='" + (k === this._range ? "1" : "0") + "'>"
      + this._esc(RANGES[k].label) + "</div>").join("");
    const cards = rooms.map((r) => "<div class='panel room'>"
      + "<div class='room-h'><span class='dot' style='background:" + r.color + "'></span>"
      + "<span class='room-n'>" + this._esc(r.name) + "</span><div class='grow'></div>"
      + "<span class='badges' id='rm-" + r.key + "-badge'><span class='badge'>—</span></span></div>"
      + "<div class='room-v'>"
      + "<div class='vbox' data-more='" + this._esc(r.temp) + "' style='cursor:pointer'>"
      + "<span class='big' id='rm-" + r.key + "-t'>—</span><span class='unit'>°C</span></div>"
      + "<div class='vbox' data-more='" + this._esc(r.hum) + "' style='cursor:pointer'>"
      + "<span class='mid' id='rm-" + r.key + "-h'>—</span><span class='unit-s'>%</span></div>"
      + "</div><div class='room-f'>"
      + "<div><div class='lbl'>Today min / max</div>"
      + "<div class='fval' id='rm-" + r.key + "-mm'>—</div></div>"
      + "<div><div class='lbl'>Dew point</div>"
      + "<div class='fval' id='rm-" + r.key + "-d'>—</div></div>"
      + "</div></div>").join("");
    return "<div class='head'><div><div class='h1'>Temperature &amp; humidity</div>"
      + "<div class='sub' id='rm-sub'>Three room sensors</div></div>"
      + "<div class='segs'>" + segs + "</div></div>"
      + "<div class='cards3'>" + cards + "</div>"
      + CHARTS.map((c) => this._chartHTML(c, rooms)).join("")
      + "<div class='hint'>Drag either chart to move through time, scroll or pinch to zoom; "
      + "double-click, or pick a range, to go back to live. Both charts share one window.</div>";
  }

  _patchRooms() {
    const el = this._el;
    const rooms = this._rooms();
    let newest = 0;
    let offline = 0;
    rooms.forEach((r) => {
      const t = this._num(r.temp);
      const h = this._num(r.hum);
      if (t === null && h === null) offline++;
      const st = this._stateObj(r.temp);
      if (st && st.last_updated) {
        const ts = Date.parse(st.last_updated);
        if (ts > newest) newest = ts;
      }
      el.q("#rm-" + r.key + "-badge").innerHTML = this._comfort(t, h).map((cf) =>
        "<span class='badge' title='" + this._esc(cf.label) + "' style='background:" + cf.bg
        + ";color:" + cf.fg + "'><ha-icon icon='" + cf.icon + "'></ha-icon>"
        + "<span class='badge-t'>" + this._esc(cf.label) + "</span></span>").join("");
      el.q("#rm-" + r.key + "-t").textContent = this._fmt(t, 1);
      el.q("#rm-" + r.key + "-h").textContent = this._fmt(h, 1);
      const d = this._dew(t, h);
      el.q("#rm-" + r.key + "-d").textContent = d === null ? "—" : d.toFixed(1) + " °C";

      // Today's extremes come from their own midnight-to-now window, so the
      // range buttons above cannot quietly change what "today" means.
      const today = this._hist.get(this._todayKey(r.temp));
      const mm = el.q("#rm-" + r.key + "-mm");
      if (today && today.pts.length) {
        let lo = Infinity, hi = -Infinity;
        for (const p of today.pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
        mm.textContent = lo.toFixed(1) + " / " + hi.toFixed(1) + " °C";
      } else {
        mm.textContent = today ? (today.note || "no history yet") : "…";
      }
    });
    el.q("#rm-sub").textContent = offline === rooms.length
      ? "Three room sensors — none reporting"
      : "Three room sensors, last updated " + this._hhmm(newest)
        + (offline ? " — " + offline + " not reporting" : "");
  }

  // --- the two A/C tabs share a hero --------------------------------------

  _heroHTML(pfx, title, blurb, controls, badges, plugEnt) {
    /*
     * The metered plug's own switch, hard right on the title line.
     *
     * It is the one control on either tab that is not the A/C: it cuts the
     * socket the unit hangs off, so it keeps working -- and keeps reading
     * true -- when the unit itself has stopped answering. That is why it
     * belongs up here rather than down in the panel of plug readings the
     * bedroom tab used to keep it in. A tab that has gone dark is a tab you
     * would have to scroll before finding the only thing still listening.
     *
     * Green for on, grey for off, and a dash while the plug itself is
     * unreachable. The plug is a Zigbee device on a different radio and goes
     * quiet for its own reasons, so it never borrows the unit's state.
     */
    const plug = !plugEnt ? ""
      : "<div class='pwr sm' id='" + pfx + "-plug' data-act='switch' data-ent='"
      + this._esc(plugEnt) + "'>"
      + "<span class='pdot' id='" + pfx + "-plug-dot'></span>"
      + "<span id='" + pfx + "-plug-l'>—</span></div>";
    return "<div class='hero' id='" + pfx + "-hero'><div class='hero-g'>"
      + "<div class='dial-col'><div class='dial' id='" + pfx + "-dial' data-dial='" + pfx + "'>"
      + "<svg viewBox='0 0 220 220'>"
      + "<path id='" + pfx + "-track' fill='none' stroke='#2b3137' stroke-width='"
      + DIAL_W + "' stroke-linecap='round'></path>"
      + "<path id='" + pfx + "-arc' class='dial-arc' fill='none' stroke-width='"
      + DIAL_W + "' stroke-linecap='round'></path>"
      + "<circle id='" + pfx + "-rmark' class='rmark' r='" + MARK_R + "' opacity='0'>"
      + "<title id='" + pfx + "-rmark-t'></title></circle>"
      + "<circle id='" + pfx + "-knob' class='knob' r='" + KNOB_R + "' fill='" + TXT
      + "' stroke='" + BG + "' stroke-width='3'></circle></svg>"
      + "<div class='dial-c'><div class='dial-k' id='" + pfx + "-mode'>—</div>"
      + "<div class='vbox'><span class='dial-v' id='" + pfx + "-target'>—</span>"
      + "<span class='dial-u'>°C</span></div>"
      + "<div class='dial-s' id='" + pfx + "-room'>—</div></div></div>"
      + "<div class='steps' id='" + pfx + "-steps'>"
      + "<div class='step' data-act='temp' data-val='-1'>−</div>"
      + "<div class='pwr' id='" + pfx + "-pwr' data-act='power'>"
      + "<span class='pdot' id='" + pfx + "-pdot'></span>"
      + "<span id='" + pfx + "-pwrl'>—</span></div>"
      + "<div class='step' data-act='temp' data-val='1'>+</div>"
      + "</div></div>"
      + "<div class='hero-r'><div><div class='hero-t'>"
      + "<div class='h1' id='" + pfx + "-h1'>" + this._esc(title) + "</div>"
      + badges + plug + "</div>"
      + "<div class='hero-d'>" + this._esc(blurb) + "</div></div>"
      + controls + "</div></div>"
      + "<div class='banner' id='" + pfx + "-banner' style='display:none'>"
      + "<span class='pdot' id='" + pfx + "-bdot' style='background:" + WARN + "'></span>"
      + "<span class='banner-x' id='" + pfx + "-btext'></span><div class='grow'></div>"
      + "<span class='banner-a' id='" + pfx + "-bact' style='display:none'></span></div>"
      + "</div>";
  }

  _pillsHTML(act, ent, ids, labels) {
    return ids.map((id) => "<div class='pill' data-act='" + act
      + "' data-ent='" + this._esc(ent) + "' data-val='" + this._esc(id) + "'>"
      + this._esc(labels[id] || id) + "</div>").join("");
  }

  _barHTML(act, ent, ids, labels, wrap) {
    return "<div class='bar" + (wrap ? " wrap" : "") + "'>" + ids.map((id) =>
      "<div class='tick' data-act='" + act + "' data-ent='" + this._esc(ent)
      + "' data-val='" + this._esc(id) + "'>" + this._esc(labels[id] || id) + "</div>").join("")
      + "</div>";
  }

  /**
   * Running cost, in its own box, on both A/C tabs.
   *
   * It used to be two tiles lost in a grid of ten, between "compressor hours"
   * and "setpoint delta" -- which is the wrong altitude for the number most
   * people open this dashboard to see. It is also the only number here that is
   * not a measurement but an arithmetic claim, and claims should show their
   * working: each figure carries the day/night kWh it was built from, and the
   * box carries the two rates and which one is in force right now.
   *
   * That last part is what makes a stuck tariff select visible. The zone chip
   * is derived from the clock, so if the meters were left booking to `day` at
   * two in the morning the chip says NIGHT while the split underneath shows
   * the night column not moving.
   */
  _costHTML(pfx, today, month) {
    const c = this._config;
    const box = (id, label, ent, note) =>
      "<div class='cost-c' data-more='" + this._esc(ent) + "'>"
      + "<div class='lbl'>" + this._esc(label) + "</div>"
      + "<div class='cost-v'><span class='cost-n' id='" + id + "'>—</span>"
      + "<span class='cost-u'>UAH</span></div>"
      + "<div class='cost-s' id='" + id + "-split'>" + this._esc(note) + "</div></div>";
    return "<div class='cost'>"
      + "<div class='ch-h'><div class='panel-t'>Running cost</div>"
      + "<div class='grow'></div>"
      + "<span class='zone' id='" + pfx + "-zone'>—</span></div>"
      + "<div class='cost-g'>"
      + box(pfx + "-cost-today", "Cost today", today, "")
      + box(pfx + "-cost-month", "Cost this month", month, "")
      + "</div>"
      + "<div class='rate'>"
      + "<div data-more='" + this._esc(c.tariff_day) + "' style='cursor:pointer'>Day "
      + "<b id='" + pfx + "-rate-day'>—</b> UAH/kWh</div>"
      + "<span class='sep'>|</span>"
      + "<div data-more='" + this._esc(c.tariff_night) + "' style='cursor:pointer'>Night "
      + "<b id='" + pfx + "-rate-night'>—</b> UAH/kWh</div>"
      + "<span class='sep'>|</span>"
      + "<div data-more='" + this._esc(c.tariff_night) + "' style='cursor:pointer'>Battery "
      + "<b id='" + pfx + "-rate-batt'>—</b> UAH/kWh</div>"
      + "<span class='sep'>|</span>"
      + "<div>23:00–07:00 is night · the pack only charges then, so what "
      + "comes out of it costs the night rate</div>"
      + "</div></div>";
  }

  _patchCost(pfx, today, month) {
    const c = this._config;
    const el = this._el;

    /*
     * Three zones. `battery` is what the A/C costs while the inverter is
     * running the house off the pack, and it is charged at the NIGHT rate --
     * the charger only fills the battery between 23:00 and 07:00, so
     * everything that comes back out of it was bought at the night price,
     * whatever the clock says when the compressor uses it.
     *
     * It gets its own colour rather than borrowing night's, because the two
     * are different facts about the same kilowatt-hour: night says when it
     * ran, battery says the house was off-grid while it did.
     */
    const z = this._state(c.tariff_zone);
    const ZONE = {
      night: { label: "Night rate", bg: "#291f47", fg: "#a78bfa" },
      battery: { label: "On battery", bg: "#0f3733", fg: "#4ad6c0" },
      day: { label: "Day rate", bg: "#3a2410", fg: "#ffb371" },
    };
    const look = ZONE[z] || ZONE.day;
    const zone = el.q("#" + pfx + "-zone");
    zone.textContent = this._live(c.tariff_zone) ? look.label : "—";
    zone.style.background = look.bg;
    zone.style.color = look.fg;

    [["-cost-today", today], ["-cost-month", month]].forEach(([suffix, ent]) => {
      el.q("#" + pfx + suffix).textContent = this._sfmt(ent, 2);
      // The split is an attribute of the cost sensor rather than three more
      // entities, because it is only ever read next to the total it explains.
      const d = Number(this._attr(ent, "day_kwh"));
      const n = Number(this._attr(ent, "night_kwh"));
      const b = Number(this._attr(ent, "battery_kwh"));
      const split = el.q("#" + pfx + suffix + "-split");
      if (Number.isFinite(d) && Number.isFinite(n)) {
        const row = (colour, kwh, label) =>
          "<div><span class='dot' style='background:" + colour + "'></span>"
          + kwh.toFixed(2) + " kWh " + label + "</div>";
        // Three counters, always all three. Showing battery only once it had
        // something in it was the first version and it was wrong: a bucket
        // that appears when it fills is a bucket nobody knows to look for,
        // and 0.00 kWh battery is a real answer -- it says the house ran the
        // whole period on the grid, which on this supply is worth knowing.
        split.innerHTML = row(ZONE.day.fg, d, "day")
          + row(ZONE.night.fg, n, "night")
          + row(ZONE.battery.fg, Number.isFinite(b) ? b : 0, "battery");
      } else {
        split.textContent = this._live(ent) ? "" : "waiting for the meter";
      }
    });

    el.q("#" + pfx + "-rate-day").textContent = this._sfmt(c.tariff_day, 2);
    el.q("#" + pfx + "-rate-night").textContent = this._sfmt(c.tariff_night, 2);
    // Battery reads the night input_number, because it IS the night rate --
    // not a copy of it that could drift. There is no third tariff to set.
    const rb = el.q("#" + pfx + "-rate-batt");
    if (rb) rb.textContent = this._sfmt(c.tariff_night, 2);
  }

  /** The room-vs-target chart, used by both A/C tabs. */
  _trackHTML(id, title, seriesName, color) {
    const ax = [];
    const lines = [];
    for (let i = 0; i < GRID_LINES; i++) {
      ax.push("<div class='ch-ax' id='" + id + "-ax" + i + "' style='font-size:10.5px;width:32px'></div>");
      lines.push("<line id='" + id + "-gl" + i + "' x1='0' x2='" + TR_W + "' y1='0' y2='0' stroke='"
        + HAIR + "' stroke-width='1'></line>");
    }
    const ticks = [];
    for (let i = 0; i < TICKS; i++) ticks.push("<div id='" + id + "-t" + i + "'></div>");
    return "<div class='panel'><div class='ch-h'>"
      + "<div class='panel-t'>" + this._esc(title) + "</div>"
      + "<div class='panel-n' id='" + id + "-note'></div><div class='grow'></div>"
      + "<div class='key'><div><span class='solid' style='background:" + color + "'></span>"
      + this._esc(seriesName) + "</div><div><span class='dash'></span>Target</div></div></div>"
      + "<div class='ch-wrap' style='padding-left:40px;margin-top:10px'>" + ax.join("")
      + "<svg class='ch-svg small' viewBox='0 0 " + TR_W + " " + TR_H + "' preserveAspectRatio='none'>"
      + lines.join("")
      + "<path id='" + id + "-target' fill='none' stroke='" + MUTED
      + "' stroke-width='1.6' stroke-dasharray='5 5' vector-effect='non-scaling-stroke'></path>"
      + "<path id='" + id + "-room' fill='none' stroke='" + color
      + "' stroke-width='1.8' stroke-linejoin='round' vector-effect='non-scaling-stroke'></path>"
      + "</svg><div class='ch-note' id='" + id + "-empty' style='display:none'></div></div>"
      + "<div class='ch-ticks' style='padding-left:40px'>" + ticks.join("") + "</div></div>";
  }

  /*
   * Patch-only, and shared by both A/C tabs: the dial, the power button and
   * the hero's ground. The step buttons learn their entity and their step
   * here rather than at build time, because a unit that was unavailable when
   * the card was built publishes no target_temp_step to build them with.
   */
  /*
   * Where the room actually is, on the same ring as where it is being sent.
   *
   * This was drawn once before and taken out again, and the way it was drawn
   * is why: same white as the knob, same radius, a few degrees away from it.
   * The dial then had two identical marks and only one of them was the
   * control -- at 25 with the room at 24 they nearly touched, and taking the
   * setpoint to 26 pulled them apart, which reads as the number and the dial
   * disagreeing rather than as two different quantities.
   *
   * So this one is deliberately not knob-like: a small dot ON the ring, a
   * third the width of the stroke it sits in, with no white fill and no
   * outline. A 22-unit white circle is the control; a 7-unit dot is a
   * marking, and nobody tries to drag it. The mono line under the number
   * still carries the reading itself and its provenance; the dot says where
   * that sits relative to the target without anyone having to subtract.
   *
   * A room OUTSIDE the dial's range is pinned to the end it went past, not
   * hidden. Hiding was the first answer and it is wrong: the hall dial starts
   * at 18 and a winter room sits below it for weeks, so the dot vanished for
   * the whole season it was most worth having -- and a missing dot looks
   * exactly like a missing sensor. Pinned, it says "below everything this
   * dial can show", which is true and is the thing you wanted to know.
   *
   * The number under the ring is the one that is exact, and it is right
   * there; the dot has never been the place to read a value off. The title
   * says which side it ran off, for anyone who hovers.
   */
  _paintRoomMark(pfx, room, lo, hi, targetFrac, acc) {
    const el = this._el;
    const mark = el.q("#" + pfx + "-rmark");
    if (!mark) return;
    const w = this._rmark || (this._rmark = {});
    // No reading, or a dial with no span, is the only thing that hides it.
    if (!Number.isFinite(room) || !(hi > lo)) {
      // The key goes with it, so coming back to the same reading still
      // repaints rather than trusting a cache written while hidden.
      if (w[pfx] !== "off") { mark.setAttribute("opacity", "0"); w[pfx] = "off"; }
      return;
    }
    const raw = (room - lo) / (hi - lo);
    const frac = Math.max(0, Math.min(1, raw));
    const beyond = raw < 0 ? "below" : raw > 1 ? "above" : "";

    /*
     * One dot, two colours, and it is not decoration.
     *
     * Before the knob the dot is on the painted arc, so it is drawn in the
     * card's own background -- a hole punched through the colour. After the
     * knob it is on the dark track, where a hole would be invisible, so it
     * takes the accent instead.
     *
     * Which side it falls on is the same fact the dot is there to tell you:
     * background means the room has not reached the setpoint yet, accent
     * means it has gone past. Picking one fixed colour would have made the
     * dot vanish on half the ring, which is the half you are looking at when
     * you care.
     */
    const past = frac > targetFrac;
    const fill = past ? (acc && acc.c) || MUTED : BG;
    const key = frac.toFixed(4) + "|" + fill + "|" + beyond;
    if (w[pfx] === key) return;
    w[pfx] = key;

    const at = this._arc(DIAL_CX, DIAL_CX, DIAL_R, frac);
    mark.setAttribute("cx", at.x);
    mark.setAttribute("cy", at.y);
    mark.setAttribute("fill", fill);
    mark.setAttribute("opacity", "1");
    const t = el.q("#" + pfx + "-rmark-t");
    if (t) {
      t.textContent = "Room " + room.toFixed(1) + " °C"
        + (beyond ? " — " + beyond + " everything this dial shows" : "");
    }
  }

  _patchHero(pfx, ent, acc, ctl, dead, room) {
    const el = this._el;
    const lim = this._dialLimits(ent, pfx);
    const lo = lim.lo, hi = lim.hi, step = lim.step;
    // A drag in progress owns the number: the entity still reads the old
    // setpoint, because nothing has been sent yet.
    const drag = this._drag && this._drag.pfx === pfx ? this._drag : null;
    const live = Number(this._attr(ent, "temperature"));
    const target = drag && drag.value !== null ? drag.value
      : this._settle(ent, Number.isFinite(live) ? live : null);
    const has = Number.isFinite(target);

    const hero = this._heroAcc(ent, acc, ctl, dead);
    el.q("#" + pfx + "-hero").style.background = this._ground(ent, acc, ctl, dead);
    // Remembered for the drag, which repaints the dial without coming back
    // through here.
    this._heroAccs[pfx] = hero;
    this._paintDial(pfx, has && hi > lo ? (target - lo) / (hi - lo) : 0,
      has ? target.toFixed(step < 1 ? 1 : 0) : "—", hero, has);
    el.q("#" + pfx + "-dial").setAttribute("data-dead", dead ? "1" : "0");

    /*
     * Frozen is not dead, and is drawn differently on purpose. Dead is "we
     * cannot reach this unit" and dims everything including the reading;
     * frozen is "this unit is not listening to THIS control right now", and
     * the number under it is still the setpoint it will use the moment the
     * mode changes -- so it stays at full strength and only stops taking a
     * drag.
     */
    const frozen = !dead && this._setpointFrozen(ent, pfx);
    el.q("#" + pfx + "-dial").setAttribute("data-frozen", frozen ? "1" : "0");
    this._paintRoomMark(pfx, Number(room), lo, hi,
                        has && hi > lo ? (target - lo) / (hi - lo) : 0, hero);

    /*
     * There is no tick for the room temperature on this ring any more.
     *
     * It was drawn in the same white as the knob, on the same radius, a few
     * degrees away from it -- so the dial had two identical marks and only
     * one of them was the control. It read as the setpoint disagreeing with
     * itself: at 25 with the room at 24 the two nearly touched, and taking
     * the setpoint to 26 pulled them apart, which looks exactly like the
     * number and the dial deviating from each other. The design this card
     * follows has one mark for one value, and the room temperature is on the
     * mono line under the number where it can be read rather than decoded.
     */

    // The title names the thermostat, so it opens it.
    el.q("#" + pfx + "-h1").setAttribute("data-more", ent);

    /*
     * The mode, inside the ring, above the number it qualifies.
     *
     * It is drawn in the control accent rather than in plain text, so the
     * word and the arc under it are visibly the same fact -- and it goes grey
     * the moment the unit stops answering, because "Cool" in teal on a dead
     * unit is a claim about a room nobody is cooling.
     */
    const mode = String(this._state(ent)).toLowerCase();
    const modeEl = el.q("#" + pfx + "-mode");
    if (modeEl) {
      this._setText(modeEl, dead ? "Offline"
        : mode === "off" ? "Off" : (MODE_LABEL[mode] || this._title(mode)));
      modeEl.style.color = dead ? MUTED : mode === "off" ? TXT2 : ctl.c;
      modeEl.setAttribute("data-more", ent);
    }

    const on = !dead && this._state(ent) !== "off";
    const pwr = el.q("#" + pfx + "-pwr");
    pwr.setAttribute("data-ent", ent);
    pwr.setAttribute("data-dead", dead ? "1" : "0");
    pwr.style.background = on ? hero.soft : BTN_BG;
    pwr.style.color = on ? hero.c : MUTED;
    pwr.style.borderColor = on ? hero.c + "77" : BTN_EDGE;
    pwr.style.boxShadow = on
      ? "0 0 0 1px " + hero.c + "33, 0 4px 14px " + hero.glow : "none";
    el.q("#" + pfx + "-pdot").style.background = on ? hero.c : "#555b61";
    el.q("#" + pfx + "-pwrl").textContent = dead ? "Offline" : on ? "On" : "Off";

    /*
     * The plug reads from the PLUG, and is deliberately not dimmed with the
     * rest of the tab: a dead tab is the state someone wants this button in.
     */
    const plug = el.q("#" + pfx + "-plug");
    if (plug) {
      const pent = plug.getAttribute("data-ent");
      const plugLive = this._live(pent);
      const plugOn = this._state(pent) === "on";
      plug.style.background = plugOn ? "#14321f" : BTN_BG;
      plug.style.borderColor = plugOn ? "#2c6b45" : BTN_EDGE;
      plug.style.color = plugOn ? OK : MUTED;
      el.q("#" + pfx + "-plug-dot").style.background = plugOn ? OK : "#555b61";
      el.q("#" + pfx + "-plug-l").textContent =
        !plugLive ? "Plug —" : plugOn ? "Plug on" : "Plug off";
    }

    /*
     * The two steps are dimmed separately from the power button, and that is
     * not tidiness: a unit with no readable setpoint has nothing to add 1 to,
     * but it can still be told to turn ON -- which on the bedroom unit is
     * exactly the button someone reaches for when the tab is grey. Dimming
     * the whole row would take it away at the one moment it is wanted.
     */
    el.qa("#" + pfx + "-steps [data-act='temp']").forEach((n, i) => {
      n.setAttribute("data-ent", ent);
      n.setAttribute("data-val", String(i === 0 ? -step : step));
      n.setAttribute("data-dead", dead || frozen || !has ? "1" : "0");
    });
  }

  /**
   * The arc, the knob and the number -- nothing else on the tab, and nothing
   * that has not actually changed.
   *
   * Both halves matter, and the second one is not micro-optimisation.
   * Assigning textContent tears the old text node down and builds a new one
   * even when the string is identical, which dirties layout; the dial's
   * centre is a flex column, so re-laying it out on every pointermove made
   * the number, the degree sign and the room line vibrate. Re-assigning the
   * drop-shadow does the same to paint. A drag calls this on every move, so
   * every write below is guarded by what was last written to it -- during a
   * normal drag that is two numbers, and nothing else touches the DOM.
   */
  _paintDial(pfx, frac, text, acc, has) {
    const n = this._dial[pfx] || (this._dial[pfx] = {
      track: this._el.q("#" + pfx + "-track"),
      arc: this._el.q("#" + pfx + "-arc"),
      knob: this._el.q("#" + pfx + "-knob"),
      text: this._el.q("#" + pfx + "-target"),
      w: {},
    });
    const w = n.w;
    const full = this._arc(DIAL_CX, DIAL_CX, DIAL_R, 1).d;
    if (w.track !== full) { n.track.setAttribute("d", full); w.track = full; }
    const a = this._arc(DIAL_CX, DIAL_CX, DIAL_R, frac);
    if (w.d !== a.d) { n.arc.setAttribute("d", a.d); w.d = a.d; }
    if (w.stroke !== acc.c) { n.arc.setAttribute("stroke", acc.c); w.stroke = acc.c; }
    const glow = "drop-shadow(0 0 12px " + acc.glow + ")";
    if (w.glow !== glow) { n.arc.style.filter = glow; w.glow = glow; }
    const op = has ? "1" : "0";
    if (w.op !== op) {
      n.arc.style.opacity = op;
      n.knob.style.opacity = op;
      w.op = op;
    }
    if (w.cx !== a.x) { n.knob.setAttribute("cx", a.x); w.cx = a.x; }
    if (w.cy !== a.y) { n.knob.setAttribute("cy", a.y); w.cy = a.y; }
    if (w.text !== text) { n.text.textContent = text; w.text = text; }
  }

  /** The accent this tab was last painted in, for the same reason. */
  _accOf(pfx) {
    return this._heroAccs[pfx] || ACC_UNKNOWN;
  }

  /** The fan trim's bar, knob and readout, guarded the same way. */
  _paintFine(pct, value) {
    const n = this._fineNodes || (this._fineNodes = {
      bar: this._el.q("#bed-fine-bar"),
      knob: this._el.q("#bed-fine-knob"),
      text: this._el.q("#bed-fan-fine"),
      w: {},
    });
    const w = n.w;
    const p = Math.max(0, Math.min(100, pct)).toFixed(2) + "%";
    if (w.p !== p) { n.bar.style.width = p; n.knob.style.left = p; w.p = p; }
    const rpm = this._num(this._config.bed_fan_rpm);
    const text = value.toFixed(0) + " % · " + (rpm === null ? "—" : rpm.toFixed(0) + " rpm");
    if (w.text !== text) { n.text.textContent = text; w.text = text; }
  }

  /** Paint one group of pills or ticks: exactly one of them is the live one. */
  /**
   * The current control accent, published to the stylesheet.
   *
   * Set on the card's root so any rule can reach it; written only when it
   * actually changes, because setProperty on every patch dirties style for
   * the whole subtree.
   */
  _setAccentVars(acc) {
    const root = this._el && this._el.q(".root");
    if (!root || this._accVar === acc.c) return;
    this._accVar = acc.c;
    root.style.setProperty("--ctl", acc.c);
    root.style.setProperty("--ctl-edge", acc.c + "3d");
    root.style.setProperty("--ctl-soft", acc.soft);
  }

  _paintChoice(nodes, current, acc, pill) {
    nodes.forEach((n) => {
      const on = n.getAttribute("data-val") === current;
      if (pill) {
        n.style.background = on ? acc.soft : "#191d20";
        n.style.color = on ? acc.c : TXT2;
        n.style.borderColor = on ? acc.c + "88" : "#2e3439";
        n.style.boxShadow = on ? "0 0 0 1px " + acc.c + "33, 0 4px 14px " + acc.glow : "none";
      } else {
        n.style.background = on ? acc.soft : "transparent";
        n.style.color = on ? acc.c : MUTED;
      }
    });
  }

  // --- tab: hall (the IR bridge) -------------------------------------------

  _hallHTML() {
    const c = this._config;
    const fb = FALLBACK.hall;
    const ent = c.hall_climate;
    const modes = this._list(ent, "hvac_modes", fb.modes).filter((m) => m !== "off");
    const fans = this._list(ent, "fan_modes", fb.fans);

    const controls = "<div class='ctl'>"
      + "<div><div class='ctl-l'>Mode</div><div class='pills' id='hall-modes'>"
      + this._pillsHTML("mode", ent, modes, MODE_LABEL) + "</div></div>"
      + "<div class='ctl-row'>"
      + "<div><div class='ctl-l'>Fan speed</div><div id='hall-fans'>"
      + this._barHTML("fan", ent, fans, FAN_LABEL) + "</div></div>"
      + "<div><div class='ctl-l'>Swing</div>"
      + "<div class='sw' id='hall-swing' data-act='swing-toggle' data-ent='" + this._esc(ent) + "'>"
      + "<div class='track' id='hall-swing-tr'><div></div></div>"
      + "<div class='sw-l' id='hall-swing-l'>—</div></div></div>"
      + "</div></div>"
      + "<div class='acts'>"
      + "<div class='act' data-act='script' data-ent='" + this._esc(c.hall_script_resend)
      + "'>Resend current state</div>"
      + "<div class='act' data-act='script' data-ent='" + this._esc(c.hall_script_swing_step)
      + "'>Nudge vane one step</div>"
      + "<div class='act' data-act='script' data-ent='" + this._esc(c.hall_script_swing_toggle)
      + "'>Force swing toggle</div>"
      + "</div>";
    const badges = "<span class='badge' id='hall-act-badge'>—</span>"
      + "<span class='badge' style='background:#2a1f0c;color:" + WARN + "'>Write-only</span>";
    const blurb = "Infrared control. Every setting below is what we last sent, not a confirmed "
      + "reading — the unit cannot be read back. The activity is the exception: it is "
      + "measured, off the plug meter on the A/C's own circuit.";

    const metrics = [
      ["hall-m-now", "Power now", "W", c.hall_power_now],
      ["hall-m-avg", "Average today", "W", c.hall_avg_draw],
      ["hall-m-et", "Energy today", "kWh", c.hall_energy_today],
      ["hall-m-em", "Energy this month", "kWh", c.hall_energy_month],
      ["hall-m-rt", "Runtime today", "h", c.hall_runtime_today],
      ["hall-m-ch", "Compressor today", "h", c.hall_compressor_hours],
      ["hall-m-cc", "Compressor starts", "today", c.hall_compressor_cycles],
      ["hall-m-sd", "Setpoint delta", "°C", c.hall_setpoint_delta],
    ].map((m) => "<div class='tile' data-more='" + this._esc(m[3]) + "'>"
      + "<div class='lbl'>" + this._esc(m[1]) + "</div><div class='tile-v'>"
      + "<span class='tile-n' id='" + m[0] + "'>—</span>"
      + "<span class='well-u'>" + this._esc(m[2]) + "</span></div></div>").join("");

    const statuses = [
      ["hall-s-bridge", "IR bridge", c.hall_bridge],
      ["hall-s-run", "Unit running", c.hall_running],
      ["hall-s-comp", "Compressor", c.hall_compressor],
      ["hall-s-drift", "State drift", c.hall_drift],
      ["hall-s-assumed", "Bridge believes", c.hall_assumed],
    ].map((s) => "<div class='row' data-more='" + this._esc(s[2]) + "'>"
      + "<span class='dot' id='" + s[0] + "-dot'></span>"
      + "<span class='row-l'>" + this._esc(s[1]) + "</span><div class='grow'></div>"
      + "<span class='row-v' id='" + s[0] + "'>—</span></div>").join("");

    const settings = [
      ["hall-c-standby", "Standby threshold", "W", c.hall_standby_watts],
      ["hall-c-comp", "Compressor threshold", "W", c.hall_compressor_watts],
    ].map((s) => "<div class='well' data-more='" + this._esc(s[3]) + "'>"
      + "<div class='lbl'>" + this._esc(s[1]) + "</div><div class='well-v'>"
      + "<span class='well-n' id='" + s[0] + "'>—</span>"
      + "<span class='well-u'>" + this._esc(s[2]) + "</span></div></div>").join("");

    /*
     * Cost and the meter tiles sit at the BOTTOM.
     *
     * They are the slowest-moving things on the tab -- a running total and a
     * day's averages -- and they were between the unit's controls and the
     * chart those controls are read against, which is the pair anyone opens
     * this tab to look at together. Money is what you scroll to, not what you
     * scroll past.
     */
    return this._heroHTML("hall", "Living room A/C", blurb, controls, badges,
                          c.hall_plug_switch)
      + "<div class='split'>"
      + this._trackHTML("hallch", "Room temperature vs target", "Room", ROOM_C.living)
      + "<div class='col'>"
      + "<div class='panel'><div class='panel-t' style='margin-bottom:14px'>Link &amp; state</div>"
      + "<div class='rows'>" + statuses + "</div></div>"
      + "<div class='panel'><div class='panel-t'>Inference settings</div>"
      + "<div class='panel-n' style='margin:4px 0 14px'>How a power reading becomes an activity. "
      + "Tap one to change it.</div>"
      + "<div class='wells mid'>" + settings + "</div></div>"
      + "</div></div>"
      + this._costHTML("hall", c.hall_cost_today, c.hall_cost_month)
      + "<div class='tiles'>" + metrics + "</div>";
  }

  _patchHall() {
    const c = this._config;
    const el = this._el;
    const ent = c.hall_climate;
    const dead = !this._live(ent);
    const acc = dead ? ACC_UNKNOWN
      : this._state(ent) === "off" ? ACC.off
        : this._acc(this._state(c.hall_action));

    const ctl = this._ctlAcc(ent, acc);
    const room = Number(this._attr(ent, "current_temperature"));
    const rh = Number(this._attr(ent, "current_humidity"));
    this._patchHero("hall", ent, acc, ctl, dead, room);
    // One mono line inside the ring, in the design's own wording. "room" is
    // the provenance: this unit cannot read itself, so the number is the
    // living-room sensor's. The title carries the long version.
    const sub = (Number.isFinite(room) ? "room " + room.toFixed(1) + " °C" : "no reading")
      + (Number.isFinite(rh) ? " · " + rh.toFixed(0) + " %" : "");
    const subEl = el.q("#hall-room");
    subEl.setAttribute("data-more", c.living_temp);
    this._setText(subEl, sub);
    subEl.title = "From the living room sensor — the A/C reports nothing back.";

    const badge = el.q("#hall-act-badge");
    badge.textContent = this._live(c.hall_activity) ? this._state(c.hall_activity) : "Unknown";
    badge.setAttribute("data-more", c.hall_activity);
    const hall = this._heroAcc(ent, acc, ctl, dead);
    badge.style.background = hall.soft;
    badge.style.color = hall.c;

    this._paintChoice(el.qa("#hall-modes .pill"), this._state(ent), ctl, true);
    this._paintChoice(el.qa("#hall-fans .tick"), this._attr(ent, "fan_mode"), ctl, false);
    // The scripts below take the same accent, through CSS rather than a paint
    // call: nothing about them changes per button, so one property on the
    // root beats three style writes on every patch.
    this._setAccentVars(ctl);

    const swing = this._attr(ent, "swing_mode") === "on";
    const sw = el.q("#hall-swing");
    sw.style.background = swing ? ctl.soft : INPUT_BG;
    sw.style.borderColor = swing ? ctl.c + "66" : INPUT_EDGE;
    sw.style.boxShadow = swing ? "0 0 0 1px " + ctl.c + "2e, 0 3px 12px " + ctl.glow : "none";
    const tr = el.q("#hall-swing-tr");
    tr.setAttribute("data-on", swing ? "1" : "0");
    tr.style.background = swing ? ctl.c : "#3a4146";
    const swl = el.q("#hall-swing-l");
    swl.textContent = swing ? "Swinging" : "Fixed";
    swl.style.color = swing ? ctl.c : MUTED;

    const set = (id, v) => { el.q("#" + id).textContent = v; };
    set("hall-m-now", this._sfmt(c.hall_power_now, 0));
    set("hall-m-avg", this._sfmt(c.hall_avg_draw, 0));
    set("hall-m-et", this._sfmt(c.hall_energy_today, 2));
    set("hall-m-em", this._sfmt(c.hall_energy_month, 2));
    set("hall-m-rt", this._sfmt(c.hall_runtime_today, 1));
    set("hall-m-ch", this._sfmt(c.hall_compressor_hours, 1));
    set("hall-m-cc", this._sfmt(c.hall_compressor_cycles, 0));
    set("hall-m-sd", this._sfmt(c.hall_setpoint_delta, 1));
    set("hall-c-standby", this._sfmt(c.hall_standby_watts, 0));
    set("hall-c-comp", this._sfmt(c.hall_compressor_watts, 0));
    this._patchCost("hall", c.hall_cost_today, c.hall_cost_month);

    /*
     * The status rows. binary_sensor.a_c_drift is device_class: problem, so
     * ON is BAD -- reading it the obvious way paints a healthy card during a
     * drift, which is the one moment this tab exists for.
     */
    const row = (id, label, color) => {
      const node = el.q("#" + id);
      node.textContent = label;
      node.style.color = color;
      el.q("#" + id + "-dot").style.background = color;
    };
    const bridgeLive = this._live(c.hall_bridge);
    const online = this._state(c.hall_bridge) === "on";
    row("hall-s-bridge", !bridgeLive ? "—" : online ? "Online" : "Offline",
      !bridgeLive ? DIM : online ? OK : BAD);
    const running = this._state(c.hall_running);
    row("hall-s-run", running === "on" ? "Yes" : running === "off" ? "No" : "—",
      running === "on" ? OK : DIM);
    const comp = this._state(c.hall_compressor);
    row("hall-s-comp", comp === "on" ? "Running" : comp === "off" ? "Stopped" : "—",
      comp === "on" ? OK : DIM);
    const drift = this._state(c.hall_drift) === "on";
    const driftLive = this._live(c.hall_drift);
    row("hall-s-drift", drift ? "Stale" : driftLive ? "In step" : "—",
      drift ? WARN : driftLive ? OK : DIM);
    const assumed = this._state(c.hall_assumed);
    row("hall-s-assumed",
      this._live(c.hall_assumed) ? (MODE_LABEL[assumed] || this._title(assumed)) : "—",
      MUTED);

    // --- the drift banner, which is the point of this tab --------------------
    const banner = el.q("#hall-banner");
    const act = el.q("#hall-bact");
    if (drift) {
      const st = this._stateObj(c.hall_drift);
      const detail = ((st && st.attributes && st.attributes.detail) || "")
        .replace(/\s+/g, " ").trim();
      const since = st && st.last_changed ? this._hhmm(Date.parse(st.last_changed)) : null;
      banner.style.display = "";
      el.q("#hall-btext").textContent = "State drift"
        + (since ? " since " + since : "") + " — "
        + (detail || "what we believe and what the meter says disagree.");
      act.style.display = "";
      act.textContent = "Resend state";
      act.setAttribute("data-act", "script");
      act.setAttribute("data-ent", c.hall_script_resend);
    } else {
      banner.style.display = "none";
      act.style.display = "none";
    }
  }

  // --- tab: bedroom (midea_ac_lan) -----------------------------------------

  _bedHTML() {
    const c = this._config;
    const fb = FALLBACK.bed;
    const ent = c.bed_climate;
    const modes = this._list(ent, "hvac_modes", fb.modes).filter((m) => m !== "off");
    const fans = this._list(ent, "fan_modes", fb.fans);
    const swings = this._list(ent, "swing_modes", fb.swings);

    /*
     * No presets. The six named speeds and the trim below them already cover
     * what this unit actually does, and the preset row was a second way to
     * say the same thing that the unit then contradicted -- picking Sleep
     * moves the fan, moving the fan clears Sleep. The trim is the slider
     * now, so the row it duplicated is the one worth keeping.
     */
    const controls = "<div class='ctl'>"
      + "<div><div class='ctl-l'>Mode</div><div class='pills' id='bed-modes'>"
      + this._pillsHTML("mode", ent, modes, MODE_LABEL) + "</div></div>"
      + "<div><div class='ctl-hd'><div class='ctl-l'>Fan speed</div>"
      + "<div class='mono' style='font-size:12px;color:" + MUTED + "' id='bed-fan-fine'>—</div></div>"
      + "<div id='bed-fans'>" + this._barHTML("fan", ent, fans, FAN_LABEL, true) + "</div>"
      + "<div class='fine' id='bed-fine' title='Drag to set the fan percentage'>"
      + "<div class='fine-t'><div id='bed-fine-bar'></div></div>"
      + "<div class='fine-k' id='bed-fine-knob'></div></div></div>"
      + "<div><div class='ctl-l'>Swing direction</div><div id='bed-swings'>"
      + this._barHTML("swing", ent, swings, SWING_LABEL) + "</div>"
      + "<div class='panel-n' style='margin-top:8px'>"
      + "This unit sometimes switches Frost protect on with a swing command. "
      + "The card switches it straight back off."
      + "</div></div>"
      + "</div>";
    const badges = "<span class='badge' id='bed-act-badge'>—</span>"
      + "<span class='badge' id='bed-link-badge'>—</span>";
    const blurb = "Local network control with two-way feedback. Every value on this tab is a "
      + "real reading from the unit — which is also why the whole tab can go dark at once, "
      + "when the unit stops answering.";

    const feats = BED_FEATURES.map(([label, slug], i) => {
      const ent = this._esc(BED_SWITCH_PREFIX + slug);
      return "<div class='feat' id='bed-f" + i + "' data-act='switch' data-ent='" + ent + "'>"
        + "<div class='track' id='bed-f" + i + "-tr'><div></div></div>"
        + "<div class='feat-l' id='bed-f" + i + "-l' data-more='" + ent + "'>"
        + this._esc(label) + "</div></div>";
    }).join("");

    const plugMetrics = [
      ["bed-p-w", "Power draw", "W", c.plug_power],
      ["bed-p-a", "Current", "A", c.plug_current],
      ["bed-p-v", "Voltage", "V", c.plug_voltage],
      ["bed-p-e", "Total energy", "kWh", c.plug_energy],
    ].map((m) => "<div class='well' data-more='" + this._esc(m[3]) + "'>"
      + "<div class='lbl'>" + this._esc(m[1]) + "</div><div class='well-v'>"
      + "<span class='well-n' id='" + m[0] + "'>—</span>"
      + "<span class='well-u'>" + this._esc(m[2]) + "</span></div></div>").join("");

    const plugSettings = [
      ["bed-ps-lock", "Child lock", c.plug_child_lock],
      ["bed-ps-cd", "Countdown timer", c.plug_countdown],
      ["bed-ps-mem", "Power outage memory", c.plug_outage_memory],
      ["bed-ps-ind", "Indicator mode", c.plug_indicator],
    ].map((s) => "<div class='row' data-more='" + this._esc(s[2]) + "'>"
      + "<span class='row-l' style='color:" + TXT2 + "'>" + this._esc(s[1]) + "</span>"
      + "<div class='grow'></div>"
      + "<span class='row-v' style='color:" + MUTED + "' id='" + s[0] + "'>—</span></div>").join("");

    const readouts = [
      ["bed-r-it", "Indoor temp", "°C", c.bed_indoor_temp, TXT],
      ["bed-r-ih", "Indoor humidity", "%", c.bed_indoor_hum, TXT],
      ["bed-r-ot", "Outdoor temp", "°C", c.bed_outdoor_temp, TXT],
      ["bed-r-cf", "Compressor freq", "Hz", c.bed_compressor_freq, TXT],
      ["bed-r-fs", "Indoor fan", "rpm", c.bed_fan_rpm, TXT],
      ["bed-r-ec", "Error code", "", c.bed_error, TXT],
      ["bed-r-ia", "Indoor ambient", "°C", c.bed_indoor_ambient, TXT2],
      ["bed-r-ic", "Indoor coil", "°C", c.bed_indoor_coil, TXT2],
      ["bed-r-oc", "Outdoor coil", "°C", c.bed_outdoor_coil, TXT2],
      ["bed-r-oa", "Outdoor ambient", "°C", c.bed_outdoor_ambient, TXT2],
      ["bed-r-dp", "Discharge pipe", "°C", c.bed_discharge_pipe, TXT2],
    ].map((r) => "<div class='well' data-more='" + this._esc(r[3]) + "'>"
      + "<div class='lbl'>" + this._esc(r[1]) + "</div><div class='well-v'>"
      + "<span class='well-n' id='" + r[0] + "' style='color:" + r[4] + "'>—</span>"
      + "<span class='well-u'>" + this._esc(r[2]) + "</span></div></div>").join("");

    /*
     * The same ten meter-derived tiles the hall tab has, from the same kind
     * of plug. They are on this tab for a reason the hall's are not: this
     * unit reports its own compressor frequency and fan rpm, so it is easy to
     * assume the plug adds nothing -- but the unit reports NONE of it while
     * it is off, and "what did it draw today" is asked precisely then. Every
     * tile below keeps working through an outage, because the plug is a
     * different device on a different radio.
     */
    const metrics = [
      ["bed-m-now", "Power now", "W", c.plug_power],
      ["bed-m-avg", "Average today", "W", c.bed_avg_draw],
      ["bed-m-et", "Energy today", "kWh", c.bed_energy_today],
      ["bed-m-em", "Energy this month", "kWh", c.bed_energy_month],
      ["bed-m-rt", "Runtime today", "h", c.bed_runtime_today],
      ["bed-m-ch", "Compressor today", "h", c.bed_compressor_hours],
      ["bed-m-cc", "Compressor starts", "today", c.bed_compressor_cycles],
      ["bed-m-sd", "Setpoint delta", "°C", c.bed_setpoint_delta],
    ].map((m) => "<div class='tile' data-more='" + this._esc(m[3]) + "'>"
      + "<div class='lbl'>" + this._esc(m[1]) + "</div><div class='tile-v'>"
      + "<span class='tile-n' id='" + m[0] + "'>—</span>"
      + "<span class='well-u'>" + this._esc(m[2]) + "</span></div></div>").join("");

    const settings = [
      ["bed-c-standby", "Standby threshold", "W", c.bed_standby_watts],
      ["bed-c-comp", "Compressor threshold", "W", c.bed_compressor_watts],
    ].map((sx) => "<div class='well' data-more='" + this._esc(sx[3]) + "'>"
      + "<div class='lbl'>" + this._esc(sx[1]) + "</div><div class='well-v'>"
      + "<span class='well-n' id='" + sx[0] + "'>—</span>"
      + "<span class='well-u'>" + this._esc(sx[2]) + "</span></div></div>").join("");

    // Cost and the meter tiles last, for the reason the hall tab gives.
    return this._heroHTML("bed", "Bedroom A/C", blurb, controls, badges, c.plug_switch)
      + "<div class='panel'><div class='ch-h'><div class='panel-t'>Unit features</div>"
      + "<div class='panel-n' id='bed-feat-count'>—</div></div>"
      + "<div class='feats'>" + feats + "</div></div>"
      + "<div class='split'>"
      + this._trackHTML("bedch", "Indoor temperature vs target", "Indoor", ROOM_C.bedroom)
      + "<div class='panel'>"
      + "<div class='panel-t' style='margin-bottom:14px'>Metered plug</div>"
      + "<div class='wells tight'>" + plugMetrics + "</div>"
      + "<div class='rows' style='margin-top:14px;padding-top:6px;border-top:1px solid " + HAIR + "'>"
      + plugSettings + "</div>"
      + "<div class='panel-n' style='margin:14px 0 10px'>How a power reading becomes an "
      + "activity. Tap one to change it.</div>"
      + "<div class='wells mid'>" + settings + "</div></div>"
      + "</div>"
      + "<div class='panel'><div class='ch-h'><div class='panel-t'>Sensor readouts</div>"
      + "<div class='panel-n'>reported by the unit</div></div>"
      + "<div class='wells'>" + readouts + "</div></div>"
      + this._costHTML("bed", c.bed_cost_today, c.bed_cost_month)
      + "<div class='tiles'>" + metrics + "</div>";
  }

  _patchBed() {
    const c = this._config;
    const el = this._el;
    const ent = c.bed_climate;
    const dead = !this._live(ent);
    // The unit's own action when it is talking, the plug's when it is not.
    const action = this._live(ent) ? this._attr(ent, "hvac_action")
      : (this._live(c.bed_action) ? this._state(c.bed_action) : null);
    const acc = action ? this._acc(action)
      : dead ? ACC_UNKNOWN
        : this._state(ent) === "off" ? ACC.off : ACC_UNKNOWN;

    /*
     * The unit's own indoor reading is the one to show, and the Aqara sensor
     * in the same room is the fallback -- the unit stops reporting the moment
     * its plug is cut, and a thermostat with no current temperature at all is
     * less use than one quoting the sensor a metre away. The label says which
     * it is, because they do not always agree.
     */
    const ctl = this._ctlAcc(ent, acc);
    const unitTemp = this._num(c.bed_indoor_temp);
    const room = unitTemp === null ? this._num(c.bedroom_temp) : unitTemp;
    const rh = unitTemp === null ? this._num(c.bedroom_hum) : this._num(c.bed_indoor_hum);
    this._patchHero("bed", ent, acc, ctl, dead, room);
    // The design's one mono line, and its first word is the provenance:
    // "indoor" is the unit's own thermometer, "room" the Aqara sensor it
    // falls back to when the unit stops answering.
    const subEl = el.q("#bed-room");
    // Whichever thermometer the reading came from is the one it opens.
    subEl.setAttribute("data-more", unitTemp === null ? c.bedroom_temp : c.bed_indoor_temp);
    this._setText(subEl, room === null ? "no reading"
      : (unitTemp === null ? "room " : "indoor ") + room.toFixed(1) + " °C"
        + (rh === null ? "" : " · " + rh.toFixed(0) + " %"));
    subEl.title = unitTemp === null
      ? "From the bedroom sensor — the unit is not reporting."
      : "Reported by the unit.";

    /*
     * The badge prefers the MEASURED activity over the unit's own hvac_action,
     * and keeps working when the unit does not. `sensor.bedroom_a_c_activity`
     * is derived from the plug, so a unit that has dropped off the LAN still
     * reports whether its compressor is running -- which is the single most
     * useful thing to know about an appliance that has stopped answering.
     */
    const badge = el.q("#bed-act-badge");
    badge.textContent = this._live(c.bed_activity) ? this._state(c.bed_activity)
      : dead ? "Offline"
        : this._state(ent) === "off" ? "Off"
          : action ? (MODE_LABEL[action] || this._title(action)) : "On";
    badge.setAttribute("data-more", c.bed_activity);
    const bedHero = this._heroAcc(ent, acc, ctl, dead);
    badge.style.background = bedHero.soft;
    badge.style.color = bedHero.c;
    const link = el.q("#bed-link-badge");
    link.setAttribute("data-more", ent);
    link.textContent = dead ? "No link" : "Live feedback";
    link.style.background = dead ? "#3a1414" : "#14321f";
    link.style.color = dead ? BAD : OK;

    this._paintChoice(el.qa("#bed-modes .pill"), this._state(ent), ctl, true);
    this._paintChoice(el.qa("#bed-fans .tick"), this._attr(ent, "fan_mode"), ctl, false);
    this._paintChoice(el.qa("#bed-swings .tick"), this._attr(ent, "swing_mode"), ctl, false);

    /*
     * The fan trim. A drag in progress owns the number the same way the dial
     * does -- the entity still reads what it read before the grab, because
     * nothing has been sent yet -- so the preview wins until the release.
     */
    const lim = this._fineLimits();
    const held = this._fine && this._fine.value !== null ? this._fine.value : null;
    const fine = held !== null ? held : this._settle(c.bed_fan_fine, this._num(c.bed_fan_fine));
    const rpm = this._num(c.bed_fan_rpm);
    el.q("#bed-fan-fine").textContent = (fine === null ? "—" : fine.toFixed(0) + " %")
      + " · " + (rpm === null ? "—" : rpm.toFixed(0) + " rpm");
    const pct = fine === null ? 0
      : Math.max(0, Math.min(100, (fine - lim.lo) / (lim.hi - lim.lo) * 100));
    const bar = el.q("#bed-fine-bar");
    bar.style.width = pct + "%";
    bar.style.background = ctl.c;
    const fineKnob = el.q("#bed-fine-knob");
    fineKnob.style.left = pct + "%";
    fineKnob.style.opacity = fine === null ? "0" : "1";
    el.q("#bed-fine").setAttribute("data-dead", this._live(c.bed_fan_fine) ? "0" : "1");

    /*
     * The feature switches. Two states on the switch and a third on the tile:
     * the whole unit goes quiet whenever its plug is cut, and a toggle drawn
     * `off` then is a lie -- nobody turned it off, nobody can turn it on.
     * `· offline` on the label is the difference.
     */
    let on = 0;
    BED_FEATURES.forEach(([label, slug], i) => {
      const node = el.q("#bed-f" + i);
      const tr = el.q("#bed-f" + i + "-tr");
      const lab = el.q("#bed-f" + i + "-l");
      const live = this._live(BED_SWITCH_PREFIX + slug);
      const isOn = live && this._state(BED_SWITCH_PREFIX + slug) === "on";
      if (isOn) on++;
      node.setAttribute("data-dead", live ? "0" : "1");
      node.style.background = isOn ? ctl.soft : WELL;
      node.style.borderColor = isOn ? ctl.c + "77" : INPUT_EDGE;
      node.style.boxShadow = isOn ? "0 0 0 1px " + ctl.c + "2e, 0 3px 12px " + ctl.glow : "none";
      tr.setAttribute("data-on", isOn ? "1" : "0");
      tr.style.background = isOn ? ctl.c : "#3a4146";
      lab.style.color = isOn ? TXT : MUTED;
      lab.textContent = label + (live ? "" : " · offline");
    });
    el.q("#bed-feat-count").textContent = dead
      ? "unit offline — nothing to report"
      : on + " of " + BED_FEATURES.length + " on";

    // --- the plug, which is the one thing here that stays online -------------
    // Its button is in the hero now and painted there. These two are what the
    // offline banner below reads, to tell "its plug is off" apart from "it has
    // dropped off the network".
    const plugLive = this._live(c.plug_switch);
    const plugOn = this._state(c.plug_switch) === "on";

    const set = (id, v) => { el.q("#" + id).textContent = v; };
    set("bed-p-w", this._sfmt(c.plug_power, 0));
    set("bed-p-a", this._sfmt(c.plug_current, 2));
    set("bed-p-v", this._sfmt(c.plug_voltage, 0));
    set("bed-p-e", this._sfmt(c.plug_energy, 2));

    set("bed-m-now", this._sfmt(c.plug_power, 0));
    set("bed-m-avg", this._sfmt(c.bed_avg_draw, 0));
    set("bed-m-et", this._sfmt(c.bed_energy_today, 2));
    set("bed-m-em", this._sfmt(c.bed_energy_month, 2));
    set("bed-m-rt", this._sfmt(c.bed_runtime_today, 1));
    set("bed-m-ch", this._sfmt(c.bed_compressor_hours, 1));
    set("bed-m-cc", this._sfmt(c.bed_compressor_cycles, 0));
    set("bed-m-sd", this._sfmt(c.bed_setpoint_delta, 1));
    set("bed-c-standby", this._sfmt(c.bed_standby_watts, 0));
    set("bed-c-comp", this._sfmt(c.bed_compressor_watts, 0));
    this._patchCost("bed", c.bed_cost_today, c.bed_cost_month);

    const word = (id) => (this._live(id) ? this._title(this._state(id)) : "—");
    set("bed-ps-lock", word(c.plug_child_lock));
    const cd = this._num(c.plug_countdown);
    set("bed-ps-cd", cd === null ? "—" : cd <= 0 ? "Not set" : cd.toFixed(0) + " s");
    set("bed-ps-mem", word(c.plug_outage_memory));
    set("bed-ps-ind", word(c.plug_indicator));

    set("bed-r-it", this._sfmt(c.bed_indoor_temp, 1));
    set("bed-r-ih", this._sfmt(c.bed_indoor_hum, 1));
    set("bed-r-ot", this._sfmt(c.bed_outdoor_temp, 1));
    set("bed-r-cf", this._sfmt(c.bed_compressor_freq, 0));
    set("bed-r-fs", this._sfmt(c.bed_fan_rpm, 0));
    set("bed-r-ia", this._sfmt(c.bed_indoor_ambient, 1));
    set("bed-r-ic", this._sfmt(c.bed_indoor_coil, 1));
    set("bed-r-oc", this._sfmt(c.bed_outdoor_coil, 1));
    set("bed-r-oa", this._sfmt(c.bed_outdoor_ambient, 1));
    set("bed-r-dp", this._sfmt(c.bed_discharge_pipe, 1));

    // No error is the normal case and reads as a dash, not as a zero -- a
    // green "0" in a grid of temperatures looks like a reading.
    const errLive = this._live(c.bed_error);
    const err = this._state(c.bed_error);
    const clean = !errLive || err === "0" || err === "none" || err === "";
    const errEl = el.q("#bed-r-ec");
    errEl.textContent = clean ? "—" : err;
    errEl.style.color = !errLive ? TXT2 : clean ? OK : BAD;

    // --- the offline banner --------------------------------------------------
    const banner = el.q("#bed-banner");
    const act = el.q("#bed-bact");
    if (dead) {
      const byPlug = plugLive && !plugOn;
      banner.style.display = "";
      el.q("#bed-bdot").style.background = byPlug ? WARN : BAD;
      el.q("#bed-btext").textContent = byPlug
        ? "The unit is not answering because its plug is off. Everything below is the last state we saw."
        : "The unit is not answering on the network. Everything below is the last state we saw.";
      if (byPlug) {
        act.style.display = "";
        act.textContent = "Switch the plug on";
        act.style.color = OK;
        act.setAttribute("data-act", "switch");
        act.setAttribute("data-ent", c.plug_switch);
      } else {
        act.style.display = "none";
      }
    } else if (this._missOf(c.bed_climate)) {
      /*
       * A press that went out twice and never landed, said plainly. The
       * alternative is what this looked like before: the number moves, sits
       * there for a few seconds and slides back, with nothing to distinguish
       * a unit that ignored the command from a button that did not register
       * it. Naming both numbers is the difference.
       */
      const miss = this._missOf(c.bed_climate);
      banner.style.display = "";
      el.q("#bed-bdot").style.background = WARN;
      el.q("#bed-btext").textContent =
        "The unit did not take " + miss.want.toFixed(1) + " °C — it is still on "
        + miss.got.toFixed(1) + ". It was asked twice. This unit drops a setpoint "
        + "now and then; asking again usually works.";
      act.style.display = "";
      act.textContent = "Ask again";
      act.style.color = WARN;
      act.setAttribute("data-act", "resend");
      act.setAttribute("data-ent", c.bed_climate);
      act.setAttribute("data-val", String(miss.want));
    } else if (this._setpointFrozen(c.bed_climate, "bed")) {
      /*
       * The one state where a control is drawn and does nothing, said out
       * loud. Without this the dimmed "-" is just a dimmed "-": the reader
       * knows it stopped working, not that the unit stopped listening or
       * that one tap on Cool brings it back.
       */
      banner.style.display = "";
      el.q("#bed-bdot").style.background = WARN;
      el.q("#bed-btext").textContent =
        "In Fan only the unit ignores the target temperature — it keeps the "
        + "one below and aims at nothing. The dial and the steps come back in "
        + "Cool, Heat or Auto.";
      act.style.display = "";
      act.textContent = "Switch to Cool";
      act.style.color = WARN;
      act.setAttribute("data-act", "mode");
      act.setAttribute("data-ent", c.bed_climate);
      act.setAttribute("data-val", "cool");
    } else {
      banner.style.display = "none";
      act.style.display = "none";
    }
  }

  // --- history -------------------------------------------------------------

  /** Which entities the drawn tab needs, and under which cache key. */
  _specs() {
    const c = this._config;
    if (c.tab === "rooms") {
      const rooms = this._rooms();
      return CHARTS.reduce((acc, ch) => acc.concat(rooms.map((r) => ({
        key: ch.prefix + r.key, ent: r[ch.field], chart: ch.id, room: r.key,
      }))), []);
    }
    const hall = c.tab === "hall";
    return [
      { key: "room", ent: hall ? c.living_temp : c.bed_indoor_temp },
      { key: "target", ent: hall ? c.hall_climate : c.bed_climate, attr: "temperature" },
    ];
  }

  // --- the viewport --------------------------------------------------------

  /**
   * What the x axis covers for a given window of data.
   *
   * Three cases, and the middle one is the interesting one. No view is the
   * preset, edge to edge. A FOLLOWING view keeps its span but takes its right
   * edge from the data, so zooming into the last five minutes keeps updating
   * instead of freezing. A pinned view is a window in the past and does not
   * move at all.
   */
  _domainX(rec) {
    const v = this._view;
    if (!v) return { t0: rec.start, t1: rec.end };
    if (v.follow) return { t0: rec.end - (v.end - v.start), t1: rec.end };
    return { t0: v.start, t1: v.end };
  }

  /** Smallest preset whose window covers `span`, for the live fetch. */
  _presetFor(span) {
    for (const k of RANGE_ORDER) {
      if (RANGES[k].hours * 3600000 >= span - 1000) return k;
    }
    return RANGE_ORDER[RANGE_ORDER.length - 1];
  }

  _pinKey(key, start, end) {
    return key + "|@" + Math.round(start / 1000) + "-" + Math.round(end / 1000);
  }

  /**
   * Move the viewport, clamped to what can actually be drawn.
   *
   * The right edge cannot pass now, the span is held between a minute and the
   * longest preset, and running into either end slides the window rather than
   * squashing it -- a pan that hits `now` stops moving instead of stretching.
   * Landing on now re-arms `follow`, so dragging back to the right edge is how
   * you rejoin the live chart without reaching for a preset.
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
   * A gesture in progress: redraw from what is already cached so the charts
   * track the finger, and ask the recorder only once it settles. Panning a
   * week at 60fps would otherwise be a hundred history queries.
   */
  _applyView(start, end) {
    this._setView(start, end);
    this._syncSegs();
    this._drawCharts();
    if (this._viewTimer) window.clearTimeout(this._viewTimer);
    this._viewTimer = window.setTimeout(() => {
      this._viewTimer = null;
      this._refreshCharts();
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
    this._refreshCharts();
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
    this._gesture = {
      base: { t0: this._dom.t0, t1: this._dom.t1 },
      rect: node.getBoundingClientRect(),
      xs: xs.slice(),
      dist: xs.length > 1 ? Math.abs(xs[0] - xs[1]) : 0,
      mid: xs.length > 1 ? (xs[0] + xs[1]) / 2 : xs[0],
    };
    this._dragging = xs.length > 0;
    if (this._dragging) this._hideHover();
    this._el.qa(".plot").forEach((n) => n.classList.toggle("grabbing", this._dragging));
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
    this._applyView(g.base.t0 - (dx / Math.max(1, g.rect.width)) * span,
      g.base.t1 - (dx / Math.max(1, g.rect.width)) * span);
  }

  _onPointerUp(ev) {
    if (!this._pointers.delete(ev.pointerId)) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
    // A pinch that loses one finger becomes a drag, from where that finger is.
    if (this._pointers.size) { this._beginGesture(ev.currentTarget); return; }
    this._gesture = null;
    this._dragging = false;
    this._el.qa(".plot").forEach((n) => n.classList.remove("grabbing"));
  }

  /**
   * Wheel zooms, and takes the event: over a 250px plot the alternative is a
   * dashboard that scrolls out from under the gesture. A trackpad pinch lands
   * here as ctrl+wheel and needs no separate handling; deltaMode 1 is a mouse
   * reporting lines rather than pixels.
   */
  _onWheel(ev) {
    if (!this._dom) return;
    ev.preventDefault();
    const base = { t0: this._dom.t0, t1: this._dom.t1 };
    const step = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 0.5 : 0.0022;
    const f = Math.max(0.25, Math.min(4, Math.exp(-ev.deltaY * step)));
    this._zoomFrom(base, this._timeAt(ev.clientX, ev.currentTarget.getBoundingClientRect(), base), f);
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

  /**
   * The window's mean, weighted by TIME rather than by sample count.
   *
   * A Home Assistant state is a step function: it holds the value it was given
   * until the next row replaces it. Recorder rows are irregular -- a sensor
   * fires ten times through a draughty minute and once through a still hour --
   * so averaging the ROWS lets that one minute outvote the hour it sat inside.
   *
   * It also has to be, now that _decimate keeps each bucket's extremes rather
   * than an even stride: those two rows are on purpose the bucket's most
   * unusual pair, so counting them equally would drag the mean toward whichever
   * way the series happened to spike.
   */
  _mean(pts) {
    if (!pts.length) return null;
    if (pts.length === 1) return pts[0][1];
    let span = 0, acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dt = pts[i + 1][0] - pts[i][0];
      if (dt <= 0) continue;
      acc += pts[i][1] * dt;
      span += dt;
    }
    return span > 0 ? acc / span : pts[pts.length - 1][1];
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
    const d = Math.round(h / 24);
    return d + (d === 1 ? " day" : " days");
  }

  _stamp(t, span) {
    const d = new Date(t);
    const q = (v) => String(v).padStart(2, "0");
    const hm = q(d.getHours()) + ":" + q(d.getMinutes());
    return span > 24 * 3600000
      ? q(d.getDate()) + "." + q(d.getMonth() + 1) + " " + hm
      : hm + ":" + q(d.getSeconds());
  }

  /**
   * What the window is, in words. A preset keeps the name it was given; a
   * viewport still ending at now is "last <span>"; one panned into the past
   * has no relationship to now left to describe, so it states its two edges.
   */
  _winLabel(d) {
    if (!this._view) return "";
    const span = d.t1 - d.t0;
    if (this._view.follow) return "last " + this._spanWords(span);
    return this._stamp(d.t0, span) + " – " + this._stamp(d.t1, span);
  }

  _stale() {
    // A pinned window is history: it has already happened and the recorder
    // has nothing to add to it.
    if (this._view && !this._view.follow) return false;
    const now = Date.now();
    const ttl = TTL[this._range] || 120000;
    return this._specs().some((spec) => {
      const rec = this._hist.get(spec.key + "|" + this._range);
      return !rec || now - rec.at > ttl;
    });
  }

  /**
   * The live tail.
   *
   * The recorder is polled at most once a TTL, so between polls the charts
   * held whatever they last fetched: on the long windows that is a quarter of
   * an hour of a frozen line and a frozen Now/Min/Max/Mean, sitting under room
   * cards that move every few minutes. It reads as a screenshot of a live card.
   *
   * `set hass` already carries the sample the recorder is about to store, so
   * take it from there. Every cached preset window gets the state it has not
   * seen appended, slides its right edge to now and drops what has scrolled
   * off the left. The poll REPLACES a window rather than adding to it, so a
   * sample counted twice here cannot survive one.
   *
   * A window that came back empty is left alone: "no history recorded" is a
   * true statement about the recorder, and one live point stretched across 24
   * hours would be a worse answer than the note.
   */
  _ingest() {
    const now = Date.now();
    const byKey = {};
    this._specs().forEach((spec) => { byKey[spec.key] = spec; });
    let moved = false;

    this._hist.forEach((rec, key) => {
      const bar = key.indexOf("|");
      // Pinned windows are keyed with an @, so the RANGES lookup drops them:
      // only the preset windows grow a tail.
      const rg = RANGES[key.slice(bar + 1)];
      const spec = byKey[key.slice(0, bar)];
      if (!rg || !spec || spec.attr || !rec.pts.length) return;

      const st = this._stateObj(spec.ent);
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
       * opens every reply with the state as it stood at start_time, so this is
       * the same left edge the next fetch will draw; dropping it would walk
       * the line's start rightwards between polls on a slow sensor.
       */
      let drop = 0;
      while (drop + 1 < rec.pts.length && rec.pts[drop + 1][0] < rec.start) drop++;
      if (drop) rec.pts.splice(0, drop);
      moved = true;
    });

    if (moved) this._drawCharts();
  }

  /** Local YYYY-MM-DD, which is what "today" has to be keyed by. */
  _dayStamp(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  _refreshCharts() {
    if (!this._hass) return;
    const v = this._view;
    let start, now, cap, ttl, keyOf;

    /*
     * Where the data comes from follows what is being looked at.
     *
     * A window that ends at now is served by a preset, and the preset picked
     * is the smallest one that covers the span -- which is what makes zooming
     * in SHARPEN the line rather than magnify it. Ten minutes taken out of the
     * 30 d window is one point per half hour and draws a staircase; the same
     * ten minutes off the 3 h window is every sample the recorder kept.
     *
     * A window panned into the past is fetched as itself. No preset can serve
     * it -- they all end at now -- and it needs no tail, because it is over,
     * so it is cached until trimmed rather than on a TTL.
     */
    if (!v || v.follow) {
      if (v) {
        this._range = this._presetFor(v.end - v.start);
        /*
         * A following window the size of its own preset IS that preset, so
         * let it go back to being one. Without this, a drag that hit the edge
         * of now and moved nothing would still leave every segment dark and
         * the window labelled by its span, saying something changed when
         * nothing did.
         */
        if (Math.abs((v.end - v.start) - RANGES[this._range].hours * 3600000) < 1500) {
          this._view = null;
        }
      }
      const rg = RANGES[this._range];
      now = Date.now();
      start = now - rg.hours * 3600000;
      cap = rg.points;
      ttl = TTL[this._range] || 120000;
      keyOf = (sp) => sp.key + "|" + this._range;
    } else {
      start = v.start;
      now = v.end;
      cap = 1500;
      ttl = Infinity;
      keyOf = (sp) => this._pinKey(sp.key, v.start, v.end);
    }

    const specs = this._specs().map((sp) =>
      Object.assign({ cacheKey: keyOf(sp), cap: cap, ttl: ttl }, sp));
    // A slower reply for a window the user has already left must not paint.
    const token = specs.map((sp) => sp.cacheKey).join(",");
    this._token = token;
    this._syncSegs();

    /*
     * Which store answers this window. Anything reaching further back than
     * the raw horizon is past `purge_keep_days` and the states table simply
     * has no rows there -- asking it for 30 d returns the last two and draws
     * a line across a twentieth of the chart. The hourly statistics do go
     * back, so they serve the long windows.
     */
    const stats = start < Date.now() - RAW_HORIZON;
    const jobs = [this._loadGroup(specs.filter((sp) => !sp.attr), start, now, stats)];
    // One call per row SHAPE, not per entity: the attribute series needs full
    // rows and the value series do not, so they cannot share a request. It is
    // also the one series statistics cannot serve -- a setpoint lives in an
    // attribute and nothing aggregates it -- so it stays on raw rows.
    const withAttr = specs.filter((sp) => sp.attr);
    if (withAttr.length) jobs.push(this._loadGroup(withAttr, start, now, false));

    if (this._config.tab === "rooms") {
      /*
       * "Today" is its own window on purpose: the min/max under each room is
       * supposed to mean today whatever the chart above it is showing. The
       * key carries the DATE, so the cache cannot serve yesterday's extremes
       * for the first TTL after midnight -- which is the one moment of the
       * day those two numbers are interesting.
       */
      const mid = new Date();
      mid.setHours(0, 0, 0, 0);
      const day = this._dayStamp(mid);
      const today = this._rooms().map((r) => ({
        ent: r.temp, cap: 900, ttl: TTL["24h"], cacheKey: "today|" + day + "|" + r.temp,
      }));
      jobs.push(this._loadGroup(today, mid.getTime(), Date.now()));
      // Yesterday's three entries are dead the moment the date rolls over.
      Array.from(this._hist.keys()).forEach((k) => {
        if (k.indexOf("today|") === 0 && k.indexOf("today|" + day + "|") !== 0) {
          this._hist.delete(k);
        }
      });
    }

    Promise.all(jobs).then(() => {
      if (!this._built || this._token !== token) return;
      this._drawCharts();
      // The room cards' min/max reads the "today" windows fetched above.
      if (this._config.tab === "rooms") this._patchRooms();
    });
  }

  /**
   * Pinned windows accumulate one entry per place a pan stopped, and nothing
   * expires them -- history does not go stale. Keep the most recently fetched
   * two dozen; the preset windows are never trimmed, they are the live ones
   * and there are only as many as there are buttons.
   */
  _trimPinned() {
    const pinned = [];
    this._hist.forEach((rec, key) => {
      if (key.indexOf("|@") > 0) pinned.push([key, rec.at]);
    });
    if (pinned.length <= 24) return;
    pinned.sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < pinned.length - 24; i++) this._hist.delete(pinned[i][0]);
  }

  /** The cache key each room card's min/max is stored under. */
  _todayKey(entity) {
    const mid = new Date();
    mid.setHours(0, 0, 0, 0);
    return "today|" + this._dayStamp(mid) + "|" + entity;
  }

  /**
   * One recorder request for a group of entities over one window.
   *
   * history_during_period takes a LIST and answers keyed by entity id, so the
   * rooms tab is two round trips rather than nine. Entities are cached
   * individually, though: a group whose members are all still fresh makes no
   * request at all, and a range switch re-fetches only the windows it lacks.
   */
  async _loadGroup(specs, start, end, stats) {
    if (!specs.length) return [];
    const now = Date.now();
    const want = specs.filter((s) => {
      const hit = this._hist.get(s.cacheKey);
      const ttl = s.ttl === undefined ? (TTL[this._range] || 120000) : s.ttl;
      return !(hit && now - hit.at < ttl) && !this._inflight.has(s.cacheKey);
    });
    if (!want.length) {
      return Promise.all(specs.map((s) =>
        this._inflight.get(s.cacheKey) || this._hist.get(s.cacheKey)));
    }

    const attr = want[0].attr;
    // An attribute series has no aggregate anywhere, so it never takes this
    // road however far back it is asked to go.
    const useStats = !!stats && !attr;
    const p = (async () => {
      let reply = null;
      let note = null;
      try {
        reply = await this._hass.callWS(useStats ? {
          type: "recorder/statistics_during_period",
          start_time: new Date(start).toISOString(),
          end_time: new Date(end).toISOString(),
          statistic_ids: want.map((s) => s.ent),
          // Hourly, because the five-minute aggregates are purged on the same
          // clock as the raw states and would run out at the same place.
          period: "hour",
          types: ["mean"],
        } : {
          type: "history/history_during_period",
          start_time: new Date(start).toISOString(),
          end_time: new Date(end).toISOString(),
          entity_ids: want.map((s) => s.ent),
          // An attribute series needs the attributes, and minimal_response
          // strips them from every row after the first -- so the target line
          // is the one fetch that pays for the full row shape.
          minimal_response: !attr,
          no_attributes: !attr,
          significant_changes_only: false,
        });
      } catch (err) {
        note = "history unavailable"
          + (err && (err.message || err.code) ? " — " + (err.message || err.code) : "");
      }
      const out = want.map((s) => {
        const rec = { at: now, start: start, end: end, pts: [], note: note };
        if (!note) {
          rec.pts = this._decimate(
            useStats ? this._parseStats(reply, s.ent) : this._parse(reply, s.ent, s.attr),
            s.cap);
          // Statistics exist only for an entity the recorder was told to
          // aggregate. One with no state_class has none, ever, and saying so
          // is more use than an empty panel that works at 24 h.
          if (!rec.pts.length) rec.note = useStats ? "no long-term statistics" : "no history recorded";
        }
        this._hist.set(s.cacheKey, rec);
        this._inflight.delete(s.cacheKey);
        return rec;
      });
      this._trimPinned();
      return out;
    })();
    want.forEach((s) => this._inflight.set(s.cacheKey, p));
    return p;
  }

  /**
   * Hourly means, in the same [ms, value] shape the raw parser produces.
   *
   * A row covers [start, end) and is plotted at its start, which is where
   * the History panel puts it -- a half-hour lead on a line that spans a
   * week is invisible, and agreeing with the panel next door is worth more
   * than the accuracy. `start` is epoch milliseconds on current releases and
   * an ISO string on older ones.
   */
  _parseStats(reply, entity) {
    if (!reply) return [];
    const rows = reply[entity];
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
   * compact form is {entity_id: [{s, lu, a}, ...]} with `lu` in epoch SECONDS,
   * the older one carries {state, last_updated, attributes} with ISO strings.
   *
   * `attr` pulls the number out of the attributes rather than the state, which
   * is how the target line is drawn at all -- a climate entity's STATE is its
   * mode, and the setpoint only ever lives in an attribute. A row carrying no
   * attributes inherits the last value seen, because that is exactly what the
   * recorder means by omitting them.
   */
  _parse(reply, entity, attr) {
    if (!reply) return [];
    // A batched reply omits an entity with no rows entirely, so the
    // single-key fallback below is only safe when there IS only one key --
    // otherwise a silent sensor would be drawn with its neighbour's history.
    const keys = Object.keys(reply);
    const rows = reply[entity] || (keys.length === 1 ? reply[keys[0]] : null) || [];
    const out = [];
    let carried = NaN;
    for (const r of rows) {
      if (!r) continue;
      const s = r.s !== undefined ? r.s : r.state;
      let v;
      if (attr) {
        const a = r.a || r.attributes;
        if (a && a[attr] !== undefined) carried = parseFloat(a[attr]);
        // An `off` climate entity keeps publishing its setpoint, but the unit
        // is not aiming at it. Drawing it there would invent a target.
        v = (s === "off" || s === "unavailable" || s === "unknown") ? NaN : carried;
      } else {
        v = parseFloat(s);
      }
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
   * Keep each bucket's LOW and HIGH rather than an even stride. A stride over
   * a 30 d window drops the one minute the kitchen hit 31 C, and a chart that
   * loses an extreme is worse than no chart, because the extreme is the thing
   * being looked for. powmr-inverter-console-card.js has the longer note.
   */
  _decimate(pts, cap) {
    if (pts.length <= cap) return pts;
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
      // Emitted in recorder order, or the path runs backwards across the
      // bucket. take() collapses the pair when a flat bucket makes them one.
      take(Math.min(lo, hi));
      take(Math.max(lo, hi));
    }
    if (out[0] !== pts[0]) out.unshift(pts[0]);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * One y domain per chart, shared by every series on it.
   *
   * Sharing an axis ACROSS the three rooms is the point; sharing it across
   * temperature and humidity is what the history-graph this replaces did, and
   * is why it was unreadable. Two charts, one axis each.
   *
   * The span is snapped to a step off the 1-2-2.5-5 ladder so the four gaps
   * divide into it evenly. Without that the labels come out at whatever
   * (hi-lo)/4 happens to be -- a room sitting between 23.2 and 25.4 gave
   * "23.0 / 23.8 / 24.5 / 25.3 / 26.0", five numbers none of which is a value
   * anyone would look for. The cost is a little empty space top and bottom,
   * which is cheaper than an unreadable axis.
   */
  _domain(series, pad, minSpan) {
    let lo = Infinity, hi = -Infinity;
    series.forEach((pts) => pts.forEach((p) => {
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
    }));
    if (!Number.isFinite(lo)) return null;
    lo -= pad;
    hi += pad;
    const gaps = GRID_LINES - 1;
    const need = Math.max(minSpan, hi - lo) / gaps;
    const LADDER = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    let step = LADDER.find((s) => s >= need - 1e-9);
    if (step === undefined) step = Math.ceil(need / 100) * 100;
    // Snapping lo down can push hi past the top of the frame; one wider step
    // always absorbs it, because the ladder never doubles twice in a row.
    let base = Math.floor(lo / step) * step;
    if (base + step * gaps < hi - 1e-9) {
      const i = LADDER.indexOf(step);
      step = i >= 0 && LADDER[i + 1] ? LADDER[i + 1] : step * 2;
      base = Math.floor(lo / step) * step;
    }
    return { lo: base, hi: base + step * gaps };
  }

  /**
   * x comes from the TIMESTAMP, not the sample index -- recorder rows are
   * irregular, so an index-based x gives a quiet hour the same width as a
   * busy one and misplaces every reading against the axis under it.
   */
  _pathOf(pts, dom, w, h, t0, t1) {
    if (!pts.length || !dom) return "";
    const span = (dom.hi - dom.lo) || 1;
    const tspan = (t1 - t0) || 1;
    return pts.map(([t, v], i) => {
      const x = Math.max(0, Math.min(w, (t - t0) / tspan * w));
      const y = h - CH_PAD
        - (Math.min(dom.hi, Math.max(dom.lo, v)) - dom.lo) / span * (h - CH_PAD * 2);
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
  }

  /** Clock stamps inside two days, dates beyond -- HH:MM repeats over a week. */
  _timeLabels(count, t0, t1) {
    const out = [];
    const p = (n) => String(n).padStart(2, "0");
    const span = t1 - t0;
    for (let i = 0; i < count; i++) {
      const d = new Date(t0 + span * i / (count - 1));
      out.push(span > 48 * 3600000
        ? p(d.getDate()) + "." + p(d.getMonth() + 1)
        : p(d.getHours()) + ":" + p(d.getMinutes()));
    }
    return out;
  }

  _drawCharts() {
    const tab = this._config.tab;
    if (tab === "rooms") CHARTS.forEach((c) => this._drawRoomChart(c));
    else this._drawTrack(tab === "hall" ? "hallch" : "bedch");
  }

  /** The cache record for one series, preferring the pinned window if any. */
  _recFor(key) {
    const v = this._view;
    return (v && !v.follow && this._hist.get(this._pinKey(key, v.start, v.end)))
      || this._hist.get(key + "|" + this._range);
  }

  /**
   * Axis labels and grid lines, shared by both chart shapes.
   *
   * The decimals are however many the STEP itself needs, not a count picked
   * per quantity. Getting this wrong is not cosmetic: a 2.5 step at zero
   * decimals printed "28 25 23 20 18" on the hall chart -- five labels whose
   * gaps alternate 3 and 2, for grid lines that are evenly spaced. The axis
   * was lying about where the lines were. Every label here is base + k*step
   * with base a multiple of step, so matching the step's precision is exactly
   * enough and never more.
   */
  _axes(id, dom, w, h) {
    const el = this._el;
    const step = dom ? (dom.hi - dom.lo) / (GRID_LINES - 1) : 1;
    let dec = 0;
    while (dec < 2 && Math.abs(step * Math.pow(10, dec) % 1) > 1e-9) dec++;
    for (let i = 0; i < GRID_LINES; i++) {
      const frac = i / (GRID_LINES - 1);
      const y = CH_PAD + (h - CH_PAD * 2) * frac;
      const line = el.q("#" + id + "-gl" + i);
      line.setAttribute("y1", y.toFixed(1));
      line.setAttribute("y2", y.toFixed(1));
      line.setAttribute("x2", String(w));
      const ax = el.q("#" + id + "-ax" + i);
      ax.style.top = (y / h * 100).toFixed(2) + "%";
      ax.textContent = dom ? (dom.hi - (dom.hi - dom.lo) * frac).toFixed(dec) : "";
    }
  }

  _ticks(id, t0, t1) {
    const labels = this._timeLabels(TICKS, t0, t1);
    for (let i = 0; i < TICKS; i++) this._el.q("#" + id + "-t" + i).textContent = labels[i];
  }

  _empty(id, note) {
    const node = this._el.q("#" + id + "-empty");
    node.style.display = note ? "" : "none";
    node.textContent = note || "";
  }

  /**
   * Three rooms over one axis, inside the current viewport.
   *
   * Everything below reads from the SLICE and not from the whole cached
   * window: a y axis scaled to a day of readings flattens the ten minutes
   * actually on screen, and Min/Max/Mean would report a window the reader is
   * not looking at. That is the whole reason the stats sit under the chart
   * rather than beside the room cards -- they describe what is drawn.
   */
  _drawRoomChart(chart) {
    const el = this._el;
    const id = chart.id;
    const rooms = this._rooms();
    const recs = rooms.map((r) => this._recFor(chart.prefix + r.key));
    const anchor = recs.find((rec) => rec) || null;
    if (!anchor) { this._empty(id, "loading…"); return; }

    const d = this._domainX(anchor);
    this._dom = d;
    const slices = recs.map((rec) => (rec ? this._slice(rec.pts, d.t0, d.t1) : []));
    const have = slices.filter((pts) => pts.length);
    const dom = this._domain(have, chart.pad, chart.minSpan);

    this._axes(id, dom, CH_W, CH_H);
    this._ticks(id, d.t0, d.t1);
    el.q("#" + id + "-win").textContent = this._winLabel(d);

    const xy = [];
    rooms.forEach((r, i) => {
      const pts = slices[i];
      el.q("#" + id + "-p-" + r.key)
        .setAttribute("d", this._pathOf(pts, dom, CH_W, CH_H, d.t0, d.t1));
      xy.push(this._project(pts, dom, CH_W, CH_H, d.t0, d.t1));

      const live = this._num(r[chart.field]);
      let lo = null, hi = null;
      for (const q of pts) {
        if (lo === null || q[1] < lo) lo = q[1];
        if (hi === null || q[1] > hi) hi = q[1];
      }
      const set = (k, val) => {
        el.q("#" + id + "-" + k + "-" + r.key).textContent = this._fmt(val, chart.dec);
      };
      // Now is the LIVE state, not the last plotted sample: a window panned
      // into last Tuesday still has a current temperature, and the reader
      // would rather not have to leave the chart to see it.
      set("now", live);
      set("min", lo);
      set("max", hi);
      set("mean", this._mean(pts));
    });

    this._hv[id] = { chart: chart, rooms: rooms, pts: slices, xy: xy, span: d.t1 - d.t0 };

    const notes = recs.filter((rec) => rec && rec.note);
    this._empty(id, have.length ? ""
      : (this._view ? "no readings in this window" : (notes.length ? notes[0].note : "loading…")));
    el.q("#" + id + "-note").textContent = have.length && have.length < rooms.length
      ? (rooms.length - have.length) + " of 3 without history"
      : "";

    /*
     * _hideHover is not called here, and the readout is put back instead.
     * Holding the redraw off until the pointer leaves is the freeze this
     * machinery exists to avoid: a cursor parked on the plot -- or one a touch
     * left there, since a tap sends no mouseleave -- would stop both charts
     * for as long as it sat. The readout follows the data instead of blocking
     * it.
     */
    if (this._hovering && !this._dragging && this._hoverX !== null) {
      this._paintHover(this._hovering, this._hoverX);
    }
  }

  /** The same mapping _pathOf draws with, kept as points for hit-testing. */
  _project(pts, dom, w, h, t0, t1) {
    if (!pts.length || !dom) return [];
    const span = (dom.hi - dom.lo) || 1;
    const tspan = (t1 - t0) || 1;
    return pts.map(([t, v]) => [
      Math.max(0, Math.min(w, (t - t0) / tspan * w)),
      h - CH_PAD - (Math.min(dom.hi, Math.max(dom.lo, v)) - dom.lo) / span * (h - CH_PAD * 2),
    ]);
  }

  // --- the hover readout ---------------------------------------------------

  _onHover(ev) {
    if (this._dragging) return;
    const node = ev.currentTarget;
    const id = node.getAttribute("data-chart");
    if (!id) return;
    this._hovering = id;
    this._hoverX = ev.clientX;
    this._paintHover(id, ev.clientX);
  }

  /**
   * Nearest sample to the cursor, per series, by x.
   *
   * The plot is drawn with preserveAspectRatio="none", so viewBox units and
   * CSS pixels differ on the x axis only -- pick the point in viewBox space,
   * then place the marks in pixel space.
   *
   * The cursor is drawn on BOTH charts, at the same instant, and only the
   * hovered one gets the bubble. Two stacked charts over one time axis are
   * being read together or there would be no reason to stack them, and
   * "what was the humidity when the kitchen hit 31" is the question they are
   * stacked to answer.
   */
  _paintHover(id, clientX) {
    const el = this._el;
    const src = this._hv[id];
    if (!src || !src.xy.some((pxy) => pxy.length)) return;
    const rect = el.q("#" + id + "-svg").getBoundingClientRect();
    if (!rect.width) return;
    // The cursor in viewBox units, which is the one thing both charts share:
    // they are drawn over the same domain into the same 0..CH_W box.
    const vx = Math.max(0, Math.min(CH_W, (clientX - rect.left) / rect.width * CH_W));
    const at = this._dom ? this._dom.t0 + vx / CH_W * (this._dom.t1 - this._dom.t0) : Date.now();

    CHARTS.forEach((chart) => {
      const hv = this._hv[chart.id];
      const box = hv && el.q("#" + chart.id + "-svg").getBoundingClientRect();
      if (!box || !box.width) return;
      const px = vx / CH_W * box.width;

      const line = el.q("#" + chart.id + "-hl");
      line.style.left = px + "px";
      line.classList.add("on");

      const rows = [];
      hv.rooms.forEach((r, i) => {
        const pxy = hv.xy[i];
        const dot = el.q("#" + chart.id + "-hd-" + r.key);
        if (!pxy.length) { dot.classList.remove("on"); return; }
        let best = 0, bd = Infinity;
        for (let k = 0; k < pxy.length; k++) {
          const dd = Math.abs(pxy[k][0] - vx);
          if (dd < bd) { bd = dd; best = k; }
        }
        // The dot sits on the SERIES at its nearest sample; the line sits
        // under the cursor. They part company where a sensor has a gap, which
        // is the honest picture -- a dot dragged onto the cursor's x would
        // claim a reading at a time the recorder has none.
        dot.style.left = (pxy[best][0] / CH_W * box.width) + "px";
        dot.style.top = (Math.max(0, Math.min(CH_H, pxy[best][1])) / CH_H * box.height) + "px";
        dot.classList.add("on");
        rows.push("<div class='tip-r'><span class='dot' style='background:" + r.color
          + "'></span>" + this._esc(r.name) + "<b>"
          + this._esc(hv.pts[i][best][1].toFixed(chart.dec) + " " + chart.unit)
          + "</b></div>");
      });

      const tip = el.q("#" + chart.id + "-tip");
      if (chart.id !== id || !rows.length) { tip.classList.remove("on"); return; }
      tip.innerHTML = "<i>" + this._esc(this._stamp(at, hv.span)) + "</i>" + rows.join("");
      tip.classList.add("on");
      // Keep the bubble inside the plot at both edges.
      const half = (tip.offsetWidth || 150) / 2;
      tip.style.left = Math.max(half + 4, Math.min(box.width - half - 4, px)) + "px";
    });
  }

  /** The pointer left the plot, so the readout stops being put back. */
  _leave() {
    this._hovering = null;
    this._hoverX = null;
    this._hideHover();
  }

  _hideHover() {
    if (!this._built || !this._config || this._config.tab !== "rooms") return;
    this._el.qa(".hv, .tip").forEach((n) => n.classList.remove("on"));
  }

  _drawTrack(id) {
    const el = this._el;
    const c = this._config;
    const ent = c.tab === "hall" ? c.hall_climate : c.bed_climate;
    const room = this._hist.get("room|" + this._range);
    const target = this._hist.get("target|" + this._range);
    const t1 = Date.now();
    const t0 = t1 - RANGES[this._range].hours * 3600000;

    /*
     * The design draws the target as a flat line at the current setpoint. A
     * real attribute history is better wherever the recorder kept one; where
     * it kept none -- a fresh database, or an entity that has been `off` all
     * window -- fall back to the flat line, because an empty track reads as
     * "no target" rather than as "target unchanged".
     */
    let tgt = target && target.pts.length ? target.pts : [];
    if (!tgt.length) {
      const now = Number(this._attr(ent, "temperature"));
      if (Number.isFinite(now) && this._state(ent) !== "off") tgt = [[t0, now], [t1, now]];
    }
    const series = [];
    if (room && room.pts.length) series.push(room.pts);
    if (tgt.length) series.push(tgt);
    const dom = this._domain(series, 0.8, 3);

    this._axes(id, dom, TR_W, TR_H);
    this._ticks(id, t0, t1);
    el.q("#" + id + "-room").setAttribute("d",
      room ? this._pathOf(room.pts, dom, TR_W, TR_H, t0, t1) : "");
    el.q("#" + id + "-target").setAttribute("d", this._pathOf(tgt, dom, TR_W, TR_H, t0, t1));
    this._empty(id, room && room.pts.length ? ""
      : room ? (room.note || "no history recorded") : "loading…");

    /*
     * A target line that stops a third of the way across is correct -- there
     * IS no target while the unit is off -- and looks exactly like a chart
     * that failed to finish drawing. Say which it is. The threshold is a
     * twentieth of the window, so a line that merely ends at the last
     * recorder row does not earn a caption.
     */
    const ends = tgt.length ? tgt[tgt.length - 1][0] : null;
    el.q("#" + id + "-note").textContent =
      ends && t1 - ends > (t1 - t0) / 20 && this._state(ent) === "off"
        ? "target ends where the unit went off" : "";
  }
}

if (!customElements.get(CARD)) customElements.define(CARD, ClimateConsoleCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((x) => x.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "Climate console",
    description: "Room sensors and both air conditioners, one tab each.",
    preview: false,
  });
}

installFonts();

console.info("%c " + CARD + " %c " + VERSION + " ",
  "background:#1a1e21;color:#38b6ff;font-weight:600",
  "background:#0f1214;color:#9aa0a6");
