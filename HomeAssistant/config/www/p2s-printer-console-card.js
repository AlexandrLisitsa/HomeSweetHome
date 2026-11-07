/**
 * P2S Printer Console card.
 *
 * The Bambu Lab P2S Combo (ha-bambulab, docs/bambu-printer.md) on one screen:
 * a virtual printer drawn from live data, the job's progress, the chamber
 * camera and the AMS. It follows the "P2S dashboard" design (a design-tool
 * mockup, 07.11.2026): its colours, type and sections, with IBM Plex standing
 * in for Inter and JetBrains Mono because cards load no fonts from the internet.
 *
 * THE CARD IS THE SIZE OF THE DASHBOARD
 * -------------------------------------
 * It is meant for a panel view. Its height is the viewport minus HA's top bar
 * (or --p2s-height, if a page sets it), and its ha-card is a size container,
 * so every size inside comes from the card's own width and height: type and
 * padding are clamp()s on cqmin, and the rows are fr tracks. Resize the
 * window and the card refits. Nothing in it scrolls, with no JS resize loop.
 * Wider than 1.15 x its height it is landscape: printer + AMS | progress +
 * camera. Otherwise it is one column: printer, progress, camera, AMS.
 *
 * THE CAMERA EXISTS ONLY WHILE THE PRINTER IS PRINTING
 * ----------------------------------------------------
 * In prepare, running and pause, the camera box shows the chamber camera.
 * With `camera_view: auto` (the default) that is a still from camera_proxy,
 * refreshed every 10 s while the page is visible. With `live` it is a stock
 * picture-entity card. In any other state the box shows the last plate image
 * and the timer or the camera card is gone. Removing them is what stops the
 * frames, so an idle printer costs the box nothing, even with the page open.
 *
 * PLAYGROUND
 * ----------
 * `debug_status: running` forces a status. `debug_status_entity` names an
 * input_select (live + the statuses) that the card follows, and shows as
 * the design's "Preview state" bar with a door preview button. A forced status
 * draws MOCK numbers over the live ones. It changes the drawing only and
 * calls no service except that input_select. Real dashboards set neither key.
 *
 * Bump VERSION on every edit and re-register:
 *
 *     python HomeAssistant/tools/ha_dashboard.py --card p2s-printer-console-card.js
 *
 * _build() runs once and _patch() only writes attributes and text, so the
 * fan, spool and toolhead animations never restart on a state change.
 */

const CARD = "p2s-printer-console-card";
const VERSION = "0.4.0";
import { cardTip } from "./card-tip.js?v=1.0.0";

const STATUSES = ["idle", "prepare", "running", "pause", "finish", "failed", "offline"];
const PRINTING = ["prepare", "running", "pause"];
const CAM_EVERY_MS = 10000;
const LOW_G = 100; // a slot under this many grams is drawn amber

/* The design's tones. */
const TONES = {
  run: { fg: "#5AA9FF", bg: "rgba(90,169,255,0.10)", bd: "rgba(90,169,255,0.42)" },
  warn: { fg: "#FFB547", bg: "rgba(255,181,71,0.10)", bd: "rgba(255,181,71,0.42)" },
  done: { fg: "#4FD1B0", bg: "rgba(79,209,176,0.10)", bd: "rgba(79,209,176,0.42)" },
  fail: { fg: "#FF7A6E", bg: "rgba(255,122,110,0.10)", bd: "rgba(255,122,110,0.42)" },
  idle: { fg: "#B4BBC6", bg: "rgba(180,187,198,0.08)", bd: "rgba(180,187,198,0.30)" },
  off: { fg: "#9AA1AD", bg: "rgba(154,161,173,0.06)", bd: "rgba(154,161,173,0.26)" },
};

/* Status → label, tone, the word the tooltip pill knows, and how the model moves. */
const STATUS = {
  idle: { label: "Idle", tone: "idle", word: "IDLE", head: "park", part: "none", disp: "READY" },
  prepare: { label: "Preparing", tone: "warn", word: "PREPARING", head: "center", part: "ghost", disp: "HEAT" },
  running: { label: "Printing", tone: "run", word: "PRINTING", head: "run", part: "printing", disp: null },
  pause: { label: "Paused", tone: "warn", word: "PAUSED", head: "park", part: "printing", disp: "PAUSE" },
  finish: { label: "Finished", tone: "done", word: "DONE", head: "park", part: "printing", disp: "DONE" },
  failed: { label: "Failed", tone: "fail", word: "FAILED", head: "center", part: "printing", disp: "ERROR" },
  offline: { label: "Offline", tone: "off", word: "OFFLINE", head: "park", part: "none", disp: "" },
};

const DEFAULTS = {
  status: "sensor.p2s_print_status",
  stage: "sensor.p2s_current_stage",
  progress: "sensor.p2s_print_progress",
  remaining: "sensor.p2s_remaining_time",
  end_time: "sensor.p2s_end_time",
  task: "sensor.p2s_task_name",
  layer: "sensor.p2s_current_layer",
  layers: "sensor.p2s_total_layer_count",
  weight: "sensor.p2s_print_weight",
  speed: "sensor.p2s_speed_profile",
  cover: "image.p2s_cover_image",
  camera: "camera.p2s_camera",
  light: "light.p2s_chamber_light",
  door: "binary_sensor.p2s_door",
  nozzle: "sensor.p2s_nozzle_temperature",
  nozzle_target: "sensor.p2s_nozzle_target_temperature",
  bed: "sensor.p2s_bed_temperature",
  bed_target: "sensor.p2s_bed_target_temperature",
  chamber: "sensor.p2s_chamber_temperature",
  trays: ["sensor.p2s_ams_1_tray_1", "sensor.p2s_ams_1_tray_2",
    "sensor.p2s_ams_1_tray_3", "sensor.p2s_ams_1_tray_4"],
  external: "sensor.p2s_external_spool",
  ams_humidity: "sensor.p2s_ams_1_humidity",
  ams_temperature: "sensor.p2s_ams_1_temperature",
  ams_drying: "binary_sensor.p2s_ams_1_drying",
  ams_drying_left: "sensor.p2s_ams_1_remaining_drying_time",
  hms: "binary_sensor.p2s_hms_errors",
  print_error: "binary_sensor.p2s_print_error",
  // Grams left per slot, A1-A4 then external (packages/bambu_printer.yaml).
  // An RFID Bambu spool's own `remain` % wins over these counts.
  remains: ["input_number.p2s_filament_a1", "input_number.p2s_filament_a2",
    "input_number.p2s_filament_a3", "input_number.p2s_filament_a4", "input_number.p2s_filament_ext"],
  spool_size: "input_number.p2s_spool_size",
  camera_view: "auto", // auto = a still every 10 s; live = the RTSP stream via picture-entity
  debug_status: null,
  debug_status_entity: null,
};

/*
 * Mock values per forced status, drawn over the live ones. The numbers match a
 * real job on this printer: Generic PLA in slot 1, a 2 h 10 min clip set.
 */
const MOCK = {
  idle: { task: null, progress: 0, layer: 0, layers: 0, remaining: 0, endIn: null,
    stage: "idle", nozzle: [24, 0], bed: [22, 0], chamber: 23, active: null, grams: null },
  prepare: { task: "Cable clips x8", progress: 0, layer: 0, layers: 142, remaining: 2.17,
    endIn: 2.4, stage: "heatbed_preheating", nozzle: [152, 220], bed: [48, 65], chamber: 26,
    active: 0, grams: 984 },
  running: { task: "Cable clips x8", progress: 46, layer: 66, layers: 142, remaining: 1.05,
    endIn: 1.05, stage: "printing", nozzle: [220, 220], bed: [65, 65], chamber: 34, active: 0, grams: 640 },
  pause: { task: "Cable clips x8", progress: 46, layer: 66, layers: 142, remaining: 1.05,
    endIn: null, stage: "paused_filament_runout", nozzle: [218, 220], bed: [65, 65],
    chamber: 33, active: 0, grams: 0,
    hms: [{ text: "AMS slot 1 ran out of filament. Load new filament to continue.",
      severity: "common" }] },
  finish: { task: "Cable clips x8", progress: 100, layer: 142, layers: 142, remaining: 0,
    endIn: -0.2, stage: "idle", nozzle: [71, 0], bed: [44, 0], chamber: 30, active: null, grams: 612 },
  failed: { task: "Cable clips x8", progress: 23, layer: 31, layers: 142, remaining: 0,
    endIn: null, stage: "paused_nozzle_clog", nozzle: [205, 0], bed: [61, 0], chamber: 31,
    active: null, grams: 950, error: { code: "0300-8006", text: "The nozzle is clogged. Clean it and retry." },
    hms: [{ text: "Nozzle clog detected. Check the hotend and the extruder.",
      severity: "serious" }] },
  offline: { task: null, progress: null, layer: null, layers: null, remaining: null,
    endIn: null, stage: "offline", nozzle: [null, null], bed: [null, null], chamber: null,
    active: null, grams: null },
};

