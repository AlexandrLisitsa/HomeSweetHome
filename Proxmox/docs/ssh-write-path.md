# The SSH write path

The API token is `PVEAuditor`: it can read every node, guest, config and metric,
and change nothing. Anything that has to change the host, such as creating and
deploying MeterCam's and MeterBots' containers (104, 105), goes over SSH as root
instead, through `tools/pve_ssh.sh`.

| | Credential | Can | Used by |
| --- | --- | --- | --- |
| **read** | API token, `PVEAuditor` | see every node, guest, config and metric; **change nothing** | `pve_get.sh`, `cpu_trend.py` |
| **write** | SSH key, `root@pam` | anything `pct`, `qm` and `pvesh` can | `pve_ssh.sh` |

## One key for the host

`~/.ssh/pve_ed25519` is a **general administrative key for this host**, not a
per-project one. It is `root@pam`, so it can create and destroy guests, edit
their configs, read every disk and reboot the box. Whatever gets automated
against this hypervisor next uses this same key — there is no second, narrower
one to go looking for.

## Why SSH and not a write-capable token

The work is not one call. `pct create` has an API equivalent; `pct exec` does not
— the API offers a websocket terminal, which is not a thing a shell script should
be driving. Half the job would be REST and half SSH, so it is all SSH.

## What the read/write split does and does not buy

The token being `PVEAuditor` genuinely means that anything reaching this host
*for metrics* cannot alter it — not by accident, not through a bug in
`cpu_trend.py`. That is real. It does not constrain the SSH key even slightly: a
root shell is a root shell. The split makes intent legible, not capability
limited.

## Installing and revoking

The key is installed once by hand from the Proxmox UI's own shell, where you are
already root and need no key to get in; the steps are in
[`secrets.env.example`](../secrets.env.example).

**Revoking** means deleting the line from `/root/.ssh/authorized_keys`. Unlike the
API token there is no UI panel for it, which is the one practical cost of using
SSH here, and it is worth knowing where that line lives before you need it gone.

```sh
sh tools/pve_ssh.sh pveversion
sh tools/pve_ssh.sh pct list
sh tools/pve_ssh.sh 'pct exec 104 -- docker ps'
sh tools/pve_ssh.sh 'qm config 100'
```

Its consumers are `MeterCam/deploy/` and `MeterBots/deploy/`, which create
and provision LXC 104 and 105.
