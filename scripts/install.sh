#!/usr/bin/env bash
# =============================================================================
# casenet-monitor — VPS installer (Debian/Ubuntu)
#
# Installs system deps (Node 20+, Google Chrome, Xvfb, WireGuard tools), the app
# deps, and the systemd services. Idempotent — safe to re-run.
#
# Usage (run from the repo root, as root or with sudo):
#   sudo bash scripts/install.sh
#
# Optional env vars:
#   RUN_USER=casenet   # system user the services run as (default: the sudo user)
#   SKIP_APT=1         # skip apt installs (deps already present)
#   START=1            # after install, start services + run a --once check
# =============================================================================
set -euo pipefail

log()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (use: sudo bash scripts/install.sh)"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${RUN_USER:-${SUDO_USER:-root}}"
id "$RUN_USER" >/dev/null 2>&1 || die "RUN_USER '$RUN_USER' does not exist"
APP_DIR_OWNER="$(stat -c '%U' "$APP_DIR")"

log "Plan"
echo "   App dir : $APP_DIR"
echo "   Run user: $RUN_USER"
echo "   Node    : $(command -v node >/dev/null 2>&1 && node -v || echo 'not installed')"

# ---------------------------------------------------------------- apt deps ---
if [ "${SKIP_APT:-0}" != "1" ]; then
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg xvfb wireguard wireguard-tools \
    fonts-liberation fonts-noto-color-emoji jq
  ok "base packages installed"

  # Node 20+ via NodeSource if missing or too old
  NODE_OK=0
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -v | sed -E 's/v([0-9]+).*/\1/')"
    [ "$NODE_MAJOR" -ge 20 ] && NODE_OK=1
  fi
  if [ "$NODE_OK" -eq 0 ]; then
    log "Installing Node.js 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  ok "node $(node -v)"

  # Google Chrome (stable) — real Chrome fingerprint helps vs Cloudflare
  if ! command -v google-chrome >/dev/null 2>&1; then
    log "Installing Google Chrome (stable)"
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list
    apt-get update -y
    apt-get install -y google-chrome-stable
  fi
  ok "$(google-chrome --version 2>/dev/null || echo 'chrome installed')"
else
  warn "SKIP_APT=1 — skipping system package install"
fi

command -v node >/dev/null 2>&1 || die "node missing; re-run without SKIP_APT=1"
command -v google-chrome >/dev/null 2>&1 || warn "google-chrome not found — set BROWSER_BIN in .env to your browser"
command -v Xvfb >/dev/null 2>&1 || die "Xvfb missing; re-run without SKIP_APT=1"

# ------------------------------------------------------------- app deps ------
log "Installing app dependencies (npm)"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR" 2>/dev/null || true
sudo -u "$RUN_USER" bash -lc "cd '$APP_DIR' && npm install --no-audit --no-fund"
ok "node_modules installed"

# --------------------------------------------------------------- .env --------
if [ ! -f "$APP_DIR/.env" ]; then
  log "Creating .env from template"
  sudo -u "$RUN_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  warn ".env created — YOU MUST FILL IT IN before the monitor will work:"
  echo "      nano $APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

# ------------------------------------------------------------ systemd --------
log "Installing systemd services"
for unit in casenet-xvfb casenet-monitor; do
  sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__RUN_USER__|$RUN_USER|g" \
    "$APP_DIR/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
  ok "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable casenet-xvfb.service casenet-monitor.service >/dev/null 2>&1 || true
ok "services enabled (will start on boot)"

# Xvfb has no secrets/config deps — safe to start now.
systemctl restart casenet-xvfb.service || warn "could not start Xvfb yet"

# ---------------------------------------------------- config completeness ----
env_val() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- ; }
MISSING=()
for k in TARGET_URL CASE_LABEL SMTP_HOST SMTP_USER SMTP_PASS ALERT_FROM ALERT_TO; do
  [ -z "$(env_val "$k")" ] && MISSING+=("$k")
done

if [ "${#MISSING[@]}" -ne 0 ]; then
  log "NEXT STEPS (config incomplete)"
  echo "   1) Fill in .env  (missing: ${MISSING[*]})"
  echo "        nano $APP_DIR/.env"
  echo "   2) Bring up the US VPN (see docs/VPN-PROTON.md):"
  echo "        sudo bash $APP_DIR/scripts/setup-vpn.sh /path/to/proton-us.conf"
  echo "   3) Verify mail + a single check, then start the loop:"
  echo "        sudo -u $RUN_USER bash -lc 'cd $APP_DIR && npm run test-send'"
  echo "        sudo -u $RUN_USER bash -lc 'cd $APP_DIR && npm run once'"
  echo "        sudo systemctl start casenet-monitor"
  echo "   4) Health: bash $APP_DIR/scripts/healthcheck.sh"
  warn "Not starting casenet-monitor yet — config incomplete."
  exit 0
fi

ok ".env looks complete"

# ----------------------------------------------------------- start (opt) -----
if [ "${START:-0}" = "1" ]; then
  log "START=1 — verifying egress, running a single check, then starting loop"
  CC="$(curl -sS -m 8 https://api.country.is/ 2>/dev/null | jq -r .country 2>/dev/null || echo '?')"
  WANT="$(env_val VPN_COUNTRY)"; WANT="${WANT:-US}"
  echo "   egress country: $CC (want: $WANT)"
  if [ "$CC" != "$WANT" ]; then
    warn "Egress is '$CC', not '$WANT'. Bring up the VPN first (scripts/setup-vpn.sh). NOT starting."
    exit 0
  fi
  sudo -u "$RUN_USER" DISPLAY=:99 bash -lc "cd '$APP_DIR' && npm run once" || warn "single check failed — see output above / docs/TROUBLESHOOTING.md"
  systemctl restart casenet-monitor.service
  sleep 5
  systemctl --no-pager status casenet-monitor.service | head -6
else
  log "Install complete"
  echo "   Config looks complete. To start:"
  echo "     sudo -u $RUN_USER bash -lc 'cd $APP_DIR && npm run test-send'   # confirm email"
  echo "     sudo -u $RUN_USER bash -lc 'cd $APP_DIR && npm run once'        # confirm a docket read"
  echo "     sudo systemctl start casenet-monitor"
  echo "   Health: bash $APP_DIR/scripts/healthcheck.sh"
fi
