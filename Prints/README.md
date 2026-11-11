# Prints

Things we design and 3D-print for the house that belong to no other project. A printed part that serves a project lives in that project instead, such as an enclosure.

Every print is a parametric model in **OpenSCAD + BOSL2**: code you can diff, where each size is a named parameter. The printer is a Bambu Lab P2S (256 × 256 × 256 mm bed).

## Prints

| Print | What it is | Model | Doc |
|---|---|---|---|
| Ribbon box | AMS-style case for five satin ribbon rolls: PLA base with five bays and pull slots, clear PETG hinged lid | [`RibbonBox/ribbon_box.scad`](RibbonBox/ribbon_box.scad) | [docs/ribbon-box.md](docs/ribbon-box.md) |

## Layout

```text
Prints/
├── README.md            this file
├── tools/               scripts for every print
├── docs/<print>.md      one doc per print: what it is, sizes, how to print and assemble
└── <Print>/             one folder per print
    ├── <print>.scad     the model
    ├── <Name>.3mf       optional: the saved Bambu Studio project, ready to reprint
    └── out/             render output, git-ignored
```

## Toolchain

- **OpenSCAD:** a 2025+ nightly with the Manifold backend. It is about 20× faster than 2021.01.
- **BOSL2:** cloned into your OpenSCAD `libraries` folder.
  - If Documents is redirected (OneDrive), point `OPENSCADPATH` at that folder.
- **Bambu Studio:** opens the rendered STLs.
  - Slice in the app, not the CLI. The CLI ignores the system printer profiles.

## Tools

| Script | What it does | Changes anything live? |
|---|---|---|
| [`tools/scad_render.ps1`](tools/scad_render.ps1) | Renders one part of a `.scad` to STL + 3MF and four PNG views (iso, top, front, side) in `out/` next to the model. Fails on any OpenSCAD warning. Example: `tools/scad_render.ps1 RibbonBox/ribbon_box.scad -Part plate_pla` | No |

## Docs

- [docs/ribbon-box.md](docs/ribbon-box.md): the ribbon box, sizing, printing at 45°, changing a roll, tuning
