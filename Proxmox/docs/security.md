# Security

The certificate is self-signed, so `pve_get.sh` uses `curl -k` by default —
acceptable on the LAN, and no worse than reaching Home Assistant over plain
HTTP, but it means the token is only as safe as the network. Set `PVE_CACERT`
in `secrets.env` to pin a certificate instead.

The token is revocable from the same UI panel that created it, and being
`PVEAuditor` it cannot alter the hypervisor even if it leaks.
