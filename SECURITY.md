# Security

This repository configures a real, lived-in home. It is published so the ideas
and tooling can be reused, not so the house can be reached.

## What is kept out of git

- **Credentials** — Home Assistant tokens, the Google Cloud service-account key,
  Wi-Fi and OTA passwords, the ESPHome API key, the IRBridge token, the
  Proxmox API token, MeterCam's and MeterBots' tokens, the Telegram API
  credentials, the off-site backups' rclone crypt password and the backup
  alert's webhook id live only in git-ignored files (`secrets.yaml`,
  `secrets.env`, `.env`, `config.h`, `google_key.json`, `local.properties`) or
  only on the machine that needs them (`rclone.conf` and
  `/etc/default/vzdump-offsite` on the Proxmox host). Every committed file
  that needs one has an `*.example` with placeholder values; the full list is
  in the [README](README.md#secrets-and-private-files).
- **The Telegram session** — MeterBots' `telegram.session` is a logged-in
  Telegram account. It exists only in LXC 105 and, encrypted, in the off-site
  backup; it is never committed, copied to a workstation or run in two places.
- **Home Assistant's internal state** — `.storage/` (sessions, integration
  passwords, registries) and `zigbee2mqtt/` (the network key) are never pulled
  from the box, and are git-ignored as a second line of defence.
- **Private data** — the home address, LAN addresses, device MACs and the names
  of household devices are kept in the same git-ignored files, and are replaced
  by placeholders everywhere they are documented.

CI runs a secret scan ([gitleaks](https://github.com/gitleaks/gitleaks)) on every
push.

## Reporting

If you find a credential, address or other private detail in this repository or
its history, please **don't open a public issue**. Report it privately through
GitHub's [private vulnerability reporting](../../security/advisories/new) for
this repository, and it will be rotated and removed.
