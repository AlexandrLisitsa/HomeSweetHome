/**
 * card-ramp.js -- the colour ramp the power cards share.
 *
 *     import { ramp, rampCss } from "./card-ramp.js?v=1.0.0";
 *
 * Not a Lovelace resource: the cards import it, relative to /local/, like
 * card-tip.js. The `?v=` in each import is this file's VERSION; changing this
 * file means bumping VERSION and every card that imports it (MANIFEST.md §6),
 * or the browser keeps the old module.
 *
 * WHAT IT IS FOR
 *
 * A reading is judged against thresholds -- SOC under 20 % is red, under 70 %
 * amber, green above -- and the colour used to snap at the threshold: 69 % and
 * 70 % were two different colours with nothing in between. A ramp keeps the
 * same bands but fades across each threshold, `fade` either side of it, so
 * the colour moves a little with every step of the reading:
 *
 *     SOC      0 ... 10 ...... 20 ...... 30 ... 60 ...... 70 ...... 80 ... 100
 *     colour   red         red/amber        amber      amber/green       green
 *                          (half-half)                 (half-half)
 *
 * Inside a band the colour is the band's own, exactly -- the same string the
 * card passed in -- and on the threshold itself it is half of each. The WORD a
 * card prints (HEALTHY, HIGH, ...) still changes on the threshold; only the
 * paint fades. `fade` must be at most half the gap between two thresholds, or
 * a band would have no solid middle.
 *
 * Edges are [threshold, colour below, colour above], in ascending order:
 *
 *     ramp(soc, [[20, BAD, WARN], [70, WARN, OK]], 10)
 *
 * rampCss() draws the same edges as a gauge track, so a track's fades sit
 * exactly where the paint's do. `pct` maps a reading onto the track's 0-100 %.
 */

export const VERSION = "1.0.0";

/** Two "#rrggbb" colours mixed in sRGB, `t` of the way from a to b. */
export function mix(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return "#" + [1, 3, 5].map((i) => Math.round(
    parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t)
    .toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** The colour of reading `v` on `edges`, faded `fade` either side of each. */
export function ramp(v, edges, fade) {
  let col = edges[0][1];
  for (const [at, below, above] of edges) {
    if (v < at - fade) return col;
    if (v < at + fade) return mix(below, above, (v - at + fade) / (2 * fade));
    col = above;
  }
  return col;
}

/** The same edges as a left-to-right CSS gradient, for a gauge track. */
export function rampCss(edges, fade, pct = (v) => v) {
  const at = (v) => Math.max(0, Math.min(100, pct(v))).toFixed(2) + "%";
  const stops = [edges[0][1] + " 0%"];
  edges.forEach(([e, below, above]) => {
    stops.push(below + " " + at(e - fade), above + " " + at(e + fade));
  });
  stops.push(edges[edges.length - 1][2] + " 100%");
  return "linear-gradient(90deg," + stops.join(",") + ")";
}
