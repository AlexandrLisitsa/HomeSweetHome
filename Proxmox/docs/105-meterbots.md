# 105 · MeterBots (`meterbots`)

Files the monthly meter readings with the suppliers' Telegram bots, as the
household's own Telegram user, when Home Assistant asks after a tap on the
phone. The project is [`MeterBots/`](../../MeterBots/README.md).

| | |
| --- | --- |
| Type | unprivileged LXC, Debian 13, `nesting` and `keyctl` on (it runs Docker) |
| CPU / RAM / disk | 1 vCPU / 512 MB (+512 MB swap) / 2 GB, the house defaults |
| Software | Docker, running the MeterBots service from `MeterBots/docker-compose.yml` |
| Created by | `MeterBots/deploy/lxc_create.sh`, provisioned by `lxc_provision.sh`, updated by `deploy.sh` |
| Starts with host | yes |

## Things to know

- It holds the most sensitive state on the host, in `/opt/meterbots/`:
  - `.env`: the Telegram `api_id` / `api_hash`, the bots' tokens and the
    suppliers' account numbers
  - `data/telegram/telegram.session`, a **logged-in Telegram account**

  A deploy ships code only and never overwrites either.
- It is **not dumped** by the weekly backup job. Its state goes off-site as a
  few-KB encrypted archive with the LXC run instead
  ([`backups.md`](backups.md)), and the image rebuilds from git.
- It is the guest that talks to the internet on the household's behalf. It
  reaches Telegram (MTProto), and only when Home Assistant asks.
- The session must never run in two places at once: Telegram can revoke it
  ([`MeterBots/docs/deployment.md`](../../MeterBots/docs/deployment.md),
  "Moving the session"). It moved here from 104 on 2026-10-04.
- Its address, gateway and VM id are set in `MeterBots/deploy/_lxc_env.sh`,
  with the real address in the git-ignored `deploy/lxc.env`.
- Like 104, this repository creates and changes it through the
  [SSH write path](ssh-write-path.md).
