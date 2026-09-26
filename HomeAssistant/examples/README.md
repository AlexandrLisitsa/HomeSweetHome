# Examples

Templates for the Home Assistant files that are **never committed**, because
they hold credentials, private addresses, or names in the household's own
language. Copy each one to the box, drop the `.example` part and fill it in.

They live here rather than next to the real files because `tools/ha_pull.sh`
replaces `config/` with a fresh copy of the box's `/config` on every pull, and
anything that exists only in the repo would be deleted.

| Template | Copy to (on the box) | Holds |
| --- | --- | --- |
| [`secrets.yaml.example`](secrets.yaml.example) | `/config/secrets.yaml` | the IRBridge token and one URL per endpoint, the DTEK address |
| [`google_assistant.example.yaml`](google_assistant.example.yaml) | `/config/google_assistant.yaml` | the Google Home block: project id, exposed domains, and each entity's name and aliases |
| [`household_notify.example.yaml`](household_notify.example.yaml) | `/config/packages/household_notify.yaml` | the `notify.household` group that every alert is sent to |

`google_key.json`, the Google Cloud service-account key that
`google_assistant.yaml` includes, has no template: download it from the Google
Cloud console when you set up the Google Assistant integration.

After copying, validate and restart:

```sh
ssh ha "ha core check && ha core restart"
```
