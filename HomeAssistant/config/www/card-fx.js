/**
 * card-fx.js -- the visual effects the console cards share.
 *
 *     import { fxConfig, fxOn, fxSetup, FX_CSS } from "./card-fx.js?v=1.1.0";
 *
 * Not a Lovelace resource: the cards import it, relative to /local/, like
 * card-tip.js. The `?v=` in each import is this file's VERSION; changing this
 * file means bumping VERSION and every card that imports it (MANIFEST.md §6).
 *
 * ON BY LIST
 *
 * A card's `fx` config key names the effects it draws:
 *
 *     (absent)                 no effects; no effect node or style is built
 *     fx: [power_glow, ...]    those effects (docs/dashboard-effects.md)
 *
 * The dashboards in HomeAssistant/dashboards/ list them per card. Nothing on
 * the box changes for an effect and nothing there spends a cycle on one: it
 * is CSS and a little DOM in the browser.
 *
 * Every effect pauses while its card is off screen or the tab is hidden, and
 * stands still under prefers-reduced-motion.
 */

export const VERSION = "1.1.0";

/** Every effect: its id, the cards that draw it, and what it shows. */
export const EFFECTS = [
  { id: "power_glow", label: "Glow follows power", cards: ["inverter", "battery"],
    tip: "A flow tile glows brighter, and its line runs thicker, the more watts pass through it." },
  { id: "liquid_soc", label: "Liquid SOC", cards: ["battery"],
    tip: "The state-of-charge bar fills like liquid, with a shimmer only while charging." },
  { id: "balance_pulse", label: "Balancing pulse", cards: ["battery"],
    tip: "Cells pulse while the balancer has work: switched on and a spread over 10 mV." },
  { id: "chart_polish", label: "Chart polish", cards: ["inverter", "battery"],
    tip: "A gradient fill under the history line and a pulsing dot on the latest value." },
  { id: "gradient_dial", label: "Gradient dial", cards: ["climate"],
    tip: "Cold-to-warm setpoint arc in the mode's colour; a ring turns while the compressor runs." },
  { id: "tinted_rooms", label: "Tinted rooms", cards: ["climate"],
    tip: "Each room tile is tinted by its temperature: blue under 20 °C, red over 26 °C." },
  { id: "live_thresholds", label: "Live thresholds", cards: ["shed"],
    tip: "A step marker glows as the battery comes within the warning margin of it." },
  { id: "danger_zone", label: "Danger zone", cards: ["shed"],
    tip: "A red band on the battery bar below the lowest step." },
];
const IDS = EFFECTS.map((e) => e.id);

/* --- per card ------------------------------------------------------------- */

/**
 * Validates a card's `fx` key; returns it normalised (null or a list). Throws
 * with the card's name so a typo shows in the editor.
 */
export function fxConfig(card, value) {
  if (value === undefined || value === null || value === false) return null;
  if (Array.isArray(value)) {
    const bad = value.filter((id) => IDS.indexOf(id) < 0);
    if (bad.length) throw new Error(card + ": unknown fx " + bad.join(", ") + " -- expected " + IDS.join(", "));
    return value.slice();
  }
  throw new Error(card + ": fx must be a list of " + IDS.join(", "));
}

/** Whether effect `id` is on for a card with this normalised fx config. */
export function fxOn(fx, id) {
  return !!fx && fx.indexOf(id) >= 0;
}

/** The ids on for this card, space-separated, for the host's data-fx. */
export function fxList(fx) {
  return IDS.filter((id) => fxOn(fx, id)).join(" ");
}

/**
 * Sets data-fx on the host, which every effect rule is gated on, and pauses
 * the card's animations while it is off screen or the tab is hidden. Returns
 * the teardown for disconnectedCallback.
 */
export function fxSetup(host, fx) {
  if (!fx) {
    host.removeAttribute("data-fx");
    return () => {};
  }
  host.setAttribute("data-fx", fxList(fx));
  let seen = true;
  const pause = () => {
    host.toggleAttribute("data-fx-paused", !seen || document.hidden);
  };
  let io = null;
  if (window.IntersectionObserver) {
    io = new window.IntersectionObserver((entries) => {
      seen = entries.some((e) => e.isIntersecting);
      pause();
    });
    io.observe(host);
  }
  document.addEventListener("visibilitychange", pause);
  return () => {
    if (io) io.disconnect();
    document.removeEventListener("visibilitychange", pause);
  };
}

/**
 * Shared styles. Cards append this to their own sheet. The rules only bite
 * under the host's data-fx, so a card without effects is unaffected.
 */
export const FX_CSS = `
:host([data-fx-paused]) * { animation-play-state: paused !important; }
@keyframes fxPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes fxShimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes fxWave { from { background-position-x: 0; } to { background-position-x: 24px; } }
@keyframes fxSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  :host([data-fx]) [class*="fx-"], :host([data-fx]) [class*="fx-"]::before,
  :host([data-fx]) [class*="fx-"]::after { animation: none !important; }
}
`;
