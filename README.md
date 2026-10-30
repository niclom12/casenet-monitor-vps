# casenet-monitor (VPS)

Watch a single **Missouri CaseNet** court docket and get an **email + phone push** the moment
a new docket entry appears — running unattended on a VPS.

It works the way a human would: a **real Google Chrome** (headful, rendered into an **Xvfb**
virtual display) loads the case page through a **US VPN**, reads the docket table, and diffs it
against the last seen version. It is deliberately **not** a headless scraper — that's what lets
it pass CaseNet's Cloudflare protection.

> Built from a working laptop deployment (case **2622-CC00325 — King v. Monsanto**) and
> generalised so the whole thing is reproducible on a VPS from a clean clone.

---

## Quickstart (clone → install → run)

On a fresh **Debian/Ubuntu** VPS:

```bash
git clone <this-repo> casenet-monitor && cd casenet-monitor

# 1. install Node 22, Chrome, Xvfb, WireGuard tools, app deps, systemd units
sudo bash scripts/install.sh

# 2. fill in your config (case URL, SMTP, recipients, ntfy)
nano .env

# 3. bring up a US ProtonVPN tunnel (WireGuard .conf from your Proton account)
sudo bash scripts/setup-vpn.sh /path/to/proton-us.conf
curl -s https://api.country.is/ ; echo        # confirm "country":"US"

# 4. verify, then start
npm run test-send         # confirms email works
npm run once              # confirms it can actually read the docket
sudo systemctl start casenet-monitor

# anytime:
bash scripts/healthcheck.sh
```

**Installing with an AI agent?** Point it at [`CLAUDE.md`](CLAUDE.md) — it's a precise,
gated runbook ("clone the repo, then tell Claude to install it").

---

## What you need before you start
- A **VPS** (Debian 12 / Ubuntu 22.04+), ~1 vCPU / 1 GB RAM is plenty.
- A **ProtonVPN** plan that can export **WireGuard** configs, and a **US** server config file.
- **SMTP** sending credentials (host/port/user/pass/from).
- The **case**: full CaseNet `TARGET_URL`, `CASE_LABEL`, `CASE_NAME`.
- (Optional) an **ntfy** topic for phone push (install the ntfy app, subscribe).

See [`.env.example`](.env.example) for every setting, documented inline.

## How alerting works (two separate lists)
- **`ALERT_TO`** → real **case** alerts: "<case> docket entry". The people who care about the case.
- **`FAIL_ALERT_TO`** → **operational** alerts: "CANNOT REACH DOCKET" / "recovered". Usually
  just the ops owner — keep case-only people off this so VPN/health noise doesn't reach them.
- **ntfy** push fires alongside email for both, to the configured topic.

A failure email is sent only after `FAIL_ALERT_THRESHOLD` (default 2) consecutive failed
checks, and at most once per `FAIL_REALERT_HOURS` while still down. It auto-sends "recovered"
when the docket is reachable again.

## The two things that actually make or break it
1. **Egress IP must be US.** CaseNet/Cloudflare blocks non-US and many datacenter IPs. The VPN
   provides US egress; the monitor's `VPN_CHECK` guard refuses to scrape otherwise (so it pauses
   + alerts instead of getting your IP flagged). See [`docs/VPN-PROTON.md`](docs/VPN-PROTON.md).
2. **Headful, not headless.** A real Chrome fingerprint under Xvfb passes Cloudflare's managed
   challenge; pure headless usually doesn't. See [`docs/ANTI-BOT.md`](docs/ANTI-BOT.md).

## Cold-start gap (important)
The monitor alerts on entries that appear **after** its first successful check (its "baseline").
Anything already on the docket at install time is captured silently into that baseline and will
**not** trigger an alert. To put the current state on record, after the first successful check run:
```bash
# emails the current docket text to ALERT_TO as a one-time record
npm run once && cat last-docket.txt   # then forward, or use a snapshot in snapshots/
```
(Or ask your agent to send a one-time "current docket state" email.)

## Day-2 operations
| Task | Command |
|---|---|
| Status / health | `bash scripts/healthcheck.sh` |
| Live logs | `journalctl -u casenet-monitor -f` |
| Restart after editing `.env` | `sudo systemctl restart casenet-monitor` |
| Stop (don't `kill` — it respawns) | `sudo systemctl stop casenet-monitor` |
| Switch VPN server | drop a new `.conf`, re-run `scripts/setup-vpn.sh` |
| Change cadence | edit `INTERVAL_MS` in `.env` (15 min since 19 Oct 2026), restart |
| Change the fast window | `ACTIVE_TZ` / `ACTIVE_DAYS` / `ACTIVE_HOURS` (default 08:00-17:00 Central, Mon-Fri). Checks run all day: `INTERVAL_MS` inside the window, `SLOW_INTERVAL_MS` (default 1 h) outside it. A failed check retries at the same cadence, never a longer one |

## Repo layout
```
src/monitor.ts            the monitor (TypeScript, run via tsx)
scripts/install.sh        VPS installer (deps + units, idempotent)
scripts/setup-vpn.sh      ProtonVPN WireGuard bring-up
scripts/test-send.mjs     SMTP smoke test
scripts/healthcheck.sh    one-shot status
systemd/                  Xvfb + monitor unit templates
.env.example              all config, documented
CLAUDE.md                 AI-agent install runbook
docs/                     architecture, VPN, anti-bot, troubleshooting
```

## Docs
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit
- [`docs/VPN-PROTON.md`](docs/VPN-PROTON.md) — ProtonVPN WireGuard on a VPS
- [`docs/ANTI-BOT.md`](docs/ANTI-BOT.md) — headful/Xvfb and Cloudflare, honestly
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — when a check fails

## Legal / etiquette
CaseNet docket data is public record, but automated access should be polite: the default
30-minute cadence with jitter is intentionally gentle. Don't lower it aggressively. You are
responsible for complying with the court site's terms and your jurisdiction's rules.