/* Tooltip lines 2-4, house format (docs/dashboard-tooltips.md). */
const HELP = {
  status: "What the printer is doing, from its own MQTT report.\n"
    + "E.g. PRINTING while a job runs, PREPARING while it heats and levels the bed.",
  title: "The job the printer is running or ran last.\n"
    + "E.g. Cable clips x8, the name from Bambu Studio or Handy.",
  pct: "How much of the job is done.\n"
    + "E.g. 46 % at layer 66 of 142.\nTap for the plate image.",
  left: "Time the printer estimates is left in the job.\n"
    + "E.g. 1 h 03 min at 46 % of a 2 h 10 min job.\nThe printer's estimate, not ours.",
  done: "Wall-clock time the job should end.\n"
    + "E.g. 18:42, or 01:15 tomorrow for a job that runs past midnight.",
  layer: "The layer being printed, of all layers in the job.\n"
    + "E.g. 66 / 142 means about half of the height is printed.",
  weight: "Filament the whole job uses, as sliced.\n"
    + "E.g. 11.7 g for a set of small clips.",
  speed: "The speed profile the job runs at.\n"
    + "E.g. standard; sport and ludicrous are faster and louder.\nSet on the printer.",
  nozzle: "Hotend temperature against its target.\n"
    + "E.g. 220° / 220° while printing PLA; HEATING until it gets there.",
  bed: "Build plate temperature against its target.\n"
    + "E.g. 65° / 65° for PLA on the textured PEI plate.",
  chamber: "Air temperature inside the enclosure.\n"
    + "E.g. 34 °C during a long PLA print with the door shut.",
  ams_tag: "The filament feeding the job, or the first one loaded.\n"
    + "E.g. PLA from slot A1, FEEDING while it prints.",
  printer: "The printer drawn from live data: bed, toolhead, door, light, AMS.\n"
    + "E.g. The part rises and the bed steps down as layers are printed.",
  tray: "An AMS slot: its filament and the grams left on the spool.\n"
    + "E.g. PLA, 984 g left: counted by HA from each job, or read from an RFID spool.\n"
    + "Tap to correct the count, e.g. after putting back a used spool.",
  external: "The spool on the external holder at the back, and its grams left.\n"
    + "E.g. empty while every job feeds from the AMS.\nTap to correct the count.",
  humidity: "Relative humidity inside the AMS.\n"
    + "E.g. 48 %; dry it when PLA sits above 60 % for days.",
  ams_temp: "Air temperature inside the AMS.\n"
    + "E.g. 24 °C at rest, up to 65 °C while it dries filament.",
  drying: "Whether the AMS is drying filament, and how long is left.\n"
    + "E.g. 2 h 30 min left.\nStarted from the printer or Bambu Handy.",
  light: "The chamber light. The only thing HA can switch on this printer.\n"
    + "E.g. On so the camera sees the plate.\nTap to toggle.",
  door: "The enclosure door sensor.\n"
    + "E.g. Open while you take a print off the plate.",
  camera: "The chamber camera, on only while the printer is printing.\n"
    + "E.g. On at PREPARING, off at DONE, so an idle printer costs nothing.",
  health: "Errors from the printer's health system (HMS) and the job.\n"
    + "E.g. Nozzle clog detected, severity serious.\nThe same text the phone alert carries.",
  dbg: "Forces the card into this status with mock data. Playground only.\n"
    + "E.g. running draws a 46 % job with the camera on.\nTap to switch.",
  dbg_live: "Shows the real printer again. Playground only.\n"
    + "E.g. live with the printer idle draws No active print.\nTap to switch.",
  door_preview: "Draws the door open or shut without the sensor. Playground only.\n"
    + "E.g. open swings the glass door out on the virtual printer.\nTap to cycle.",
  mock: "This card is drawing mock data for a forced status.\n"
    + "E.g. The Playground is on running, so the numbers are invented.\nSet it to live.",
};

const FONTS = [
  ["IBM Plex Mono", 400, "ibm-plex-mono-400-latin.woff2"],
  ["IBM Plex Mono", 500, "ibm-plex-mono-500-latin.woff2"],
  ["IBM Plex Mono", 600, "ibm-plex-mono-600-latin.woff2"],
  ["IBM Plex Sans", "400 600", "ibm-plex-sans-latin.woff2"],
  ["Space Grotesk", "400 700", "space-grotesk-latin.woff2"],
].map((f) => "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1]
  + ";font-display:swap;src:url('/local/fonts/" + f[2] + "') format('woff2');"
  + "unicode-range:U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,"
  + " U+2000-206F, U+20AC, U+2122, U+2212, U+FEFF, U+FFFD}").join("\n");

/* Chrome ignores @font-face inside a shadow root (see the inverter card). */
const FONT_STYLE_ID = "p2s-printer-console-fonts";
function installFonts() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(FONT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = FONTS;
  document.head.appendChild(style);
}

/*
 * Sizes: the design's px at a full desktop (card ~1700 x 790, cqmin 7.9 px)
 * as the clamp maximum, scaled down by cqmin below that. Each pair below is
 * the design value and its cqmin slope (value / 7.9).
 */
const MONO = "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace";
const SANS = "'IBM Plex Sans', Inter, system-ui, sans-serif";
const GROT = "'Space Grotesk', 'IBM Plex Sans', Inter, sans-serif";

