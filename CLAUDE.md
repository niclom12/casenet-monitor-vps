# CLAUDE.md — install runbook for this repo

You are an AI agent (Claude Code or similar) asked to install **casenet-monitor** on a
**fresh Debian/Ubuntu VPS**. Follow these steps in order. Do not skip the verification
gates. Stop and ask the human only where this file tells you to.

## What this is
A daemon that watches a single Missouri **CaseNet** court docket and emails + ntfy-pushes
when a new docket entry appears. It drives a **real headful Google Chrome under an Xvfb
virtual display** (NOT headless — that's what gets past Cloudflare) and **refuses to scrape
unless the machine's egress IP is in the configured country** (default US), which it reaches
via a **ProtonVPN WireGuard** tunnel. See `docs/ARCHITECTURE.md`.

## Hard prerequisites you must confirm with the human FIRST
1. **A WireGuard config file for a US ProtonVPN server** (`*.conf`) is available on the VPS,
   OR the human will provide one. Without US egress, scraping will fail by design.
2. **SMTP credentials** (host/port/user/pass/from) for sending alert email.
3. **Recipient lists**: who gets case-entry alerts (`ALERT_TO`) and who gets failure alerts
   (`FAIL_ALERT_TO`).
4. The **case**: the full CaseNet `TARGET_URL`, the `CASE_LABEL` (e.g. `2622-CC00325`) and
   `CASE_NAME` (e.g. `King v. Monsanto`).
5. (Optional) an **ntfy topic** for phone push.

If any are missing, ask for them before proceeding. Do not invent secrets.

## Steps

### 1. Install system + app deps and systemd units
```bash
sudo bash scripts/install.sh
```
This installs Node 22, Google Chrome, Xvfb, WireGuard tools, runs `npm install`, writes the
systemd units, starts Xvfb, and creates `.env` from the template. It will print "config
incomplete" and stop before starting the monitor — that's expected.

Pick the run user with `RUN_USER=<user>` if not the sudo user, e.g.
`sudo RUN_USER=casenet bash scripts/install.sh`.

### 2. Fill in `.env`
Edit `<repo>/.env` with the values from the human (TARGET_URL, CASE_LABEL, CASE_NAME, SMTP_*,
ALERT_FROM, ALERT_TO, FAIL_ALERT_TO, NTFY_TOPIC, BROWSER_PROFILE path). Keep `DISPLAY=:99`
and `CDP_PORT=9222` unless you changed the unit files. `.env` must be `chmod 600`.

### 3. Bring up the US VPN
```bash
sudo bash scripts/setup-vpn.sh /path/to/proton-us.conf
```
**GATE:** confirm egress is the target country before continuing:
```bash
curl -s https://api.country.is/ ; echo
```
If `country` is not US (or your `VPN_COUNTRY`), STOP and fix the VPN. Do not start the monitor.

### 4. Verify email path
```bash
sudo -u "$RUN_USER" bash -lc 'cd <repo> && npm run test-send'
```
Confirm `accepted=[...]` includes the expected recipient(s) and `rejected=[]`.

### 5. Verify a real docket read (the make-or-break step)
```bash
sudo -u "$RUN_USER" DISPLAY=:99 bash -lc 'cd <repo> && npm run once'
```
Expected success looks like: `[vpn] egress country=US`, `[cdp] ws://...`, then either
`baseline established` (first run) or `no change`. 

**If you see `Blocked ... (Cloudflare?): "just a moment"`** the browser didn't pass the
challenge. Do NOT declare success. Go to `docs/TROUBLESHOOTING.md` → "Cloudflare blocks".
The usual fix: solve the challenge once interactively over the persistent profile (VNC into
:99), or confirm the VPN exit isn't on a Cloudflare-blocklisted range. Report this to the
human rather than papering over it.

### 6. Start the loop
```bash
sudo systemctl start casenet-monitor
sudo systemctl status casenet-monitor --no-pager | head -8
bash scripts/healthcheck.sh
```

### 7. Report to the human, honestly
State: services active/enabled, egress country, whether the `--once` check **actually read
the docket** (baseline hash) or was Cloudflare-blocked, and the recipient split in effect.
Do not claim it's "working" unless step 5 read the docket.

## Operating notes (tell the human)
- After editing `.env`: `sudo systemctl restart casenet-monitor`.
- It only alerts on entries that appear **after** its first successful check (baseline). To
  put existing entries on record, send a one-time snapshot (see README → "Cold-start gap").
- Don't `kill` the node pid to stop it — systemd respawns it. Use
  `sudo systemctl stop casenet-monitor`.
- Logs: `journalctl -u casenet-monitor -f` or `tail -f <repo>/monitor.log`.
