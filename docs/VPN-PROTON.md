# ProtonVPN (WireGuard) on the VPS

The monitor refuses to scrape unless the machine's egress IP geolocates to `VPN_COUNTRY`
(default `US`). On a VPS you provide that US egress with a **WireGuard** tunnel to a
ProtonVPN US server. WireGuard (not the desktop app) is the right tool for a headless box.

## 1. Generate a WireGuard config (paid Proton plan)
In your Proton account (account.protonvpn.com) → **Downloads → WireGuard configuration**:
- **Platform:** GNU/Linux
- **Server:** pick a **specific US server** (e.g. `US-NY#123`). Picking a fixed server is what
  stops the "drift" to other countries that bare GUI auto-connect can do.
- **Features:** NetShield as you like. Leave it as a standard (not Secure Core) server unless
  you need it.
- Download the `.conf` and copy it to the VPS (e.g. `scp proton-us.conf vps:/root/`).

> Free Proton plans generally can't export WireGuard configs — you'll want Plus/Unlimited.

## 2. Install + enable it
```bash
sudo bash scripts/setup-vpn.sh /root/proton-us.conf
```
This copies it to `/etc/wireguard/casenet-vpn.conf` (mode 600) and enables
`wg-quick@casenet-vpn` on boot. Verify:
```bash
sudo wg show casenet-vpn
curl -s https://api.country.is/ ; echo      # expect {"country":"US"}
```

## 3. Full-tunnel vs split-tunnel
Proton's config sets `AllowedIPs = 0.0.0.0/0, ::/0` → **full tunnel**: all VPS traffic exits
via Proton US. That's the simplest and what the monitor expects (its own egress check then
reflects the tunnel). Keep it unless you have a reason to split.

If you split-tunnel and only route the browser, you must ensure both Chrome **and** the
monitor's `api.country.is` check exit via US, or the guard will misfire.

## 4. Kill-switch / safety
- The monitor's `VPN_CHECK` is an application-level kill-switch: if egress isn't US it won't
  scrape, it pauses and alerts `FAIL_ALERT_TO`. So a tunnel drop = paused monitoring, **not** a
  leak to the bare VPS IP.
- For a network-level kill-switch too, you can add firewall rules that drop non-WireGuard
  egress; optional, since the app guard already prevents scraping off-VPN.

## 5. Keeping it US (the bug we hit on the laptop)
The laptop's ProtonVPN reconnected to ZA then NL, which blinded the monitor. On the VPS:
- Use a **fixed server** `.conf` (above) — `wg-quick` won't wander.
- `wg-quick@casenet-vpn` is `enabled` so it comes back after reboot.
- If a server goes down, drop a new `.conf` and re-run `setup-vpn.sh`.

## Sanity checks
```bash
sudo systemctl status wg-quick@casenet-vpn
sudo wg show
curl -s https://api.country.is/ ; echo
```