const STYLE = `
:host { display: block; height: var(--p2s-height, calc(100dvh - var(--header-height, 56px))); }
ha-card {
  height: 100%; box-sizing: border-box; overflow: hidden;
  container-type: size; container-name: p2s;
  background: #0C0E11; color: #ECEEF1; font-family: ${SANS};
  border: none; border-radius: 0; box-shadow: none;
  --tone: #5AA9FF; --tone-bg: rgba(90,169,255,0.10); --tone-bd: rgba(90,169,255,0.42);
}
.root { height: 100%; box-sizing: border-box; display: flex; flex-direction: column;
  gap: clamp(6px, 2.2cqmin, 18px); padding: clamp(8px, 2.6cqmin, 24px) clamp(10px, 2.8cqw, 40px); }
[hidden] { display: none !important; }
[data-more], [data-act] { cursor: pointer; }
button { font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid #5AA9FF; outline-offset: 2px; }
.mono { font-family: ${MONO}; }
.lab { font-family: ${MONO}; font-size: clamp(8.5px, 1.35cqmin, 10.5px); font-weight: 500; letter-spacing: .14em;
  text-transform: uppercase; color: #949CA8; }
h2 { margin: 0; font-family: ${MONO}; font-size: clamp(8.5px, 1.4cqmin, 11px); font-weight: 500;
  letter-spacing: .14em; text-transform: uppercase; color: #949CA8; }
.sec { background: #14171B; border: 1px solid #22262C; border-radius: clamp(10px, 2.3cqmin, 18px);
  padding: clamp(8px, 2.5cqmin, 20px) clamp(10px, 2.8cqmin, 24px); box-sizing: border-box; min-height: 0; min-width: 0;
  display: flex; flex-direction: column; gap: clamp(6px, 1.6cqmin, 14px); }
.sech { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 14px; }
.sech p { margin: 0; font-size: clamp(10.5px, 1.65cqmin, 13px); color: #949CA8; }

/* --- Preview state (Playground only) --- */
.pv { flex: none; display: flex; flex-wrap: nowrap; align-items: center; gap: 8px 12px; overflow-x: auto;
  padding: clamp(4px, 1cqmin, 8px) clamp(6px, 1.3cqmin, 10px) clamp(4px, 1cqmin, 8px) clamp(8px, 2cqmin, 16px);
  border: 1px dashed #2E333A; border-radius: clamp(10px, 1.8cqmin, 14px); background: #101215; scrollbar-width: none; }
.pv .segs { display: flex; gap: 4px; }
.pv .seg, .pv .door { min-height: clamp(26px, 4.6cqmin, 36px); padding: 0 clamp(7px, 1.5cqmin, 12px); border-radius: 8px;
  border: none; background: transparent; color: #B4BBC6; font-family: ${MONO}; font-size: clamp(10px, 1.5cqmin, 12px); white-space: nowrap; }
.pv .seg[aria-pressed="true"] { background: #ECEEF1; color: #0C0E11; }
.pv .door { border: 1px solid #2E333A; margin-left: auto; }
.pv .lab { white-space: nowrap; }

/* --- header --- */
.head { flex: none; display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between;
  gap: clamp(6px, 1.6cqmin, 16px) clamp(10px, 3cqmin, 24px); }
.head-l { display: flex; flex-direction: column; gap: clamp(2px, .9cqmin, 8px); min-width: 0; flex: 1 1 260px; }
.kick { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.kick .brand { font-family: ${MONO}; font-size: clamp(9px, 1.4cqmin, 11px); font-weight: 500; letter-spacing: .16em; text-transform: uppercase; color: #949CA8; }
.mockchip { font-family: ${MONO}; font-size: clamp(8.5px, 1.3cqmin, 10px); font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
  color: #FFB547; border: 1px solid rgba(255,181,71,0.45); border-radius: 6px; padding: 2px 7px; }
h1 { margin: 0; font-family: ${GROT}; font-size: clamp(18px, 4.6cqmin, 36px); line-height: 1.1; font-weight: 600;
  letter-spacing: -.015em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { margin: 0; font-size: clamp(11px, 1.9cqmin, 15px); color: #949CA8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head-r { display: flex; flex-wrap: wrap; align-items: center; gap: clamp(6px, 1.3cqmin, 10px); }
.chip { display: inline-flex; align-items: center; gap: 8px; min-height: clamp(28px, 5.6cqmin, 44px); box-sizing: border-box;
  padding: 0 clamp(10px, 2cqmin, 16px); border-radius: 999px; font-size: clamp(11.5px, 1.8cqmin, 14px); white-space: nowrap; }
.pill { border: 1px solid var(--tone-bd); background: var(--tone-bg); color: var(--tone); font-family: ${MONO};
  font-size: clamp(10px, 1.55cqmin, 12px); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); }
.pill.live .dot { animation: pulse 1.6s ease-in-out infinite; }
.doorchip { border: 1px solid #2A2F36; color: #B4BBC6; }
.doorchip.open { border-color: rgba(255,181,71,0.45); color: #FFB547; }
.lightbtn { border: 1px solid #2A2F36; background: transparent; color: #B4BBC6; font-weight: 500; }
.lightbtn.on { border-color: rgba(255,214,140,0.45); background: rgba(255,214,140,0.10); color: #FFD68C; }
.ico { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
  width: clamp(14px, 2.3cqmin, 18px); height: clamp(14px, 2.3cqmin, 18px); flex: none; }

/* --- issue line --- */
.issue { flex: none; display: flex; gap: 10px; align-items: baseline; padding: clamp(4px, 1cqmin, 8px) 14px; border-radius: 10px; min-width: 0;
  border: 1px solid rgba(255,122,110,0.42); background: rgba(255,122,110,0.10); color: #FFD9D4; font-size: clamp(11px, 1.7cqmin, 13.5px); }
.issue.warn { border-color: rgba(255,181,71,0.42); background: rgba(255,181,71,0.10); color: #FFE7C2; }
.issue .hh { flex: none; font-family: ${MONO}; font-size: clamp(9px, 1.3cqmin, 10.5px); letter-spacing: .14em; text-transform: uppercase; color: #FF7A6E; }
.issue.warn .hh { color: #FFB547; }
.issue .ht { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }

/* --- main grid: landscape --- */
.main { flex: 1 1 0; min-height: 0; display: grid; gap: clamp(6px, 2.2cqmin, 18px);
  grid-template-columns: minmax(0, 6fr) minmax(0, 5fr); grid-template-rows: minmax(0, 1fr); }
.colL, .colR { display: flex; flex-direction: column; gap: clamp(6px, 2.2cqmin, 18px); min-height: 0; min-width: 0; }

/* --- virtual printer --- */
.vp { flex: 1 1 0; container-type: inline-size; container-name: vm; }
.vpbox { flex: 1 1 0; min-height: 0; position: relative; }
.vpbox svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; overflow: visible; }
.vpbox.offline svg { filter: grayscale(1) brightness(0.6); }
.t-lab { font: 500 9.5px ${MONO}; letter-spacing: .12em; fill: #949CA8; }
.t-stat { font: 600 9px ${MONO}; letter-spacing: .1em; text-anchor: end; }
.t-val { font: 600 16px ${MONO}; fill: #ECEEF1; }
.d-txt { font: 600 10px ${MONO}; letter-spacing: .08em; }
.hud-strip { display: none; margin: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; flex: none; }
.hud-strip > div { background: #1A1E23; border-radius: 10px; padding: 5px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hud-strip dt { font-family: ${MONO}; font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: #949CA8; }
.hud-strip dd { margin: 0; font-family: ${MONO}; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@container vm (max-width: 600px) { .hud-strip { display: grid; } .hud-tags { display: none; } }
@keyframes th-scan { 0%, 100% { transform: translateX(-96px); } 50% { transform: translateX(96px); } }
.th-run { animation: th-scan 2.8s ease-in-out infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.fan-run { animation: spin .5s linear infinite; }
.spool-run { animation: spin 9s linear infinite; }
@keyframes feed { to { stroke-dashoffset: -14; } }
.feed-run { stroke-dasharray: 7 7; animation: feed .7s linear infinite; }
@keyframes pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
.layer-run { animation: pulse 1.4s ease-in-out infinite; }
.rec { animation: pulse 1.6s ease-in-out infinite; }

/* --- progress --- */
.prog { flex: none; }
.prow { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: clamp(6px, 1.6cqmin, 16px) clamp(12px, 3.5cqmin, 28px); }
.pct { margin: 0; display: flex; align-items: baseline; gap: 4px; font-family: ${GROT}; font-weight: 600; letter-spacing: -.03em; line-height: .9; }
.pct .n { font-size: clamp(30px, 10.6cqmin, 84px); }
.pct .u { font-size: clamp(14px, 3.8cqmin, 30px); color: #949CA8; }
dl { margin: 0; }
.pdl { display: flex; flex-wrap: wrap; gap: clamp(6px, 1.6cqmin, 16px) clamp(12px, 3.5cqmin, 28px); }
.kv { display: flex; flex-direction: column; gap: clamp(2px, .7cqmin, 6px); min-width: 0; }
.kv dt { font-family: ${MONO}; font-size: clamp(8.5px, 1.35cqmin, 10.5px); letter-spacing: .14em; text-transform: uppercase; color: #949CA8; }
.kv dd { margin: 0; font-family: ${MONO}; font-size: clamp(13px, 2.8cqmin, 22px); font-weight: 500; white-space: nowrap; }
.kv.sm dd { font-size: clamp(12px, 2.15cqmin, 17px); }
.pbar { display: flex; flex-direction: column; gap: clamp(4px, 1.2cqmin, 10px); }
.bar { position: relative; height: clamp(8px, 1.8cqmin, 14px); border-radius: 7px; background: #20242A; overflow: hidden; }
.bar .f { position: absolute; left: 0; top: 0; bottom: 0; width: var(--p, 0%); background: var(--tone); border-radius: 7px; transition: width .8s ease; }
.bar .s { position: absolute; inset: 0; background-image: repeating-linear-gradient(90deg, transparent 0 7px, rgba(20,23,27,0.6) 7px 9px); }
.pline { display: flex; justify-content: space-between; gap: 12px; font-family: ${MONO}; font-size: clamp(10.5px, 1.65cqmin, 13px); color: #949CA8; }
.pline b { font-weight: 400; color: #ECEEF1; }

/* --- camera --- */
.cam { flex: 1 1 0; }
.camh { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.badge { display: inline-flex; align-items: center; gap: 7px; font-family: ${MONO}; font-size: clamp(9px, 1.35cqmin, 10.5px);
  font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: #ECEEF1; }
.badge i { width: 7px; height: 7px; border-radius: 50%; background: #6B7380; }
.badge.live i { background: #FF5A4E; animation: pulse 1.6s ease-in-out infinite; }
.cambox { flex: 1 1 0; min-height: 0; position: relative; border-radius: clamp(8px, 1.5cqmin, 12px); overflow: hidden; background: #08090B; }
.cambox img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.cambox .plate { object-fit: contain; filter: brightness(.45) saturate(.7); }
.cambox .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 8px;
  font-family: ${MONO}; font-size: clamp(9.5px, 1.5cqmin, 12px); letter-spacing: .16em; text-transform: uppercase; color: #B4BBC6; }
.cambox .livecard { position: absolute; inset: 0; display: flex; align-items: center; }
.cambox .livecard > * { width: 100%; }

/* --- AMS --- */
.ams { flex: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips > div { display: flex; align-items: baseline; gap: 8px; padding: clamp(3px, .9cqmin, 7px) clamp(8px, 1.5cqmin, 12px); border: 1px solid #2A2F36; border-radius: 999px; }
.chips dt { font-family: ${MONO}; font-size: clamp(8.5px, 1.3cqmin, 10px); letter-spacing: .12em; text-transform: uppercase; color: #949CA8; }
.chips dd { margin: 0; font-family: ${MONO}; font-size: clamp(10.5px, 1.65cqmin, 13px); }
.slots { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: clamp(6px, 1.5cqmin, 12px); }
.slot { display: flex; align-items: center; gap: clamp(6px, 1.6cqmin, 14px); padding: clamp(6px, 1.6cqmin, 14px) clamp(6px, 1.8cqmin, 16px);
  border-radius: clamp(10px, 1.8cqmin, 14px); background: #181B20; border: 1px solid #22262C; min-width: 0; }
.slot.active { background: rgba(90,169,255,0.07); border-color: rgba(90,169,255,0.45); }
.disc { flex: none; box-sizing: border-box; width: clamp(22px, 5.6cqmin, 44px); height: clamp(22px, 5.6cqmin, 44px); border-radius: 50%;
  background: var(--fc); box-shadow: inset 0 0 0 clamp(2px, .5cqmin, 4px) #1B1E22, 0 0 0 1px #3A3F47; display: flex; align-items: center; justify-content: center; }
.disc i { width: 28%; height: 28%; border-radius: 50%; background: #0D0F12; box-shadow: 0 0 0 2px #5A616B; }
.slot.empty .disc { background: none; box-shadow: none; border: 1.5px dashed #3A3F47; }
.slot.empty .disc i { display: none; }
.slot .tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.slot .id { font-family: ${MONO}; font-size: clamp(8.5px, 1.3cqmin, 10px); letter-spacing: .12em; text-transform: uppercase; color: #949CA8; }
.slot .mat { font-family: ${GROT}; font-size: clamp(12px, 2.3cqmin, 18px); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slot.empty .mat { color: #949CA8; }
.slot .note { font-size: clamp(10px, 1.5cqmin, 12px); color: #949CA8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slot.active .note { color: #5AA9FF; }
.slot .g { display: none; font-family: ${MONO}; font-size: clamp(9.5px, 1.4cqh, 12px); color: #B4BBC6; white-space: nowrap; }
.slot .gb { display: block; height: 3px; border-radius: 2px; background: #22262C; overflow: hidden; margin-top: 3px; width: 100%; }
.slot .gb i { display: block; height: 100%; width: var(--p, 0%); background: #949CA8; border-radius: 2px; }
.slot.active .gb i { background: #5AA9FF; }
.slot.empty .gb { visibility: hidden; }
.slot.low .note, .slot.low .g { color: #FFB547; }
.slot.low .gb i { background: #FFB547; }
.slot.out .note, .slot.out .g { color: #FF7A6E; }
.slot.short { border-color: rgba(255,181,71,0.55); }

/*
 * --- portrait: one column ---
 * Height is what runs out here, so sizes follow cqh rather than cqmin (which
 * is the width in portrait). The printer gets 1.5 shares of the leftover
 * height and the camera 1; Progress and AMS shrink to one line each.
 */
@container p2s (max-aspect-ratio: 23/20) {
  .root { gap: clamp(5px, 1cqh, 12px); padding: clamp(6px, 1.2cqh, 16px) clamp(8px, 3cqw, 24px); }
  .main { gap: clamp(5px, 1cqh, 12px); grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1.5fr) auto minmax(0, 1fr) auto; }
  .colL, .colR { display: contents; }
  .vp { grid-row: 1; }
  .prog { grid-row: 2; }
  .cam { grid-row: 3; position: relative; }
  .ams { grid-row: 4; }
  .sec { padding: clamp(6px, 1.1cqh, 14px) clamp(8px, 2.5cqw, 18px); gap: clamp(4px, .8cqh, 10px); border-radius: 12px; }
  .vp .sech, .prog h2, .cam .camh h2, .ams h2 { display: none; }
  .cam .camh { position: absolute; z-index: 1; top: clamp(12px, 2cqh, 22px); right: clamp(14px, 3.5cqw, 26px);
    background: rgba(8,9,11,.6); padding: 2px 8px; border-radius: 6px; }
  .pv { gap: 6px; }
  .head { gap: 6px 10px; }
  h1 { font-size: clamp(16px, 2.6cqh, 30px); }
  .sub { font-size: clamp(11px, 1.6cqh, 14px); }
  .chip { min-height: clamp(26px, 3.6cqh, 40px); font-size: clamp(11px, 1.5cqh, 13px); padding: 0 10px; }
  .pill { font-size: clamp(9.5px, 1.3cqh, 11.5px); }
  .prow { flex-wrap: nowrap; align-items: center; }
  .pct .n { font-size: clamp(26px, 5.2cqh, 64px); }
  .pct .u { font-size: clamp(12px, 2cqh, 24px); }
  .pdl { flex: 1 1 auto; justify-content: flex-end; gap: 2px clamp(8px, 2.2cqw, 20px); }
  .kv { gap: 1px; }
  .kv dt { font-size: clamp(8px, 1.1cqh, 10px); letter-spacing: .1em; }
  .kv dd, .kv.sm dd { font-size: clamp(11px, 1.7cqh, 18px); }
  .pbar { gap: 3px; }
  .bar { height: clamp(6px, 1cqh, 12px); }
  .pline { font-size: clamp(10px, 1.4cqh, 12.5px); }
  .hud-strip > div { padding: 3px 7px; }
  .hud-strip dd { font-size: clamp(11px, 1.5cqh, 13px); }
  .ams .sech { flex-wrap: nowrap; justify-content: flex-start; }
  .chips { flex-wrap: nowrap; overflow: hidden; }
  .chips > div { padding: 2px 8px; }
  .slots { gap: clamp(4px, 1.5cqw, 10px); }
  .slot { gap: clamp(4px, 1.2cqw, 8px); padding: clamp(3px, .6cqh, 8px) clamp(4px, 1.2cqw, 10px); justify-content: center; }
  .disc { width: clamp(18px, 3.2cqh, 34px); height: clamp(18px, 3.2cqh, 34px); }
  .slot .id { display: none; }
  .slot .mat { font-size: clamp(11px, 1.6cqh, 15px); }
  .slot .note, .slot.empty .mat, .slot .gb { display: none; }
  .slot .g { display: block; }
}
/* --- landscape but short: drop the secondary lines first --- */
@container p2s (min-aspect-ratio: 23/20) and (max-height: 700px) {
  .slot .note, .prog h2 { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .th-run, .fan-run, .spool-run, .feed-run, .layer-run, .rec, .badge.live i, .pill.live .dot { animation: none !important; }
}
`;

