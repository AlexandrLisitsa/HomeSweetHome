# Router console

The TP-Link Archer C80 on one screen: what the house moves through it right
now, what it moved over the day and the month, and the address the provider
gives it. The card is `config/www/router-console-card.js`
(`custom:router-console-card`). It lives on the **Network** dashboard
(`/dashboard-network`), and a tap on the router on the Home floor plan opens
the same card in a modal (see [`../../FloorPlan/README.md`](../../FloorPlan/README.md)).

## Where the numbers come from

HA reaches the router only through **UPnP** (the stock `upnp` integration).
That gives three entities, and the console reads nothing else and adds
nothing to the house:

| Entity | What it is |
| --- | --- |
| `sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_download_speed` | bytes per second in, in KiB/s, worked out by the integration every 30 s from the router's counters |
| `sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_upload_speed` | the same, out |
| `sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_external_ip` | the router's WAN address |

The integration also has byte and packet totals and packet rates. They are
disabled in the registry, and the console does not need them.

## What it shows

- **Status pill:** *Online* while the rates arrive, *Stale* after 10 minutes
  without one, *No data* when both are unavailable (the router is off or
  rebooting, or HA lost its UPnP link).
- **Download and Upload:** the rate now in Mbit/s (the unit a tariff is sold
  in), a bar against the highest rate in the last 24 h, and today's peak and
  time-weighted average since midnight, from the recorder's raw history.
- **External IP:** the address and when it last changed, with its kind:
  - *CGNAT* for 100.64.0.0/10: the provider's carrier-grade NAT. The public
    address is shared with other homes, so no port forward on the router
    reaches the house from outside. Remote access goes out through a tunnel
    instead (Cloudflare, Tailscale).
  - *Behind another router* for a private (RFC 1918) address.
  - *Public* for anything else.
- **Throughput chart:** download (filled) and upload together. *24 h* uses
  the recorder's readings (it keeps 2 days of them). *7 d* and *30 d* use its
  hourly statistics (kept for good), averages as lines and each hour's peak
  dashed.

Every tile, the pill, the chart and the range buttons carry a tooltip in the
house format ([`dashboard-tooltips.md`](dashboard-tooltips.md)). A tap on a
tile opens that entity's dialog.

## Cost

The card fetches history when it is put on a page, then every 5 minutes while
it stays there and the tab is visible. Taken off the page (the modal closed,
the dashboard left) it stops its timer, so it costs the box nothing while no
one looks.

## Deploying

```sh
sh HomeAssistant/tools/ha_www_push.sh
python HomeAssistant/tools/ha_dashboard.py --card router-console-card.js
python HomeAssistant/tools/ha_dashboard.py --push HomeAssistant/dashboards/lovelace.dashboard_network.json \
    --url-path dashboard-network
```

The dashboard was created once with
`ha_dashboard.py --create dashboard-network --title Network --icon mdi:router-wireless`.
Bump `VERSION` in the card on every edit; `--card` re-registers it under the
new `?v=`.

Tests: `node HomeAssistant/tools/test_router_card.js`. The tooltip test,
`test_card_tooltips.js`, covers it too. The addresses in both tests are made
up: the house's real one never goes in git.
