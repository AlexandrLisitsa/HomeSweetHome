# Ribbon box

An AMS-style case for five satin ribbon rolls in a row. It has one PLA base split into five bays and one clear PETG lid hinged at the back. Each bay has its own pull slot in the front wall, and each roll spins on its own drop-in axle.

Model: [`RibbonBox/ribbon_box.scad`](../RibbonBox/ribbon_box.scad) (OpenSCAD + BOSL2). Every size comes from the parameters at the top of the file.

## Roll it is sized for

These sizes were measured from photos. **Check them with a caliper** and change `roll_*` / `core_*` if they differ.

| | mm |
|---|---|
| Roll outside diameter | 76 |
| Ribbon width | 50 |
| Core outside / inside | 24 / 18 |

## The case

| | |
|---|---|
| Outside | 278 × 89 × 87 mm (plus the hinge and the snap tabs) |
| Bays | 5 × 52 mm, 3 mm dividers that run up to the lid |
| Pull slot | 51.5 mm wide per bay, low in the front wall. It climbs through the wall at 45°, so it prints with no 52 mm bridge (Studio flags such a bridge as a "floating cantilever"). The two sharp edges are chamfered so satin doesn't snag. |
| Lid | clear PETG, hinged at the back on a 1.75 mm filament pin, two snap clips at the front |
| Axle | Ø17 mm (fits the 18 mm core), coned ends, Ø8 mm journals |

- **Cradles:** each axle drops into U-cradles that are open at the top. The cradles sit in the divider walls, and in shallow pockets in the two end walls.
- **No axle clips needed:** the lid ceiling is 3 mm above a full roll and the cradles are 6 mm deep above each axle end, so an axle can't climb out with the lid shut.
- **Lid dividers:** the lid has its own divider walls, so every bay is closed off right up to the ceiling.

## Changing one roll (e.g. the middle one)

1. Press the two front clips out and swing the lid back. It opens past 90°.
2. Lift that bay's axle straight up out of its cradles, together with the roll.
3. Push the axle into the new roll's core and drop it back in.
4. Thread the ribbon end out through the bay's front slot. It should leave the **bottom** of the roll toward the front.
5. Close the lid. The other four rolls are never touched.

## Printing (Bambu P2S, 0.4 nozzle)

Each part is 278 mm long, which is more than the 256 mm bed, so both print flat **turned 45°**. That uses 251 × 251 mm of the plate. They are turned −45° on purpose, so the corners stay clear of the P2S wrapping-detection zone at the back edge (x 153–216, y 235–256).

Render the two plates with [`tools/scad_render.ps1`](../tools/scad_render.ps1). Each lands in `RibbonBox/out/`, already placed in bed coordinates:

| Part | File | Material | Notes |
|---|---|---|---|
| `plate_pla` | `ribbon_box-plate_pla.stl` | PLA | Base plus 5 standing axles in the free corner. 3 walls, 15 % infill. |
| `lid45` | `ribbon_box-lid45.stl` | clear PETG | Printed top face down. 4 walls, 100 % infill (aligned rectilinear or zig-zag) and a slow outer wall, which is what makes it see-through. |

- **Opening the files:** open each `.stl` in Bambu Studio directly. Don't let it re-arrange the parts.
- **Before slicing:** pick your printer, plate and filament.
- **Supports:** none needed. The hinge knuckles have 45° gussets and print as they are.
- **Axles:** if they wobble, add a brim to the axles only (per-object brim in Studio).
- **Hinge pin:** after printing, push a 200 mm piece of 1.75 mm filament (the hinge runs 192 mm) through the hinge from one end, then melt or bend both ends over.
- **Saving the job:** once both plates slice cleanly, save them as one Studio project with plate 1 in PLA and plate 2 in PETG. Commit it as `RibbonBox/RibbonCase.3mf` so a reprint is just open and print.

> Don't slice with the Bambu Studio **CLI**. Its headless mode doesn't apply the system P2S profiles. It falls back to defaults: line width 0, 500 mm/s² accelerations, 60 mm/s walls. Its time estimates and warnings are wrong.

## Tuning after the first print

| Symptom | Parameter |
|---|---|
| Lid snaps too hard or too soft | `snap_bump` (0.8) |
| Lid rim too tight or loose on the base lip | `fit` (0.25) |
| Ribbon drags or curls in the slot | `slot_gap` (3.0 vertical, ~2.1 across the channel) |
| Roll rubs a divider | `side_gap` (1) |
| Axle too loose in the core | `axle_d` (core − 1) |

## Render parts

| Part names | What they are |
|---|---|
| `base`, `lid`, `axle` | single parts |
| `plate_pla`, `lid45` | print-ready plates |
| `assembly`, `open`, `exploded`, `section`, `hinge_section` | views |