/* The design's virtual printer; every {{binding}} became a data-r to patch. */
const PILLARS = [290, 309, 328, 347, 366, 385, 404, 423];
const BASES = [297, 335, 373, 411];
const GHOST = '<path d="M290 262 h26 v-64 h-7 v54 h-12 v-54 h-7 z"></path><path d="M328 262 h26 v-64 h-7 v54 h-12 v-54 h-7 z"></path>'
  + '<path d="M366 262 h26 v-64 h-7 v54 h-12 v-54 h-7 z"></path><path d="M404 262 h26 v-64 h-7 v54 h-12 v-54 h-7 z"></path>';
const PART = PILLARS.map((x) => '<rect class="pp" x="' + x + '" y="262" width="7" height="0"></rect>').join("")
  + BASES.map((x) => '<rect class="pb" x="' + x + '" y="262" width="12" height="0"></rect>').join("");
const FEED = "M 498 66 C 566 66, 572 150, 530 156";
const HEADFEED = "M 374 186 C 374 168, 384 160, 400 152";

function tag(key, x, y, label) {
  return '<g class="tag" data-r="tag-' + key + '" data-more="" transform="translate(' + x + " " + y + ')">'
    + '<rect width="150" height="46" rx="9" fill="#101215" stroke="#2A2F36" stroke-width="1"></rect>'
    + '<text x="12" y="18" class="t-lab" data-r="tl-' + key + '">' + label + "</text>"
    + '<text x="138" y="18" class="t-stat" data-r="ts-' + key + '"></text>'
    + '<text x="12" y="37" class="t-val" data-r="tv-' + key + '"></text></g>';
}

function amsSlotSvg(i) {
  const cx = 261 + 66 * i;
  return '<circle cx="' + cx + '" cy="37" r="2.5" fill="#33383F" data-r="aled' + i + '"></circle>'
    + '<circle cx="' + cx + '" cy="74" r="24" fill="#1B1E22" stroke="#3A3F47" stroke-width="1.5" data-r="afr' + i + '"></circle>'
    + '<circle cx="' + cx + '" cy="74" r="19" data-r="afil' + i + '"></circle>'
    + '<g transform="translate(' + cx + ' 74)"><g data-r="aspk' + i + '"><g stroke="#000000" stroke-opacity="0.22" stroke-width="2.5" stroke-linecap="round">'
    + '<line x1="0" y1="-8" x2="0" y2="-17"></line><line x1="6.93" y1="4" x2="14.72" y2="8.5"></line><line x1="-6.93" y1="4" x2="-14.72" y2="8.5"></line>'
    + "</g></g></g>"
    + '<circle cx="' + cx + '" cy="74" r="6.5" data-r="ahub' + i + '"></circle>';
}

const PRINTER_SVG = `
<svg viewBox="-40 0 800 660" preserveAspectRatio="xMidYMid meet" role="img" data-r="svg">
<ellipse cx="360" cy="620" rx="222" ry="10" fill="#000000" opacity="0.45"></ellipse>
<path d="${FEED}" fill="none" stroke="#3E444D" stroke-width="6" stroke-linecap="round"></path>
<path d="${FEED}" fill="none" stroke-width="1.8" stroke-linecap="round" class="feed" data-r="feed1"></path>
<rect x="196" y="606" width="40" height="10" rx="3" fill="#15171A"></rect>
<rect x="484" y="606" width="40" height="10" rx="3" fill="#15171A"></rect>
<rect x="180" y="120" width="360" height="490" rx="18" fill="#23262C" stroke="#363B43" stroke-width="1.5"></rect>
<polygon points="200,150 520,150 484,178 236,178" data-r="w-ceil"></polygon>
<polygon points="200,150 236,178 236,500 200,540" data-r="w-side1"></polygon>
<polygon points="520,150 484,178 484,500 520,540" data-r="w-side2"></polygon>
<rect x="236" y="178" width="248" height="322" data-r="w-back"></rect>
<polygon points="236,500 484,500 520,540 200,540" data-r="w-floor"></polygon>
<g stroke-width="2" stroke-linecap="round" data-r="w-detail">
<line x1="276" y1="318" x2="276" y2="378"></line><line x1="283" y1="318" x2="283" y2="378"></line>
<line x1="290" y1="318" x2="290" y2="378"></line><line x1="297" y1="318" x2="297" y2="378"></line>
<line x1="304" y1="318" x2="304" y2="378"></line><line x1="311" y1="318" x2="311" y2="378"></line>
<line x1="400" y1="300" x2="440" y2="300"></line>
</g>
<line x1="252" y1="182" x2="252" y2="498" stroke-width="3" data-r="w-rail1"></line>
<line x1="468" y1="182" x2="468" y2="498" stroke-width="3" data-r="w-rail2"></line>
<rect x="226" y="152" width="268" height="4" rx="2" data-r="w-strip"></rect>
<polygon points="232,156 488,156 520,540 200,540" fill="#FFF4E0" data-r="w-beam"></polygon>

<g data-r="bed" transform="translate(0 40)">
<rect x="246" y="250" width="14" height="16" rx="3" fill="#2C3036"></rect>
<rect x="460" y="250" width="14" height="16" rx="3" fill="#2C3036"></rect>
<polygon points="252,246 468,246 494,272 226,272" fill="#4A463E" stroke="#5C574E" stroke-width="1"></polygon>
<rect x="226" y="272" width="268" height="7" fill="#2C2A26"></rect>
<rect x="226" y="272" width="268" height="2" fill="#FF9F43" data-r="bedheat"></rect>
<g transform="translate(9 -9)">
<g fill="none" stroke="#9AA3B0" stroke-width="1" stroke-dasharray="3 3" data-r="ghost1">${GHOST}</g>
<g data-r="partshade">${PART}</g>
</g>
<g fill="none" stroke="#9AA3B0" stroke-width="1" stroke-dasharray="3 3" data-r="ghost2">${GHOST}</g>
<g data-r="part">${PART}</g>
<rect x="286" y="261" width="148" height="2" rx="1" fill="#FFB066" data-r="layerline"></rect>
<g class="hud-tags">
<line x1="494" y1="276" x2="568" y2="276" stroke="#3A414B" stroke-width="1"></line>
<circle cx="494" cy="276" r="3" fill="#949CA8"></circle>
${tag("bed", 568, 253, "BED")}
</g>
</g>

<rect x="210" y="199" width="300" height="9" rx="2" fill="#3A3F47"></rect>
<rect x="204" y="192" width="16" height="22" rx="3" fill="#2C3036"></rect>
<rect x="500" y="192" width="16" height="22" rx="3" fill="#2C3036"></rect>

<g data-r="head" transform="translate(-118 0)">
<g data-r="headrun">
<path d="${HEADFEED}" fill="none" stroke="#3E444D" stroke-width="5" stroke-linecap="round"></path>
<path d="${HEADFEED}" fill="none" stroke-width="1.6" stroke-linecap="round" class="feed" data-r="feed2"></path>
<circle cx="360" cy="257" r="11" fill="#FF9F43" data-r="glow"></circle>
<rect x="334" y="184" width="52" height="58" rx="7" fill="#2F333A" stroke="#474D56" stroke-width="1"></rect>
<rect x="338" y="188" width="44" height="6" rx="3" fill="#3A3F47"></rect>
<circle cx="360" cy="217" r="13" fill="#17191D" stroke="#4A505A" stroke-width="1.5"></circle>
<g transform="translate(360 217)"><g data-r="fan">
<path d="M 0 -9 Q 5 -5 0 0 M 7.8 4.5 Q 1.8 7.5 0 0 M -7.8 4.5 Q -6.8 -2.5 0 0" fill="none" stroke="#6B727D" stroke-width="2.4" stroke-linecap="round"></path>
</g></g>
<circle cx="360" cy="217" r="2.5" fill="#4A505A"></circle>
<circle cx="379" cy="233" r="2" data-r="headled"></circle>
<rect x="351" y="242" width="18" height="8" rx="1.5" fill="#3A3F47"></rect>
<polygon points="354,250 366,250 362,258 358,258" data-r="nozzle"></polygon>
</g>
</g>

<g fill="none" stroke-width="1.8" stroke-linecap="round" data-r="spag">
<path d="M 356 258 C 344 268, 334 252, 326 264 S 320 284, 336 278 S 354 270, 348 288"></path>
<path d="M 364 258 C 376 270, 392 256, 396 270 S 384 288, 372 280 S 362 292, 382 296"></path>
<path d="M 360 258 C 357 270, 370 276, 361 292 S 344 296, 352 304"></path>
</g>

<g data-r="doorshut">
<rect x="200" y="150" width="320" height="390" fill="#A8C8E8" fill-opacity="0.05" stroke="#C9DCEF" stroke-opacity="0.22" stroke-width="1.5"></rect>
<polygon points="236,150 268,150 200,276 200,216" fill="#FFFFFF" opacity="0.045"></polygon>
<polygon points="300,150 314,150 200,362 200,336" fill="#FFFFFF" opacity="0.035"></polygon>
<rect x="508" y="300" width="6" height="84" rx="3" fill="#4A505A"></rect>
</g>
<g data-r="dooropen">
<polygon points="200,150 128,126 128,564 200,540" fill="#A8C8E8" fill-opacity="0.07" stroke="#C9DCEF" stroke-opacity="0.32" stroke-width="1.5"></polygon>
<polygon points="190,147 176,142 128,250 128,282" fill="#FFFFFF" opacity="0.04"></polygon>
<rect x="134" y="300" width="5" height="92" rx="2.5" fill="#4A505A"></rect>
</g>

<rect x="318" y="556" width="84" height="36" rx="6" fill="#0B0D10" stroke="#2A2F36" stroke-width="1"></rect>
<text x="326" y="572" class="d-txt" data-r="disp"></text>
<rect x="326" y="580" width="68" height="4" rx="2" fill="#23272D"></rect>
<rect x="326" y="580" width="0" height="4" rx="2" data-r="dispbar"></rect>
<circle cx="508" cy="574" r="3" data-r="powerled"></circle>

<rect x="236" y="110" width="22" height="10" rx="2" fill="#1A1C20"></rect>
<rect x="462" y="110" width="22" height="10" rx="2" fill="#1A1C20"></rect>
<rect x="214" y="28" width="292" height="84" rx="14" fill="#262A30" stroke="#363B43" stroke-width="1.5"></rect>
<rect x="228" y="46" width="264" height="56" rx="8" fill="#0D0F12"></rect>
${[0, 1, 2, 3].map(amsSlotSvg).join("")}

<g class="hud-tags">
<line x1="122" y1="74" x2="237" y2="74" stroke="#3A414B" stroke-width="1"></line>
<circle cx="237" cy="74" r="3" fill="#949CA8"></circle>
${tag("ams", -28, 51, "AMS · A1")}
<g data-r="laytag">
<line x1="122" y1="262" x2="286" y2="262" stroke="#3A414B" stroke-width="1"></line>
<circle cx="286" cy="262" r="3" fill="#FFB066"></circle>
${tag("lay", -28, 239, "LAYER")}
</g>
<line x1="122" y1="353" x2="226" y2="353" stroke="#3A414B" stroke-width="1"></line>
<circle cx="226" cy="353" r="3" fill="#949CA8"></circle>
${tag("ch", -28, 330, "CHAMBER")}
<line x1="516" y1="205" x2="568" y2="205" stroke="#3A414B" stroke-width="1"></line>
<circle cx="516" cy="205" r="3" fill="#949CA8"></circle>
${tag("noz", 568, 182, "NOZZLE")}
</g>
</svg>`;

