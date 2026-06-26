#!/usr/bin/env bash
# Quick status of the whole stack. Run any time:  bash scripts/healthcheck.sh
set -u
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDP_PORT="$(grep -E '^CDP_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2)"; CDP_PORT="${CDP_PORT:-9222}"
VPN_COUNTRY="$(grep -E '^VPN_COUNTRY=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2)"; VPN_COUNTRY="${VPN_COUNTRY:-US}"

echo "== systemd services =="
for s in casenet-xvfb casenet-monitor; do
  printf '  %-18s %s / %s\n' "$s" \
    "$(systemctl is-active "$s" 2>/dev/null || echo inactive)" \
    "$(systemctl is-enabled "$s" 2>/dev/null || echo disabled)"
done

echo "== egress country (want: $VPN_COUNTRY) =="
curl -sS -m 8 https://api.country.is/ 2>/dev/null; echo

echo "== browser CDP (port $CDP_PORT) =="
curl -sS -m 5 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | head -c 120; echo

echo "== Xvfb display =="
pgrep -af "Xvfb" | grep -v pgrep || echo "  Xvfb not running"

echo "== monitor state =="
cat "$APP_DIR/state.json" 2>/dev/null || echo "  (no state.json yet)"
echo
echo "== last 12 log lines =="
tail -12 "$APP_DIR/monitor.log" 2>/dev/null || journalctl -u casenet-monitor -n 12 --no-pager 2>/dev/null
