# Private files: what is never mirrored

- `secrets.yaml` — every credential and private address the config references
  (template: [`examples/secrets.yaml.example`](../examples/secrets.yaml.example))
- `google_key.json` — a GCP service-account private key, pulled in by
  `google_assistant.yaml`

Two more files **are** copied down by `ha_pull.sh` but are git-ignored, because
they name the household rather than hold credentials. Their English templates
live in [`examples/`](../examples), outside `config/`, so a pull can't delete them:

- `config/google_assistant.yaml` — the Google Home block, with the names and
  aliases in the language the household speaks to Google Home
  ([`examples/google_assistant.example.yaml`](../examples/google_assistant.example.yaml))
- `config/packages/household_notify.yaml` — the `notify.household` group that
  fans every alert out to the household's phones
  ([`examples/household_notify.example.yaml`](../examples/household_notify.example.yaml))

Everything else in the repo is English, apart from a few strings DTEK's API
returns verbatim.

Also never mirrored:

- all of `.storage` — it holds `auth` (every session token on the box) and
  `core.config_entries` (integration passwords). Six files are copied out of it
  by name: three registries into the gitignored `.state/`, and every
  `lovelace*` file into `dashboards/`, which **is** committed
- the Energy dashboard's own configuration — which statistics feed the
  Electricity, Gas and Water tabs, and the static grid prices — in
  `.storage/energy`
- the recorder database and logs

The Energy dashboard is the sharpest edge of that list. Two of its five sources
point at entities defined in `config/packages/`, but the wiring that connects
them is written by a config flow, so it is invisible to git and cannot be
restored from this repo — the packages come back from a `git revert`, the fact
that the Gas tab was pointed at one of them does not. Adding a source is a UI
action at `/config/energy`, and hand-editing the file is worse than doing it in
the UI, because HA holds the prefs in memory and overwrites the file on its next
save. `tools/ha_pull.sh` does not fetch it; a snapshot can be dropped into the
gitignored `.state/energy.json` by name when one is wanted for review. Note the
write is debounced by up to half a minute, so a snapshot taken immediately after
a UI change will still show the old file.

`dashboards/` is the exception to the rule above, and deliberately so. A
registry is derived state — HA rebuilds it from the devices it finds, and it
diffs as noise. A Lovelace layout is hand-built, reproducible from nothing else
in this repo, and was the one thing here with no backup at all. The files carry
no credentials: entity ids and card options, which `configuration.yaml` already
commits by the hundred.

HA writes `.storage` pretty-printed, so these mirror verbatim and still diff
cleanly, and a file copied back is valid input — `json.loads` does not care
about the whitespace HA would have written. To restore one:

```sh
python tools/ha_dashboard.py --push dashboards/lovelace.dashboard_inverter.json     --url-path dashboard-inverter
```

That goes through HA's own API, so it takes effect immediately and reads the
result back to confirm. The manual route — copying the file to
`/config/.storage/<name>` with the `.json` suffix dropped — still works but
needs a restart afterwards: HA caches Lovelace in memory, so an edit without one
is silently discarded.