const DOOR_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16M14.5 12h.01"></path></svg>';
const BULB_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.1V16h5v-.1c0-.8.4-1.6 1.1-2.1A6 6 0 0 0 12 3z"></path></svg>';

const TEMPLATE = `
<ha-card><div class="root">
  <div class="pv" data-r="pv" hidden>
    <span class="lab">Preview state</span>
    <div class="segs" role="group" data-r="segs"></div>
    <button type="button" class="door" data-r="pvdoor" data-act="door"></button>
  </div>
  <header class="head">
    <div class="head-l">
      <div class="kick"><span class="brand">Bambu Lab P2S</span><span class="mockchip" data-r="mock" hidden>Mock data</span></div>
      <h1 data-r="title" data-more=""></h1>
      <p class="sub" data-r="sub"></p>
    </div>
    <div class="head-r">
      <span class="chip pill" role="status" data-r="pill" data-more=""><span class="dot"></span><span data-r="plabel"></span></span>
      <span class="chip doorchip" data-r="door" data-more="">${DOOR_ICON}<span data-r="doorv"></span></span>
      <button type="button" class="chip lightbtn" data-r="light" data-act="light" role="switch">${BULB_ICON}<span data-r="lightv"></span></button>
    </div>
  </header>
  <div class="issue" data-r="health" hidden><span class="hh" data-r="hhead"></span><span class="ht" data-r="hlist"></span></div>
  <div class="main">
    <div class="colL">
      <section class="sec vp">
        <div class="sech"><h2>Virtual printer</h2><p data-r="caption"></p></div>
        <div class="vpbox" data-r="vpbox" data-tip="">${PRINTER_SVG}</div>
        <dl class="hud-strip">
          <div data-r="hs-noz" data-more=""><dt>Nozzle</dt><dd data-r="hsv-noz"></dd></div>
          <div data-r="hs-bed" data-more=""><dt>Bed</dt><dd data-r="hsv-bed"></dd></div>
          <div data-r="hs-ch" data-more=""><dt>Chamber</dt><dd data-r="hsv-ch"></dd></div>
          <div data-r="hs-ams" data-more=""><dt data-r="hsl-ams">AMS A1</dt><dd data-r="hsv-ams"></dd></div>
        </dl>
      </section>
      <section class="sec ams">
        <div class="sech"><h2>AMS</h2>
          <dl class="chips">
            <div data-r="hum" data-more=""><dt>Humidity</dt><dd data-r="humv"></dd></div>
            <div data-r="amst" data-more=""><dt>Temp</dt><dd data-r="amstv"></dd></div>
            <div data-r="dry" data-more=""><dt>Drying</dt><dd data-r="dryv"></dd></div>
          </dl>
        </div>
        <ul class="slots">
          ${[0, 1, 2, 3, 4].map((i) => `<li class="slot" data-r="sl${i}" data-more=""><span class="disc"><i></i></span><div class="tx"><span class="id">${i < 4 ? "A" + (i + 1) : "External"}</span><span class="mat" data-r="mat${i}"></span><span class="g" data-r="g${i}"></span><span class="note" data-r="note${i}"></span><span class="gb"><i data-r="gb${i}"></i></span></div></li>`).join("")}
        </ul>
      </section>
    </div>
    <div class="colR">
      <section class="sec prog">
        <h2>Progress</h2>
        <div class="prow">
          <p class="pct" data-r="pct" data-more=""><span class="n" data-r="pctn"></span><span class="u" data-r="pctu"></span></p>
          <dl class="pdl">
            <div class="kv" data-r="left" data-more=""><dt>Time left</dt><dd data-r="leftv"></dd></div>
            <div class="kv" data-r="done" data-more=""><dt data-r="donel">Done at</dt><dd data-r="donev"></dd></div>
            <div class="kv sm" data-r="fil" data-more=""><dt>Filament used</dt><dd data-r="filv"></dd></div>
            <div class="kv sm" data-r="speed" data-more=""><dt>Speed</dt><dd data-r="speedv"></dd></div>
          </dl>
        </div>
        <div class="pbar" data-r="layer" data-more="">
          <div class="bar" role="progressbar" aria-label="Print progress" aria-valuemin="0" aria-valuemax="100" data-r="bar"><div class="f" data-r="barf"></div><div class="s"></div></div>
          <div class="pline"><span>Layer <b data-r="layerv"></b></span><span data-r="togo"></span></div>
        </div>
      </section>
      <section class="sec cam">
        <div class="camh"><h2>Chamber camera</h2><span class="badge" data-r="badge"><i></i><span data-r="badgev"></span></span></div>
        <div class="cambox" data-r="cambox" data-tip="">
          <img class="plate" data-r="plateimg" alt="" hidden>
          <img class="still" data-r="camimg" alt="Chamber camera" hidden>
          <div class="livecard" data-r="livecard" hidden></div>
          <div class="msg" data-r="cammsg"></div>
        </div>
      </section>
    </div>
  </div>
</div></ha-card>`;

// --- helpers -----------------------------------------------------------------

function num(v) {
  if (v === null || v === undefined || v === "" || v === "unknown" || v === "unavailable") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function tip(name, value, help) {
  return name + " — " + value + "\n" + help;
}

/** "1 h 03 min", "42 min", "—". `h` is hours. */
function fmtLeft(h) {
  if (h === null || h === undefined) return "—";
  const m = Math.max(0, Math.round(h * 60));
  if (m < 60) return m + " min";
  return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
}

function hm(d) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "18:42", "01:15 tomorrow", "—". */
function fmtEnd(d, now) {
  if (!d || isNaN(d.getTime())) return "—";
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  return hm(d) + (diff === 1 ? " tomorrow" : diff > 1 ? " +" + diff + "d" : "");
}

/** "#898989FF" → "#898989"; transparent or missing → null. */
function filamentColor(c) {
  if (typeof c !== "string" || !/^#[0-9a-f]{6}/i.test(c)) return null;
  if (c.length >= 9 && c.slice(7, 9) === "00") return null;
  return c.slice(0, 7);
}

function shade(hex, f) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.round(v * f).toString(16).padStart(2, "0")).join("");
}

