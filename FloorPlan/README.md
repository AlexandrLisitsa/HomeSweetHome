# FloorPlan

The apartment as a Sweet Home 3D model, rendered from above, and turned into the
**Home** dashboard in Home Assistant: a picture of the flat where each lamp lights
its own room when it switches on, and a tap on its icon switches it.

| Thing | Where |
| --- | --- |
| Model | `model/MySweetHome.sh3d` — the master; open and edit this one. **Not in the public repo** (it is the home's layout); gitignored — bring your own |
| Renders | `renders/` — the raw photos, rebuilt from the model by `render.sh`; gitignored |
| Dashboard images | `HomeAssistant/config/www/floorplan/` (written by `build_overlays.py`) |
| Dashboard | `HomeAssistant/dashboards/lovelace.dashboard_home.json`, url `dashboard-home` |
| Card | `HomeAssistant/config/www/floorplan-card.js` — `custom:floorplan-card` |
| Generated | `build/` — render copy, crop, previews; gitignored, rebuilt by the tools |
| Sweet Home 3D | `SweetHome3D/` — the portable app the tools use; gitignored, [unpacked by hand](#sweet-home-3d) |

Needs Python with `numpy`, `Pillow` and `scipy`, and a JDK 11 for `render.sh`
(`/c/Program Files/Java/jdk-11`; `JDK=<dir>` overrides). No Blender, no HACS.

The model and its full-size renders are kept out of the public repo because they
show the apartment's layout. The tools work on any Sweet Home 3D model: put yours
at `model/MySweetHome.sh3d`, and the small images the dashboard actually serves
are committed under `HomeAssistant/config/www/floorplan/`.

### Sweet Home 3D

The tools use **Sweet Home 3D 7.5 portable** unpacked into `FloorPlan/SweetHome3D/`
(767 MB, gitignored): `render.sh` renders against its `lib/` jars, `catalog.py`
searches its catalogs, and it is the app to open the model with
(`SweetHome3D/SweetHome3D-windows-x64.exe`). Being portable, it keeps its
preferences and imported furniture libraries in its own `data/`, not in the user
profile, so the folder is the whole install. `SH3D=<dir>` points both tools at
another copy.

On a new machine: download the portable zip of 7.5 from
<https://www.sweethome3d.com/download.jsp>, unpack it as `FloorPlan/SweetHome3D/`
(so `FloorPlan/SweetHome3D/lib/SweetHome3D.jar` exists), then import the furniture
libraries the model uses — Blend Swap, Contributions, Kator Legaz, Luca Presidente,
Reallusion, Scopia and Trees, from <https://www.sweethome3d.com/importFurnitureLibrary.jsp>
— through *Furniture → Import furniture library*. The model opens without them,
since a `.sh3d` carries its own copy of every piece; they matter only for adding
furniture.

The card is our own, not the stock `picture-elements`, which was the first version
and could not do three things this needs: fit the whole picture on the screen, show
a dimmable lamp at its level rather than just on or off, and offer a brightness
control. It fades each overlay with the lamp's brightness, fills a ring round the
icon with the level, and shows the number with a slider beside a dimmable lamp
that is on. Devices sit where they stand: an A/C shows its mode and target and
tints with it, a plug the power it draws, the TV on/off, the router and the power
station their readings. While an A/C runs, its air streams out of the unit into
the room in the colour of its mode (`flow` in `rooms.py` names its piece in the
model; `make_dashboard.py` projects the streams and keeps what the walls do not
hide). Tap toggles what can be toggled and opens the dialog for
the rest; holding always opens the dialog. Every icon, number, badge, chip, switch
and slider explains itself on hover, in the house tooltip format
([`dashboard-tooltips.md`](../HomeAssistant/docs/dashboard-tooltips.md)).

On a phone (card under 600 px wide) the whole flat would be a thumbnail, so a row
of room chips picks what to show: a room zooms the picture to it and lists only its
controls as full-width rows; *All* shows the flat with every row, grouped by room.

## Tools

Run from the repository root. Each one reads the room list in `tools/rooms.py`.

| Script | Does |
| --- | --- |
| `tools/rooms.py` | the one list: the rooms the dashboard knows, where each lamp and control sits, its colour and brightness gain |
| `tools/catalog.py <what>` | searches every furniture catalog installed with Sweet Home 3D, to find a model before placing it |
| `tools/make_render_copy.py` | writes `build/MySweetHome-render.sh3d`: walls and tall furniture cut, doors and windows hidden, night |
| `tools/render.sh [room...]` | renders the dashboard photos into `renders/` with Sweet Home 3D's own renderer (`tools/Render.java`), no UI |
| `tools/check_camera.py` | checks the render copy's camera is the one `base.png` was actually taken with |
| `tools/build_overlays.py` | turns the renders into a base image plus one light-only overlay per lamp, masked to its room |
| `tools/make_dashboard.py` | writes the Home dashboard's card config from `rooms.py` |
| `tools/sh3d_camera.py` | library, not a command: projects plan coordinates (cm) into a render, used by the three above |
| `tools/card_harness.html` | a local page to try `floorplan-card.js` against fake states before deploying it |

## How it fits together

The dashboard is one lights-off picture with a light-only overlay per lamp. An
overlay is `(render with that lamp on) − (render with everything off)`, so it is
black except where that lamp adds light, and the card *adds* it onto the base with
`mix-blend-mode: plus-lighter`. Any combination of lamps then looks the way the
real ones do together, without a render per combination.

Each overlay is also clipped to its room. The render copy cuts the walls to 120 cm
so the rooms can be seen from above, which puts every lamp above the walls — in the
raw photo the kitchen strip lights the ground outside and the ceiling light reaches
the next room. `build_overlays.py` projects the room from the model through the
camera and keeps only its pixels: floor and inner wall faces up to 120 cm, minus
whichever of its walls stand between it and the camera, plus whatever stands in it
and rises above the wall line (cabinets, fridge, lamps).

**`tools/rooms.py` is the one list**: the rooms (each found in the model by a point
inside it), the lamps with an overlay and their brightness gain, the plan points
where icons go, and which HA entity is which item in which room.

## Changing something

1. **Edit the model** in Sweet Home 3D: `model/MySweetHome.sh3d`. To move the view,
   use *3D view → Aerial view*, then save. Furniture comes from the catalog, never
   a drawn box: `python FloorPlan/tools/catalog.py <what>` searches every installed
   library (default catalog, Blend Swap, Contributions, Kator Legaz, Luca
   Presidente, Reallusion, Scopia) and prints the `catalogId` to use.
2. **Make the render copy:** `python FloorPlan/tools/make_render_copy.py` →
   `build/MySweetHome-render.sh3d`: walls cut to 120 cm, doors and windows hidden,
   22:00, 2400 × 1800, and the pieces that would float over the cut walls dealt
   with (see the traps below). The model itself is only read.
3. **Render:** `sh FloorPlan/tools/render.sh` — Sweet Home 3D's own photo renderer
   at its best quality (`tools/Render.java`, against the jars in `SweetHome3D/lib`;
   see [Sweet Home 3D](#sweet-home-3d)), with the camera, time and size saved in the render
   copy, into `renders/`. About 25 minutes for all of them at 2400 × 1800. It takes one photo with
   every lamp off (`base.png`), then one per `LIGHTS` key with only that lamp on at
   power 0.5; the lamps each photo switches on are listed in `render.sh`.
4. `python FloorPlan/tools/check_camera.py` — must say `OK`. If it doesn't, the
   photos were taken from a different camera than the file holds.
5. `python FloorPlan/tools/build_overlays.py` — denoises every photo (a guided
   filter: render grain smoothed on flat surfaces, edges kept), then writes the
   dashboard images and a mask per room. Brightness per lamp is its `gain` in `rooms.py`; changing it
   needs no re-render.
6. `python FloorPlan/tools/make_dashboard.py` — writes the card config into
   `HomeAssistant/dashboards/lovelace.dashboard_home.json`: every item at its spot,
   every room's zoom box, and image URLs with a hash of the file as `?v=`, so a
   changed picture can never be served stale. Check `build/icon_check.png`. A point
   on a floor the walls hide lands on the wall in front of it: badges float
   mid-room at 130 cm for that reason.
7. Push:

   ```sh
   sh HomeAssistant/tools/ha_www_push.sh
   python HomeAssistant/tools/ha_dashboard.py --push HomeAssistant/dashboards/lovelace.dashboard_home.json \
       --url-path dashboard-home
   ```

   After editing the card itself, try it in `tools/card_harness.html` first (the
   real config with a fake `hass`, any card width, and a `selftest=1` that taps,
   holds, drags and switches rooms and prints what came out; how to serve it is at
   the top of the file), then bump its `VERSION` and re-register it:
   `python HomeAssistant/tools/ha_dashboard.py --card floorplan-card.js`.

Adding a lamp is: the lamp in the model, a shot in `render.sh`, a `LIGHTS` entry,
a spot and an item in `rooms.py`, then the loop from step 2. A device without a
light is only the spot and the item.

## Docs

| Doc | About |
| --- | --- |
| [`docs/sweet-home-3d-traps.md`](docs/sweet-home-3d-traps.md) | Sweet Home 3D behaviour that silently breaks a render or the model, each found once the hard way |
