# Sweet Home 3D traps, each hit once

- **Colours start with `00`, not `FF`.** The app writes every colour as `00RRGGBB`.
  A light source written `FFRRGGBB` loads and saves without complaint and then
  renders *inverted*: warm white came out navy, pure red came out cyan.
- **The model's built-in ceiling light.** At the two best photo qualities the
  renderer puts a light in the middle of every room's ceiling, driven by the
  environment's `ceillingLightColor` (sic). It looks exactly like a lamp that
  ignores power 0. It is set to `00000000` in this model; there is no UI for it.
- **`Home` beats `Home.xml`.** A `.sh3d` is a zip holding a serialized `Home` and a
  `Home.xml`, and the app reads `Home` first. A script that edits `Home.xml` must
  drop `Home`, or the edit is silently ignored; the app writes both back on save.
  `ContentDigests` holds a SHA-1 per content entry (a folder's files hashed
  together in sorted order), and a new model entry needs one.
- **A light point inside a closed shape emits nothing.** The hallway bulb's first
  light source sat at the centre of its (closed) bulb, and the render showed no
  light at all. Put `lightSource z` on a face — `0.0` is the bottom.
- **Anything above the cut walls floats.** `make_render_copy.py` deals with each
  kind; the model keeps its real heights throughout.
  - Floor-standing pieces taller than 150 cm (a 238 cm wardrobe reads as a tower,
    and hides the room behind it) are cut to 125 cm.
  - The A/Cs, hung at 205 cm, and the inverter (110–155 cm) are hung on the cut wall
    instead, just below its top.
  - The hall mirror (60–180 cm) shrinks to 90 cm tall under the cut wall's top, and
    its shelf comes down to sit on it.
  - Ceiling lamps cannot move, or their light would come from somewhere else: their
    shapes shrink to a speck around the unchanged light point, and a lamp that is
    only furniture is hidden. Without its shape in the way a lamp lights ~20% more,
    which the ceiling lamps' `gain` in `rooms.py` takes back.
  - The kitchen's upper cabinets are above the cut too, and are left alone: they
    read as cabinets.
- **The time lives on the camera.** A daytime camera sun-lights the outside walls
  and drowns the lamps; `make_render_copy.py` sets 22:00.
