# Security

The certificate is self-signed, so `pve_get.sh` uses `curl -k` by default —
acceptable on the LAN, and no worse than reaching Home Assistant over plain
HTTP, but it means the token is only as safe as the network. Set `PVE_CACERT`
in `secrets.env` to pin a certificate instead.

The token is revocable from the same UI panel that created it, and being
`PVEAuditor` it cannot alter the hypervisor even if it leaks.

The **root SSH key** ([ssh-write-path.md](ssh-write-path.md)) is the opposite:
it can do anything on the host, and since LXC 105 holds MeterBots' Telegram
session, that includes reading and sending as the household's Telegram
account (`pct exec 105`). It lives only on the workstation, without a
passphrase so tools can use it; losing that machine means removing the key
from `/root/.ssh/authorized_keys` and ending the Telegram session in Telegram
→ Settings → Devices.
