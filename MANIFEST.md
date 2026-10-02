# Manifest

The rules this repository follows, and the shape it must keep. When a change
would break one of these, change the rule here first, or don't make the change.

## 1. Layout

```text
HomeSweetHome/
├── README.md            the big picture: what the repo is, how the projects fit, where to start
├── MANIFEST.md          this file: the rules and the required layout
├── SECURITY.md          how secrets and private data are kept out, how to report a leak
├── LICENSE              MIT, plus notes on bundled third-party licences
├── .github/workflows/   CI
├── .gitignore  .gitattributes  .editorconfig  .gitleaks.toml
│
└── <Project>/           one directory per project, PascalCase
    ├── README.md        required: the project's purpose and use, in detail
    ├── docs/            optional: one .md per specific topic
    │   ├── <topic>.md   lowercase-kebab-case, e.g. security.md, architecture.md
    │   └── images/      optional: figures the docs embed (SVG preferred)
    ├── tools/           optional: host-side scripts that operate the project
    ├── examples/        optional: templates for files that are never committed
    ├── <source dirs>    whatever the project's own toolchain expects (app/, config/, firmware/, ...)
    └── .gitignore  .gitattributes   optional, only for rules specific to the project
```

- **Nothing else lives at the root.** No stray scripts, no shared `tools/`, no
  loose docs. Something that serves one project lives in that project; the root
  holds only the files above.
- **Every project is listed in the root README**, with one line on what it is.
- A new project gets its own directory with a README before anything else.

## 2. Documentation

- **Every documentation file is Markdown (`.md`).** JSON, YAML and plain text are
  configuration or data, never documentation. If a tool needs facts that are also
  documented, the tool reads the Markdown (for example a table), not a parallel
  JSON "doc".
- **Three layers, one job each:**

  | Layer | Answers | Must not contain |
  | --- | --- | --- |
  | Root `README.md` | What is this repo? How do the projects relate? Where do I start? | Per-project procedures or reference detail |
  | `<Project>/README.md` | What is this project for, how is it built, set up and used? | Long write-ups of a single topic |
  | `<Project>/docs/<topic>.md` | One specific thing in depth: architecture, security approach, a protocol, a procedure, an investigation | Anything that is not that topic |

- When a README section grows into a topic of its own, it moves to
  `docs/<topic>.md` and the README links to it. A project README ends with a
  **Docs** list linking every file in its `docs/`.
- **Every script in `tools/` is listed in the project README**, in a table with
  one line on what it does and whether it changes anything live.
- A `README.md` below project level is allowed only as a short index of that
  folder's files (as in `HomeAssistant/examples/`), never as a topic document.
- `docs/` holds Markdown only, plus an `images/` folder for the figures the docs
  embed.
- A generated document, such as a printable PDF, is built from the Markdown by a
  script in the project's `tools/` and committed at the project root. The
  Markdown is the source of truth; nothing is written by hand in HTML.

## 3. Language

- **English only**: code, identifiers, comments, docs, commit messages and
  committed configuration.
- **No transliterated identifiers.** Entity ids, area ids, file names and
  dashboard paths use English words (`kitchen_relay`, not `kukhnia_rele`).
- The only exceptions are strings that must match an external API byte for byte
  (the DTEK outage schedule), and configuration that must be in the household's
  language, such as the names Google Home speaks. The latter lives in a
  git-ignored file with an English template in `examples/`.

## 4. Secrets and private data

- **Never committed:** credentials (tokens, passwords, keys, service-account
  JSON), the home address, LAN addresses, MAC addresses, names of household
  members or their devices, photos of the home, and the apartment model.
- **Every real private file is git-ignored and has a committed template**, either
  `<name>.example` next to where the real file goes or, for Home Assistant, in
  `HomeAssistant/examples/` (because `ha_pull.sh` replaces `config/`). The root
  README lists every pair.
- **Placeholders** in docs and templates: `homeassistant.local`, `<phone-ip>`,
  `<proxmox-ip>`, or the documentation range `192.0.2.0/24` (RFC 5737);
  `AA:BB:CC:DD:EE:FF` for a MAC.
- Private values reach config through `!secret` (Home Assistant, ESPHome) or a
  git-ignored env file (shell tools).
- CI runs gitleaks on every push; `.gitleaks.toml` may allow-list only a
  documented placeholder.

## 5. Files and formats

- **Line endings are LF** everywhere except `*.bat`. Most files end up on Linux
  hosts, and Home Assistant OS's BusyBox `ash` breaks on CRLF.
- UTF-8, final newline, no trailing whitespace (see `.editorconfig`).
- **Build output is never committed** (`build/`, `.esphome/`, `.pio/`, `.gradle/`,
  APKs, firmware binaries). Binary assets are committed only when something serves
  them (dashboard images, web fonts, generated PDFs).

## 6. Versions

Everything this repo versions is `MAJOR.MINOR.PATCH`, and every change that
ships bumps at least one of them:

| Bump | When |
| --- | --- |
| `MAJOR` | Something that uses it has to change too: a card config key renamed or removed, an HTTP endpoint changed, an entity the card needs that did not exist before. |
| `MINOR` | Something new you can see or use: a badge, a tab, a control, an endpoint. |
| `PATCH` | A fix or a tweak that changes nothing anyone relies on: a colour, a threshold, a bug, a comment. |

| What | Version | Shows up as |
| --- | --- | --- |
| Lovelace cards in `HomeAssistant/config/www/` | `const VERSION` at the top of the card | The resource URL's `?v=`, and the banner the card logs to the browser console |
| `IRBridge` app | `versionName` in `app/build.gradle.kts` | `"version"` in the bridge's `/health` reply |

For a card, the `?v=` is the version and nothing else: register it with
`ha_dashboard.py --card <file>`, never by hand. Not ours, and left as they are:
`"version"` / `"minor_version"` in `HomeAssistant/dashboards/*.json` (Home
Assistant's schema), `versionCode` (bumped by one whenever `versionName` changes),
and the content-hash `?v=` on floor-plan images.

## 7. Changing the live house

- The repo is the source of truth for everything it mirrors. A change is edited
  here, deployed with the project's tool, then pulled back; an empty diff proves
  the box matches git.
- Renaming an entity or helper also means restoring the state of any helper
  that gates an automation: Home Assistant restores state by entity id, so a
  renamed `input_boolean` comes back at its default after the next restart.

## 8. Git

- **`master` is the public branch.** A project that is not finished lives on its
  own branch (currently `ledlamp` and `feature/electricity-meter`), built on
  `master` and holding only that project on top, until it is merged.
- Public history is authored with the GitHub noreply address.
- Commit messages: an imperative summary line, a blank line, then the why.
