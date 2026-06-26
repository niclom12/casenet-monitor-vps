#!/usr/bin/env bash
# =============================================================================
# Bring up a ProtonVPN (WireGuard) US tunnel and pin it on boot.
#
# 1) In your Proton account: Downloads > WireGuard configuration.
#      - Platform: GNU/Linux
#      - Pick a specific US server (e.g. US-NY#123) so it can't "drift" countries
#      - Enable NetShield / "VPN Accelerator" as you like; for a server, leave
#        "Moderate NAT" off. Save the .conf file and copy it to the VPS.
# 2) Run:  sudo bash scripts/setup-vpn.sh /path/to/proton-us.conf
#
# This installs it as wg-quick@casenet-vpn and enables it on boot. The monitor's
# own VPN_CHECK guard still refuses to scrape if egress ever leaves VPN_COUNTRY,
# so a tunnel drop pauses scraping (and alerts) rather than leaking the VPS IP.
# =============================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)"; exit 1; }

SRC="${1:-}"
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "Usage: sudo bash scripts/setup-vpn.sh /path/to/proton-us.conf"; exit 1; }

IFACE="casenet-vpn"
DST="/etc/wireguard/$IFACE.conf"

command -v wg-quick >/dev/null 2>&1 || { echo "wireguard-tools missing; run install.sh first"; exit 1; }

install -m 600 "$SRC" "$DST"
echo "Installed $DST"

# Optional kill-switch hint: Proton configs can include a [Peer] AllowedIPs=0.0.0.0/0
# which routes everything through the tunnel. Keep that for full-tunnel egress.

systemctl enable --now "wg-quick@$IFACE"
sleep 3

echo "== tunnel status =="
wg show "$IFACE" 2>/dev/null | head -8 || true
echo "== egress country (want US) =="
curl -sS -m 8 https://api.country.is/ 2>/dev/null; echo

echo
echo "To stop:   sudo systemctl stop wg-quick@$IFACE"
echo "To switch servers: drop a new .conf and re-run this script."