function humanStage(s) {
  if (!s || ["unknown", "idle", "offline", "printing"].indexOf(s) >= 0) return "";
  const t = s.replace(/^paused_/, "").replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The design's temperature tag: value, status word, colour. */
function tempTag(cur, target) {
  if (cur === null || cur === undefined) return { val: "—", stat: "", col: "#949CA8", word: "" };
  const c = Math.round(cur);
  if (!target) return { val: c + "°C", stat: c > 45 ? "COOLING" : "OFF", col: "#949CA8" };
  const g = Math.round(target);
  if (Math.abs(c - g) <= 2) return { val: c + "° / " + g + "°", stat: "AT TEMP", col: "#5AA9FF" };
  return { val: c + "° / " + g + "°", stat: c < g ? "HEATING" : "COOLING", col: "#FFB547" };
}

function setAttrs(el, attrs) {
  if (!el) return;
  Object.keys(attrs).forEach((k) => {
    const v = String(attrs[k]);
    if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  });
}

function text(el, s) {
  if (el && el.textContent !== s) el.textContent = s;
}

// --- the card ----------------------------------------------------------------

class P2sPrinterConsoleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._r = null;
    this._camCard = null;
    this._camWanted = false;
    this._camTimer = null;
    this._doorPreview = null; // null = sensor, "on" = open, "off" = shut
    this._fp = null;
    cardTip(this, this.shadowRoot);
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && this._onClick(ev)) ev.preventDefault();
    });
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    if (cfg.debug_status && STATUSES.indexOf(cfg.debug_status) < 0) {
      throw new Error(CARD + ": debug_status must be one of " + STATUSES.join(", "));
    }
    if (["auto", "live"].indexOf(cfg.camera_view) < 0) {
      throw new Error(CARD + ": camera_view must be auto or live");
    }
    if (!Array.isArray(cfg.trays) || cfg.trays.length !== 4) {
      throw new Error(CARD + ": trays must list the four AMS slot sensors");
    }
    if (!Array.isArray(cfg.remains) || cfg.remains.length !== 5) {
      throw new Error(CARD + ": remains must list five counters, A1-A4 then external");
    }
    this._config = cfg;
    this._fp = null;
    this._unmountCamera();
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._camCard) this._camCard.hass = hass;
    if (this._config) this._render();
  }

  connectedCallback() {
    if (this._r && this._camWanted) this._mountCamera();
  }

  disconnectedCallback() {
    this._stopStill();
  }

  getCardSize() { return 12; }

  getGridOptions() { return { columns: "full", min_columns: 12 }; }

  static getStubConfig() { return {}; }

  // --- reading ---------------------------------------------------------------

  _st(id) { return (id && this._hass && this._hass.states[id]) || null; }

  _s(id) { const s = this._st(id); return s ? s.state : null; }

  /** The forced status, or null when live. */
  _forced() {
    const cfg = this._config;
    if (cfg.debug_status_entity) {
      const v = this._s(cfg.debug_status_entity);
      return v && STATUSES.indexOf(v) >= 0 ? v : null;
    }
    return cfg.debug_status || null;
  }

  /**
   * One slot. `grams` is what is left on its spool: the printer's own figure
   * for an RFID spool (remain % of tray_weight, or of a fresh spool), else
   * HA's counter; null when neither is known.
   */
  _tray(id, counter) {
    const st = this._st(id);
    const a = (st && st.attributes) || {};
    const color = filamentColor(a.color);
    const empty = !st || a.empty === true || st.state === "Empty" || (!color && !a.type);
    const spool = num(this._s(this._config.spool_size)) || 1000;
    const tw = num(a.tray_weight);
    const full = tw && tw > 0 ? tw : spool;
    const rm = num(a.remain);
    let grams = null;
    let src = null;
    if (!empty && rm !== null && rm >= 0) { grams = full * rm / 100; src = "rfid"; }
    else if (!empty) { grams = num(this._s(counter)); src = grams === null ? null : "count"; }
    return {
      id: id, counter: counter, empty: empty, color: color || "#3A3F4A",
      type: empty ? "" : (a.type && a.type !== "?" ? a.type : "?"),
      name: empty ? "Empty" : (a.name && a.name !== "?" ? a.name : st.state),
      active: !!a.active, grams: grams, src: src, full: full,
    };
  }

  /** The job's sliced grams per slot, [A1..A4, ext], from print_weight's attributes. */
  _jobGrams() {
    const st = this._st(this._config.weight);
    const out = [0, 0, 0, 0, 0];
    if (!st) return out;
    Object.keys(st.attributes || {}).forEach((k) => {
      const g = num(st.attributes[k]);
      if (!g || g <= 0) return;
      const mt = /^AMS 1 Tray ([1-4])$/.exec(k);
      if (mt) out[Number(mt[1]) - 1] += g;
      else if (/xternal/.test(k)) out[4] += g;
    });
    return out;
  }

  _hms() {
    const st = this._st(this._config.hms);
    if (!st || st.state !== "on") return [];
    const a = st.attributes || {};
    const n = num(a.Count) || 0;
    const out = [];
    for (let i = 1; i <= Math.max(n, 1); i++) {
      const t = a[i + "-Error"];
      if (t) out.push({ text: String(t), severity: String(a[i + "-Severity"] || "") });
    }
    return out;
  }

  /** Everything drawn, from live states, with MOCK over it for a forced status. */
  _model() {
    const c = this._config;
    const raw = this._s(c.status);
    const status = STATUSES.indexOf(raw) >= 0 ? raw : (raw === null || raw === "unavailable" ? "offline" : "idle");
    const end = this._s(c.end_time);
    const errSt = this._st(c.print_error);
    const m = {
      status: status, mock: false,
      stage: this._s(c.stage),
      task: (() => { const t = this._s(c.task); return t && t !== "unknown" && t !== "unavailable" ? t : null; })(),
      progress: num(this._s(c.progress)),
      layer: num(this._s(c.layer)), layers: num(this._s(c.layers)),
      remaining: num(this._s(c.remaining)),
      end: end && end !== "unknown" && end !== "unavailable" ? new Date(end) : null,
      weight: num(this._s(c.weight)),
      speed: this._s(c.speed),
      nozzle: [num(this._s(c.nozzle)), num(this._s(c.nozzle_target))],
      bed: [num(this._s(c.bed)), num(this._s(c.bed_target))],
      chamber: num(this._s(c.chamber)),
      trays: c.trays.map((id, i) => this._tray(id, c.remains[i])),
      ext: this._tray(c.external, c.remains[4]),
      jobGrams: this._jobGrams(),
      humidity: num(this._s(c.ams_humidity)),
      amsTemp: num(this._s(c.ams_temperature)),
      drying: this._s(c.ams_drying) === "on",
      dryLeft: num(this._s(c.ams_drying_left)),
      light: this._s(c.light),
      door: this._s(c.door),
      hms: this._hms(),
      error: errSt && errSt.state === "on"
        ? { code: String(errSt.attributes.code || ""), text: String(errSt.attributes.error || "Print error") }
        : null,
      cover: (() => { const s = this._st(c.cover); return s && s.attributes.entity_picture ? s.attributes.entity_picture : null; })(),
    };
    const forced = this._forced();
    if (forced) {
      const k = MOCK[forced];
      Object.assign(m, {
        status: forced, mock: true, stage: k.stage, task: k.task, progress: k.progress,
        layer: k.layer, layers: k.layers, remaining: k.remaining,
        end: k.endIn === null ? null : new Date(Date.now() + k.endIn * 3600000),
        nozzle: k.nozzle, bed: k.bed, chamber: k.chamber,
        hms: k.hms || [], error: k.error || null,
      });
      m.trays = m.trays.map((t, i) => Object.assign({}, t, { active: !t.empty && k.active === i }));
      if (k.active === 0 && m.trays[0].empty) {
        m.trays[0] = { id: c.trays[0], counter: c.remains[0], empty: false, color: "#898989", type: "PLA",
          name: "Generic PLA", active: true, grams: null, src: null, full: 1000 };
      }
      if (k.grams !== null && !m.trays[0].empty) {
        m.trays[0] = Object.assign({}, m.trays[0], { grams: k.grams, src: "count" });
      }
      m.jobGrams = k.task ? [m.weight || 11.7, 0, 0, 0, 0] : [0, 0, 0, 0, 0];
      m.ext = Object.assign({}, m.ext, { active: false });
    }
    if (this._doorPreview && c.debug_status_entity) m.door = this._doorPreview;
    return m;
  }

  /** The slot feeding the job, else the first loaded one: index 0-4, or -1. */
  _feedSlot(m) {
    const all = m.trays.concat([m.ext]);
    let i = all.findIndex((t) => t.active && !t.empty);
    if (i < 0) i = all.findIndex((t) => !t.empty);
    return i;
  }

  /**
   * While a job runs: does the slot feeding it hold less than the job still
   * needs (its sliced grams for that slot x the part not yet printed)?
   */
  _short(m) {
    if (PRINTING.indexOf(m.status) < 0) return null;
    const all = m.trays.concat([m.ext]);
    const done = m.progress === null ? 0 : Math.max(0, Math.min(100, m.progress)) / 100;
    for (let i = 0; i < 5; i++) {
      const t = all[i];
      const need = (m.jobGrams[i] || 0) * (1 - done);
      if (!t.empty && t.grams !== null && need > 0.5 && need > t.grams + 0.5) {
        const id = i < 4 ? "A" + (i + 1) : "External";
        return { slot: i, text: id + " has " + Math.round(Math.max(0, t.grams)) + " g left; this job needs about "
          + Math.round(need) + " g more" };
      }
    }
    return null;
  }

  _subtitle(m) {
    const L = m.layers || 0;
    const l = m.layer || 0;
    const now = new Date();
    switch (m.status) {
      case "idle": return "Ready for the next job";
      case "prepare": return humanStage(m.stage) || "Heating up and leveling the bed";
      case "running": return "Layer " + l + " of " + L + (m.end ? " · finishing at " + fmtEnd(m.end, now) : "");
      case "pause": return "Paused at layer " + l + " · " + (humanStage(m.stage) || "holding temperature");
      case "finish": return "Finished" + (m.end ? " at " + fmtEnd(m.end, now) : "") + " · ready to remove";
      case "failed": return "Stopped at layer " + l + " · " + (m.error ? m.error.text : "check the plate");
      default: return "No response from the printer";
    }
  }

  _caption(m) {
    switch (m.status) {
      case "idle": return "Ready for the next job";
      case "prepare": return (humanStage(m.stage) || "Heating up") + " · probing the bed";
      case "running": return "Toolhead laying layer " + (m.layer || 0) + " · bed stepping down";
      case "pause": return "Toolhead parked · holding temperature";
      case "finish": return "Print complete · cooling down";
      case "failed": return "Stopped mid-print · check the nozzle";
      default: return "No data · showing the printer at rest";
    }
  }

  // --- drawing ---------------------------------------------------------------

  _render() {
    if (!this._hass) return;
    const c = this._config;
    const ids = [c.status, c.stage, c.progress, c.remaining, c.end_time, c.task, c.layer, c.layers,
      c.weight, c.speed, c.cover, c.light, c.door, c.nozzle, c.nozzle_target, c.bed, c.bed_target,
      c.chamber, c.external, c.ams_humidity, c.ams_temperature, c.ams_drying, c.ams_drying_left,
      c.hms, c.print_error, c.debug_status_entity, c.spool_size].concat(c.trays, c.remains);
    const fp = JSON.stringify([this._doorPreview].concat(
      ids.map((id) => { const s = this._st(id); return s ? [s.state, s.attributes] : null; })));
    if (fp === this._fp) return;
    this._fp = fp;
    if (!this._r) this._build();
    this._patch(this._model());
  }

  _build() {
    installFonts();
    const root = this.shadowRoot;
    const style = document.createElement("style");
    style.textContent = STYLE;
    const holder = document.createElement("div");
    holder.innerHTML = TEMPLATE;
    root.appendChild(style);
    while (holder.firstElementChild) root.appendChild(holder.firstElementChild);
    const r = {};
    root.querySelectorAll("[data-r]").forEach((el) => { r[el.getAttribute("data-r")] = el; });
    this._r = r;
    try {
      console.info("%c " + CARD + " %c " + VERSION + " ", "background:#5AA9FF;color:#000", "");
    } catch (e) { /* no console */ }
  }

  _patch(m) {
    const r = this._r;
    const c = this._config;
    const meta = STATUS[m.status];
    const tone = TONES[meta.tone];
    const card = this.shadowRoot.querySelector("ha-card");
    card.style.setProperty("--tone", tone.fg);
    card.style.setProperty("--tone-bg", tone.bg);
    card.style.setProperty("--tone-bd", tone.bd);
    const printing = PRINTING.indexOf(m.status) >= 0;
    const offline = m.status === "offline";
    const now = new Date();

    // Preview state bar
    const dbgId = c.debug_status_entity;
    r.pv.hidden = !dbgId;
    if (dbgId) {
      const cur = this._s(dbgId) || "live";
      if (!r.segs.firstElementChild) {
        r.segs.innerHTML = ["live"].concat(STATUSES).map((o) =>
          '<button type="button" class="seg" data-act="dbg:' + o + '">' + o + "</button>").join("");
      }
      r.segs.querySelectorAll(".seg").forEach((b) => {
        const o = b.getAttribute("data-act").slice(4);
        setAttrs(b, { "aria-pressed": o === cur ? "true" : "false",
          "data-tip": tip("Preview", o === cur ? o.toUpperCase() + " · ON" : o.toUpperCase(),
            o === "live" ? HELP.dbg_live : HELP.dbg) });
      });
    }
    // Its tooltip is set even while the bar is hidden, so no button is ever bare.
    const dp = this._doorPreview === "on" ? "open" : this._doorPreview === "off" ? "closed" : "sensor";
    text(r.pvdoor, "Door: " + dp);
    setAttrs(r.pvdoor, { "data-tip": tip("Door preview", dp.toUpperCase(), HELP.door_preview) });

    // header
    r.mock.hidden = !m.mock;
    text(r.title, m.task || (offline ? "Printer offline" : "No active print"));
    setAttrs(r.title, { "data-more": c.task, "data-tip": tip("Job", m.task || "none", HELP.title) });
    text(r.sub, this._subtitle(m));
    text(r.plabel, meta.label);
    r.pill.classList.toggle("live", printing);
    setAttrs(r.pill, { "data-more": c.status, "data-tip": tip("Status", meta.word, HELP.status) });
    const doorOpen = m.door === "on";
    text(r.doorv, "Door " + (m.door === null ? "unknown" : doorOpen ? "open" : "closed"));
    r.door.classList.toggle("open", doorOpen);
    setAttrs(r.door, { "data-more": c.door,
      "data-tip": tip("Door", doorOpen ? "OPEN" : m.door === null ? "unknown" : "CLOSED", HELP.door) });
    const lightOn = m.light === "on" && !offline;
    r.light.classList.toggle("on", lightOn);
    text(r.lightv, "Light " + (offline || m.light === null ? "unknown" : lightOn ? "on" : "off"));
    setAttrs(r.light, { "aria-checked": lightOn ? "true" : "false",
      "data-tip": tip("Chamber light", lightOn ? "ON" : "OFF", HELP.light) });

    // issue line
    const issues = m.hms.slice();
    const short = this._short(m);
    if (short) issues.push({ text: short.text, severity: "common" });
    if (m.error) issues.unshift({ text: m.error.text + (m.error.code ? " (" + m.error.code + ")" : ""), severity: "error" });
    r.health.hidden = !issues.length;
    const serious = !!m.error || issues.some((i) => /fatal|serious|error/i.test(i.severity));
    r.health.classList.toggle("warn", !!issues.length && !serious);
    text(r.hhead, issues.length ? (serious ? "Fault" : "Attention") + " · " + issues.length : "");
    text(r.hlist, issues.map((i) => i.text).join("  ·  "));
    setAttrs(r.health, { "data-more": c.hms, "data-tip": tip("Health",
      issues.length ? issues.length + " issue(s) · " + (serious ? "FAULT" : "WARNING") : "NOMINAL", HELP.health) });

    // progress
    const p = m.progress === null ? null : Math.max(0, Math.min(100, m.progress));
    text(r.pctn, p === null ? "—" : String(Math.round(p)));
    text(r.pctu, p === null ? "" : "%");
    setAttrs(r.pct, { "data-more": c.progress, "data-tip": tip("Progress", p === null ? "—" : Math.round(p) + " %", HELP.pct) });
    const left = printing ? fmtLeft(m.remaining) : m.status === "finish" ? "Done" : "—";
    text(r.leftv, left);
    setAttrs(r.left, { "data-more": c.remaining, "data-tip": tip("Time left", left, HELP.left) });
    const doneTxt = m.status === "finish" || (printing && m.status !== "pause") ? fmtEnd(m.end, now) : "—";
    text(r.donel, m.status === "finish" ? "Finished at" : "Done at");
    text(r.donev, doneTxt);
    setAttrs(r.done, { "data-more": c.end_time, "data-tip": tip("Done at", doneTxt, HELP.done) });
    const fil = m.weight === null || !m.task ? "—" : m.weight.toFixed(1) + " g";
    text(r.filv, fil);
    setAttrs(r.fil, { "data-more": c.weight, "data-tip": tip("Filament used", fil, HELP.weight) });
    const spRaw = m.speed && m.speed !== "unknown" && m.speed !== "unavailable" ? m.speed : null;
    const sp = spRaw ? spRaw.charAt(0).toUpperCase() + spRaw.slice(1) : "—";
    text(r.speedv, offline ? "—" : sp);
    setAttrs(r.speed, { "data-more": c.speed, "data-tip": tip("Speed", sp, HELP.speed) });
    r.barf.style.setProperty("--p", (p || 0).toFixed(1) + "%");
    setAttrs(r.bar, { "aria-valuenow": Math.round(p || 0) });
    const L = m.layers || 0;
    const layerTxt = m.layers ? (m.layer || 0) + " / " + m.layers : "—";
    text(r.layerv, layerTxt);
    const rest = Math.max(0, L - (m.layer || 0));
    text(r.togo, !L ? "" : {
      prepare: L + " layers queued", running: rest + " layers to go", pause: rest + " layers to go",
      finish: "All layers done", failed: rest + " layers not printed" }[m.status] || "");
    setAttrs(r.layer, { "data-more": c.layer, "data-tip": tip("Layer", layerTxt, HELP.layer) });

    // AMS
    const feed = this._feedSlot(m);
    m.trays.concat([m.ext]).forEach((t, i) => {
      const el = r["sl" + i];
      el.classList.toggle("empty", t.empty);
      el.classList.toggle("active", t.active && !t.empty && m.status === "running");
      el.style.setProperty("--fc", t.color);
      text(r["mat" + i], t.empty ? "Empty" : t.type);
      const g = t.grams === null ? null : Math.max(0, t.grams);
      const gTxt = g === null ? "? g" : Math.round(g) + " g";
      const feeding = t.active && m.status === "running";
      const note = t.empty ? (i < 4 ? "Slot free" : "Spool holder free")
        : (feeding ? "Feeding · " : "") + (g === null ? "count unknown" : gTxt + " left");
      text(r["note" + i], note);
      text(r["g" + i], t.empty ? "" : gTxt);
      el.classList.toggle("low", !t.empty && g !== null && g > 0 && g < LOW_G);
      el.classList.toggle("out", !t.empty && g !== null && g <= 0);
      el.classList.toggle("short", !!short && short.slot === i);
      r["gb" + i].style.setProperty("--p", t.empty || g === null ? "0%"
        : Math.min(100, 100 * g / (t.full || 1000)).toFixed(1) + "%");
      const name = i < 4 ? "AMS slot A" + (i + 1) : "External spool";
      const val = t.empty ? "EMPTY" : t.type + " · " + (g === null ? "count unknown" : gTxt + " left")
        + (t.src === "rfid" ? " (RFID)" : "") + (t.active ? " · IN USE" : "");
      setAttrs(el, { "data-more": t.src === "rfid" ? t.id : t.counter,
        "data-tip": tip(name, val, i < 4 ? HELP.tray : HELP.external) });
    });
    const hum = offline || m.humidity === null ? "—" : Math.round(m.humidity) + " %";
    text(r.humv, hum);
    setAttrs(r.hum, { "data-more": c.ams_humidity, "data-tip": tip("AMS humidity", hum, HELP.humidity) });
    const at = offline || m.amsTemp === null ? "—" : m.amsTemp.toFixed(1) + " °C";
    text(r.amstv, at);
    setAttrs(r.amst, { "data-more": c.ams_temperature, "data-tip": tip("AMS temperature", at, HELP.ams_temp) });
    const dry = offline ? "—" : m.drying ? fmtLeft(m.dryLeft) + " left" : "Off";
    text(r.dryv, dry);
    setAttrs(r.dry, { "data-more": c.ams_drying, "data-tip": tip("AMS drying", m.drying ? "DRYING · " + dry : "OFF", HELP.drying) });

    // virtual printer
    this._patchPrinter(m, meta, tone, feed, lightOn, doorOpen);
    text(r.caption, this._caption(m));

    // camera
    r.badge.classList.toggle("live", printing);
    text(r.badgev, printing ? "Live" : offline ? "Offline" : "Off");
    if (m.cover && r.plateimg.getAttribute("src") !== m.cover) r.plateimg.setAttribute("src", m.cover);
    r.plateimg.hidden = printing || !m.cover || offline;
    r.cammsg.hidden = printing;
    text(r.cammsg, offline ? "No signal" : "Camera turns on while printing");
    setAttrs(r.cambox, { "data-tip": tip("Camera", printing ? "LIVE" : "OFF", HELP.camera) });
    if (printing) this._mountCamera();
    else this._unmountCamera();
  }

  _patchPrinter(m, meta, tone, feed, lightOn, doorOpen) {
    const r = this._r;
    const c = this._config;
    const all = m.trays.concat([m.ext]);
    const fs = feed >= 0 ? all[feed] : null;
    const filament = fs ? fs.color : "#E4E6EA";
    const run = m.status === "running";
    const offline = m.status === "offline";
    const p = m.progress === null ? 0 : Math.max(0, Math.min(1, m.progress / 100));
    const printing = meta.part === "printing";
    const h = printing ? 64 * p : 0;
    const base = Math.min(h, 10);
    const nozC = m.nozzle[0] || 0;
    const bedC = m.bed[0] || 0;

    r.vpbox.classList.toggle("offline", offline);
    setAttrs(r.vpbox, { "data-tip": tip("Virtual printer", meta.word, HELP.printer) });
    setAttrs(r.svg, { "aria-label": "Virtual printer, " + meta.label.toLowerCase() + ". " + this._caption(m) });

    // walls and light
    const w = lightOn
      ? { ceil: "#1F2226", side: "#30343A", back: "#3B3F45", floor: "#272A2F", detail: "#4D525A", strip: "#FFF1D6", beam: 0.07 }
      : { ceil: "#0E1013", side: "#131519", back: "#17191D", floor: "#101215", detail: "#24282E", strip: "#3A3F47", beam: 0 };
    setAttrs(r["w-ceil"], { fill: w.ceil });
    setAttrs(r["w-side1"], { fill: w.side });
    setAttrs(r["w-side2"], { fill: w.side });
    setAttrs(r["w-back"], { fill: w.back });
    setAttrs(r["w-floor"], { fill: w.floor });
    setAttrs(r["w-detail"], { stroke: w.detail });
    setAttrs(r["w-rail1"], { stroke: w.detail });
    setAttrs(r["w-rail2"], { stroke: w.detail });
    setAttrs(r["w-strip"], { fill: w.strip });
    setAttrs(r["w-beam"], { opacity: w.beam });

    // filament path
    const anim = (el, cls, on) => { if (el) el.classList.toggle(cls, !!on); };
    ["feed1", "feed2"].forEach((k) => {
      setAttrs(r[k], { stroke: filament, opacity: offline ? 0.35 : 1 });
      anim(r[k], "feed-run", run);
    });

    // bed, part, layer line
    const bedDy = printing ? h : meta.part === "ghost" ? 0 : 40;
    setAttrs(r.bed, { transform: "translate(0 " + bedDy.toFixed(2) + ")" });
    setAttrs(r.bedheat, { opacity: Math.max(0, Math.min(0.85, (bedC - 30) / 40)).toFixed(2) });
    const ghost = meta.part === "ghost" || (printing && p < 1) ? 0.55 : 0;
    setAttrs(r.ghost1, { opacity: ghost });
    setAttrs(r.ghost2, { opacity: ghost });
    setAttrs(r.part, { fill: filament });
    setAttrs(r.partshade, { fill: shade(filament, 0.7) });
    [r.part, r.partshade].forEach((g) => {
      g.querySelectorAll(".pp").forEach((el) => setAttrs(el, { y: (262 - h).toFixed(2), height: h.toFixed(2) }));
      g.querySelectorAll(".pb").forEach((el) => setAttrs(el, { y: (262 - base).toFixed(2), height: base.toFixed(2) }));
    });
    setAttrs(r.layerline, { y: (261 - h).toFixed(2), opacity: run ? 1 : m.status === "pause" ? 0.6 : 0 });
    anim(r.layerline, "layer-run", run);

    // toolhead
    setAttrs(r.head, { transform: "translate(" + (meta.head === "park" ? -118 : 0) + " 0)" });
    anim(r.headrun, "th-run", meta.head === "run");
    anim(r.fan, "fan-run", nozC >= 60);
    setAttrs(r.glow, { opacity: nozC >= 170 ? 0.5 : nozC >= 60 ? 0.18 : 0 });
    setAttrs(r.nozzle, { fill: nozC >= 170 ? "#FF9F43" : nozC >= 60 ? "#C98A5A" : "#8A9099" });
    setAttrs(r.headled, { fill: offline ? "#3A3F47" : tone.fg });
    setAttrs(r.spag, { stroke: filament, opacity: m.status === "failed" ? 1 : 0 });

    // door, display, power
    setAttrs(r.doorshut, { opacity: doorOpen ? 0 : 1 });
    setAttrs(r.dooropen, { opacity: doorOpen ? 1 : 0 });
    const disp = meta.disp === null ? Math.round(p * 100) + "%" : meta.disp;
    text(r.disp, disp);
    setAttrs(r.disp, { fill: offline ? "#2A2E34" : tone.fg });
    setAttrs(r.dispbar, { width: offline ? 0 : Math.round(68 * p), fill: offline ? "#2A2E34" : tone.fg });
    setAttrs(r.powerled, { fill: offline ? "#3A3F47" : "#4FD1B0" });

    // AMS on top: each slot in its own colour
    m.trays.forEach((t, i) => {
      const loaded = !t.empty;
      setAttrs(r["afr" + i], { opacity: loaded ? 1 : 0 });
      if (loaded) setAttrs(r["afil" + i], { fill: t.color, stroke: "none", "stroke-dasharray": "none" });
      else setAttrs(r["afil" + i], { fill: "none", stroke: "#3A3F47", "stroke-width": 1.5, "stroke-dasharray": "3 4" });
      setAttrs(r["aspk" + i], { opacity: loaded ? 1 : 0 });
      anim(r["aspk" + i], "spool-run", loaded && t.active && run);
      if (loaded) setAttrs(r["ahub" + i], { r: 6.5, fill: "#0D0F12", stroke: "#5A616B", "stroke-width": 1.5 });
      else setAttrs(r["ahub" + i], { r: 4, fill: "#1F2227", stroke: "none" });
      const lit = feed === i && (run || m.status === "prepare") ? "#5AA9FF" : feed === i && m.status === "pause" ? "#FFB547" : "#33383F";
      setAttrs(r["aled" + i], { fill: lit });
    });

    // HUD tags (and the narrow strip)
    const noz = tempTag(m.nozzle[0], m.nozzle[1]);
    const bed = tempTag(m.bed[0], m.bed[1]);
    const ch = { val: m.chamber === null ? "—" : Math.round(m.chamber) + "°C", stat: "", col: "#949CA8" };
    const layStat = { prepare: "NEXT", running: "PRINTING", pause: "PAUSED", finish: "DONE", failed: "STOPPED" }[m.status] || "";
    const lay = { val: m.layers ? (m.layer || 0) + " / " + m.layers : "—", stat: layStat,
      col: run ? "#FFB066" : m.status === "failed" ? "#FF7A6E" : "#949CA8" };
    const amsLbl = feed < 0 ? "AMS" : feed < 4 ? "AMS · A" + (feed + 1) : "EXTERNAL";
    const ams = { val: offline || !fs ? "—"
      : fs.type + (fs.grams === null ? "" : " · " + Math.round(Math.max(0, fs.grams)) + "g"), stat: offline || !fs ? "" : run ? "FEEDING" : "LOADED",
      col: run ? "#5AA9FF" : "#949CA8" };
    const tags = { noz: [noz, c.nozzle, "Nozzle", HELP.nozzle], bed: [bed, c.bed, "Bed", HELP.bed],
      ch: [ch, c.chamber, "Chamber", HELP.chamber], lay: [lay, c.layer, "Layer", HELP.layer],
      ams: [ams, feed >= 0 ? all[feed].id : c.trays[0], "AMS", HELP.ams_tag] };
    Object.keys(tags).forEach((k) => {
      const [v, ent, name, help] = tags[k];
      text(r["tv-" + k], v.val);
      text(r["ts-" + k], v.stat);
      setAttrs(r["ts-" + k], { fill: v.col });
      setAttrs(r["tag-" + k], { "data-more": ent, "data-tip": tip(name, v.val + (v.stat ? " · " + v.stat : ""), help) });
      if (r["hs-" + k]) {
        text(r["hsv-" + k], v.val.replace(" / ", "/"));
        setAttrs(r["hs-" + k], { "data-more": ent, "data-tip": tip(name, v.val + (v.stat ? " · " + v.stat : ""), help) });
      }
    });
    text(r["tl-ams"], amsLbl);
    text(r["hsl-ams"], amsLbl.replace(" · ", " "));
    setAttrs(r.laytag, { opacity: meta.part === "none" ? 0 : 1 });
  }

  // --- camera ----------------------------------------------------------------

  _mountCamera() {
    this._camWanted = true;
    const r = this._r;
    if (this._config.camera_view === "auto") {
      r.livecard.hidden = true;
      r.camimg.hidden = false;
      if (!this._camTimer) {
        this._refreshStill();
        this._camTimer = window.setInterval(() => this._refreshStill(), CAM_EVERY_MS);
      }
      return;
    }
    r.camimg.hidden = true;
    r.livecard.hidden = false;
    if (this._camCard) {
      if (this._camCard.parentNode !== r.livecard) r.livecard.appendChild(this._camCard);
      return;
    }
    if (this._camPending || typeof window.loadCardHelpers !== "function") return;
    const cfg = { type: "picture-entity", entity: this._config.camera, camera_view: "live",
      show_name: false, show_state: false };
    this._camPending = window.loadCardHelpers().then((h) => {
      this._camPending = null;
      const el = h.createCardElement(cfg);
      el.hass = this._hass;
      this._camCard = el;
      if (this._camWanted) r.livecard.appendChild(el);
    }).catch(() => { this._camPending = null; });
  }

  /** A fresh still, only when someone can see it. */
  _refreshStill() {
    if (typeof document !== "undefined" && document.hidden) return;
    const st = this._st(this._config.camera);
    const pic = st && st.attributes && st.attributes.entity_picture;
    if (!pic) return;
    this._r.camimg.setAttribute("src", pic + (pic.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now());
  }

  _stopStill() {
    if (this._camTimer) window.clearInterval(this._camTimer);
    this._camTimer = null;
  }

  /** Everything off: no timer, no camera card, no image source left fetching. */
  _unmountCamera() {
    this._camWanted = false;
    this._stopStill();
    if (this._r) {
      this._r.camimg.hidden = true;
      this._r.camimg.removeAttribute("src");
      this._r.livecard.hidden = true;
    }
    if (this._camCard && this._camCard.parentNode) this._camCard.parentNode.removeChild(this._camCard);
    this._camCard = null;
  }

  // --- taps ------------------------------------------------------------------

  _onClick(ev) {
    let el = ev.target;
    while (el && el !== this.shadowRoot && !(el.getAttribute && (el.getAttribute("data-act") || el.getAttribute("data-more")))) {
      el = el.parentNode;
    }
    if (!el || el === this.shadowRoot) return false;
    const act = el.getAttribute("data-act");
    if (act === "light") {
      this._hass.callService("light", "toggle", { entity_id: this._config.light });
      return true;
    }
    if (act === "door") {
      this._doorPreview = this._doorPreview === null ? "on" : this._doorPreview === "on" ? "off" : null;
      this._render();
      return true;
    }
    if (act && act.indexOf("dbg:") === 0 && this._config.debug_status_entity) {
      this._hass.callService("input_select", "select_option",
        { entity_id: this._config.debug_status_entity, option: act.slice(4) });
      return true;
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: el.getAttribute("data-more") }, bubbles: true, composed: true,
    }));
    return true;
  }
}

if (!customElements.get(CARD)) customElements.define(CARD, P2sPrinterConsoleCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: CARD, name: "P2S Printer Console",
  description: "Bambu Lab P2S: virtual printer, progress, camera while printing, AMS. Fills a panel view." });
