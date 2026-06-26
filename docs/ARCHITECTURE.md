# Architecture

```
                         VPS (Debian/Ubuntu)
 ┌───────────────────────────────────────────────────────────────────────┐
 │                                                                         │
 │  wg-quick@casenet-vpn ───────► ProtonVPN US exit  ──►  internet (US IP) │
 │        (WireGuard tunnel; all egress is US)                             │
 │                                                                         │
 │  casenet-xvfb.service                                                   │
 │     Xvfb :99  (virtual 1920x1080 display, no monitor)                   │
 │        ▲                                                                │
 │        │ renders into                                                   │
 │  Google Chrome (headful) ──exposes──► CDP :9222                         │
 │     • launched on demand by the monitor (self-heal)                     │
 │     • persistent --user-data-dir (keeps Cloudflare clearance cookies)   │
 │        ▲                                                                │
 │        │ Playwright connectOverCDP                                      │
 │  casenet-monitor.service                                                │
 │     node --import tsx src/monitor.ts                                    │
 │     loop every ~30m (±jitter):                                          │
 │        1) ensure Chrome/CDP up (relaunch if down)                       │
 │        2) check egress country == VPN_COUNTRY, else pause+alert         │
 │        3) load landing → case page → read #actualDocketData             │
 │        4) sha256 the docket text; diff vs state.json                    │
 │        5) new entry? → email ALERT_TO + ntfy push                       │
 │           can't reach? → after N fails, email FAIL_ALERT_TO + ntfy      │
 └───────────────────────────────────────────────────────────────────────┘
                         │                         │
                         ▼                         ▼
                    SMTP (email)              ntfy.sh topic (phone push)
```

## Components
- **WireGuard tunnel** (`wg-quick@casenet-vpn`): pins egress to a US ProtonVPN server.
  Independent of the app; the app only *checks* the resulting egress country.
- **Xvfb** (`casenet-xvfb.service`): a virtual X display so Chrome can run **headful** without
  a physical screen. This is the key difference from a normal headless scraper.
- **Google Chrome**: launched by the monitor with `--remote-debugging-port` into display `:99`,
  using a **persistent profile** so Cloudflare clearance cookies survive restarts. The monitor
  self-heals it: if CDP is down at check time, it relaunches Chrome.
- **monitor.ts**: the control loop. Connects to Chrome over CDP via Playwright, navigates, reads
  the docket node, hashes + diffs, and dispatches alerts. All config via `.env`.

## State
- `state.json` — last docket hash, baseline timestamp, heartbeat + failure-alert bookkeeping.
- `last-docket.txt` — last seen docket text (used to compute *which* lines are new).
- `snapshots/` — full-page HTML at each detected change (evidence/debugging).

## Why two systemd services (not one)
Xvfb must be up before Chrome can render; keeping it separate means the browser display
survives a monitor restart, and a monitor crash-loop never tears down the display. The
monitor `Requires=casenet-xvfb.service` so ordering/availability is enforced.

## Failure semantics
- A check that can't reach the docket throws; `consecutiveFailures` increments with exponential
  backoff (capped 4h).
- After `FAIL_ALERT_THRESHOLD` failures it emails `FAIL_ALERT_TO` once, re-mailing at most every
  `FAIL_REALERT_HOURS`. On the next success it emails "recovered" and resets.
- The VPN guard converts "egress drifted off US" into a normal failure (pause + alert), so the
  monitor never scrapes from a non-US/exposed IP.
