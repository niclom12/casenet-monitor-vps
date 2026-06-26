# Troubleshooting

Run this first — it shows services, egress, CDP, and recent logs:
```bash
bash scripts/healthcheck.sh
```

## "VPN egress is XX, not US — refusing to scrape"
Working as designed: the tunnel isn't on US.
```bash
sudo systemctl status wg-quick@casenet-vpn
sudo wg show
curl -s https://api.country.is/ ; echo
sudo systemctl restart wg-quick@casenet-vpn
```
If the server is dead, download a new US `.conf` and re-run `scripts/setup-vpn.sh`.

## `Blocked ... (Cloudflare?): "just a moment"`
The browser didn't clear Cloudflare. In order:
1. Confirm egress is US (above). A non-US/blocklisted exit is the most common cause.
2. Confirm it's **headful**: `ps -ef | grep chrome` should show no `--headless`. The display
   must exist: `DISPLAY=:99 xdpyinfo >/dev/null && echo ok`.
3. Try a different Proton US server (new `.conf`) — the current exit IP may be flagged.
4. Solve the challenge **once interactively** to seed `cf_clearance` into the persistent profile:
   - Install a VNC server, or use `x11vnc -display :99`, connect, and click through the page.
   - Then re-run `npm run once`.
5. If CaseNet now shows an **interactive CAPTCHA**, unattended scraping can't pass it silently —
   see `docs/ANTI-BOT.md` (use a residential proxy or CAPTCHA service). Report to the human.

## Browser won't start / CDP never comes up
```bash
systemctl status casenet-xvfb            # Xvfb must be active
DISPLAY=:99 xdpyinfo | head              # display reachable?
which google-chrome                      # matches BROWSER_BIN in .env?
curl -s http://127.0.0.1:9222/json/version   # CDP up?
```
- On tiny VPSes, Chrome can OOM on `/dev/shm`. We pass `--disable-dev-shm-usage`; if still
  crashing, add swap or a bigger instance.
- Permission: the `RUN_USER` must own the repo dir and `BROWSER_PROFILE`.

## No email arrived
```bash
npm run test-send         # shows accepted/rejected from the SMTP server
```
- `rejected=[...]`: recipient refused by your mail host.
- Auth/connection error: check `SMTP_HOST/PORT/USER/PASS`. If your host has a valid public cert,
  set `SMTP_STRICT_TLS=true`. If it's self-signed, leave it `false`.
- Got the failure email but not the case email (or vice-versa)? They use different lists —
  check `ALERT_TO` vs `FAIL_ALERT_TO`.

## No ntfy push
- `NTFY_TOPIC` set in `.env` and subscribed in the ntfy app? Topic is case-sensitive.
- Test: `curl -d "hi" https://ntfy.sh/<your-topic>`.

## "It says no change but I'm sure there was a filing"
Almost always the **cold-start gap**: the entry was already on the docket when the monitor took
its baseline, so it was never flagged as *new*. Check `last-docket.txt` / `snapshots/` to see
what the baseline captured. Future entries will alert. (README → "Cold-start gap".)

## Monitor keeps restarting
```bash
journalctl -u casenet-monitor -n 50 --no-pager
```
`Restart=always` respawns on crash; `StartLimitBurst` caps thrash. A persistent crash is usually
a bad `.env` value (missing required var) or Chrome failing to launch — see above.

## Useful commands
```bash
sudo systemctl restart casenet-monitor       # after editing .env
sudo systemctl stop casenet-monitor          # stop (don't kill the pid; it respawns)
journalctl -u casenet-monitor -f             # live logs
tail -f monitor.log
```
