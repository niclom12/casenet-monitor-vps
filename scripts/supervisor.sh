#!/usr/bin/env bash
# casenet-monitor supervisor — idempotent "ensure everything is up & US" loop.
# Run from cron (@reboot + every few minutes). Keeps Opera GX + its Americas/US VPN
# and the monitor process alive; self-heals quietly. If US egress can't be restored,
# the monitor itself fails loudly (warning emails) on its next tick. Runs only in
# court hours; see step 0.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/casenet-tools.env"
cd "$REPO" || exit 1

LOG="$REPO/supervisor.log"
PIDFILE="$REPO/.opera-monitor.pid"
PIDFILE2="$REPO/.opera-monitor-01.pid"
PIDFILE3="$REPO/.opera-monitor-slco.pid"
PIDFILE4="$REPO/.opera-monitor-shull.pid"
RESTART_STAMP="$REPO/.opera-restart-stamp"
OPERA_RESTART_COOLDOWN=600   # min seconds between forced Opera restarts (anti-storm)
log(){ echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

# Single instance.
LOCKFILE="$REPO/.supervisor.lock"

# A tick that wedges holds this lock forever, and every later tick then exits at
# the flock below without a word, which silently disables every self-heal in this
# script. On 18 Aug 2026 an unbounded connectOverCDP inside opera-egress.mjs did
# exactly that: the supervisor stopped running for 31 hours, Opera kept answering
# its HTTP endpoints so nothing looked broken, and the monitor sat dark.
#
# Anything still holding the lock after STUCK_AFTER seconds is not working, it is
# stuck. Every process in the wedged tick's tree inherits fd 9, so fuser names the
# whole tree and killing that list clears it.
STUCK_AFTER=${SUPERVISOR_STUCK_AFTER:-600}
if [ -e "$LOCKFILE" ]; then
  for p in $(fuser "$LOCKFILE" 2>/dev/null | tr " " "\n" | sort -u); do
    [ "$p" = "$$" ] && continue
    age=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d " ")
    [ -n "$age" ] || continue
    if [ "$age" -gt "$STUCK_AFTER" ]; then
      log "WEDGED: pid $p held the lock ${age}s (limit ${STUCK_AFTER}s) -> killing it"
      kill -KILL "$p" 2>/dev/null
    fi
  done
fi

exec 9>"$LOCKFILE"
flock -n 9 || exit 0

# 0) Court hours only. Case.net is checked while Missouri courts are open
# (08:00-17:00 Central, Monday to Friday) and everything is stopped outside that:
# the four monitors and Opera. Entries filed overnight are caught by the first
# check of the next window, which alerts on them as one batch. Fewer visits also
# mean fewer Cloudflare challenges. Nic's call, 19 Oct 2026. State holidays are
# not excluded: the monitors run, find nothing new, and cost a few visits.
# Override with ACTIVE_TZ / ACTIVE_DAYS / ACTIVE_HOURS in casenet-tools.env.
ACTIVE_TZ=${ACTIVE_TZ:-America/Chicago}
ACTIVE_DAYS=${ACTIVE_DAYS:-1-5}      # ISO weekday range, 1 = Monday
ACTIVE_HOURS=${ACTIVE_HOURS:-0800-1700}  # HHMM-HHMM, end exclusive
in_active_window(){
  local now_dow now_hm d0 d1 h0 h1
  local when=(); [ -n "${1:-}" ] && when=(-d "$1")
  now_dow=$(TZ="$ACTIVE_TZ" date "${when[@]}" +%u)
  now_hm=$(TZ="$ACTIVE_TZ" date "${when[@]}" +%H%M)
  d0=${ACTIVE_DAYS%-*}; d1=${ACTIVE_DAYS#*-}; h0=${ACTIVE_HOURS%-*}; h1=${ACTIVE_HOURS#*-}
  [ "$now_dow" -ge "$d0" ] && [ "$now_dow" -le "$d1" ] || return 1
  [ $((10#$now_hm)) -ge $((10#$h0)) ] && [ $((10#$now_hm)) -lt $((10#$h1)) ]
}
# `supervisor.sh --window-test <date>` prints in/out for a date, for the tests.
if [ "${1:-}" = "--window-test" ]; then
  in_active_window "$2" && echo in || echo out
  exit 0
fi
if ! in_active_window; then
  stopped=0
  for pf in "$PIDFILE" "$PIDFILE2" "$PIDFILE3" "$PIDFILE4"; do
    pid=$(cat "$pf" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
       && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'opera-supervised'; then
      kill "$pid" 2>/dev/null && stopped=$((stopped + 1))
    fi
    rm -f "$pf"
  done
  if pgrep -f "user-data-dir=$OPERA_PROFILE" >/dev/null 2>&1; then
    pkill -TERM -f "user-data-dir=$OPERA_PROFILE" 2>/dev/null
    sleep 5
    pkill -KILL -f "user-data-dir=$OPERA_PROFILE" 2>/dev/null
    stopped=$((stopped + 1))
  fi
  [ "$stopped" -gt 0 ] && log "outside court hours ($ACTIVE_DAYS $ACTIVE_HOURS $ACTIVE_TZ): stopped $stopped process(es)"
  exit 0
fi

# 1) Need the Xvfb display (provided on boot by casenet-xvfb.service).
for _ in $(seq 1 15); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done
[ -S /tmp/.X11-unix/X99 ] || { log "FATAL X :99 absent"; exit 1; }

cdp_up(){ curl -s --max-time 4 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; }
# Egress is measured with curl, not through the browser. The supervisor runs
# inside the usvpn network namespace, so a plain request leaves by the tunnel,
# which is exactly the question being asked. The browser probe only existed
# because the old VPN lived inside Opera.
#
# It also had to go because it was causing the outage it was meant to catch. It
# loaded api.country.is, which does not answer from the Windscribe Chicago exit,
# so it read UNKNOWN on every tick (330 times, US zero times, 17-18 Sep 2026).
# The supervisor took that for a hung renderer and restarted Opera 94 times in a
# day; every restart relaunched both monitors into an immediate check, so
# Case.net was hit in back-to-back pairs every ~12 minutes instead of twice an
# hour, which is what kept tripping Cloudflare. Two endpoints, so one host
# going dark cannot do this again.
egress(){
  local c
  c=$(curl -4 -s --max-time 12 http://ip-api.com/json 2>/dev/null \
        | sed -nE 's/.*"countryCode":"([A-Z]{2})".*/\1/p' | head -1)
  [ -n "$c" ] || c=$(curl -4 -s --max-time 12 https://ifconfig.co/country-iso 2>/dev/null | tr -dc 'A-Z')
  echo "${c:-UNKNOWN}"
}

# Launch a fresh headful Opera GX under Xvfb with CDP. Waits (up to ~40s) for CDP.
launch_opera(){
  rm -f "$OPERA_PROFILE"/Singleton* 2>/dev/null
  DISPLAY=:99 nohup "$OPERA_BIN" --user-data-dir="$OPERA_PROFILE" \
    --no-first-run --no-default-browser-check --no-sandbox \
    --disable-dev-shm-usage --disable-gpu --window-size=1920,1080 --start-maximized \
    --remote-debugging-port="$CDP_PORT" about:blank >> "$REPO/opera.log" 2>&1 9>&- &
  for _ in $(seq 1 20); do sleep 2; cdp_up && break; done
}

# True if enough time has passed since the last forced restart (prevents a
# genuine, unrecoverable failure from becoming a kill/relaunch storm every tick).
restart_cooldown_ok(){
  local now last
  now=$(date +%s)
  last=$(cat "$RESTART_STAMP" 2>/dev/null || echo 0)
  [ $(( now - last )) -ge "$OPERA_RESTART_COOLDOWN" ]
}

# Kill a HUNG Opera (CDP HTTP still answers but the renderer is frozen, so it can't
# navigate) and relaunch it fresh. VPN toolbar clicks can't fix a frozen renderer.
# Also bounces the monitor so it doesn't sit in a long backoff on the dead browser;
# section 4 relaunches the monitor, which then reconnects to the new browser and,
# if it had alerted a failure, sends the "recovered" all-clear.
restart_opera(){
  date +%s > "$RESTART_STAMP"
  log "restarting Opera (kill hung browser + relaunch)"
  # Pattern is Opera-specific (only Opera carries this profile flag in its argv);
  # the supervisor + egress node procs do not, so this won't self-match.
  pkill -KILL -f "user-data-dir=$OPERA_PROFILE" 2>/dev/null
  # bounce every monitor so none sit in a long backoff pointing at the dead browser
  for pf in "$PIDFILE" "$PIDFILE2" "$PIDFILE3" "$PIDFILE4"; do
    [ -f "$pf" ] && kill "$(cat "$pf" 2>/dev/null)" 2>/dev/null
  done
  sleep 3
  launch_opera
  cdp_up && log "Opera CDP up after restart" || log "Opera CDP STILL down after restart"
}

# 2) Ensure Opera is up with CDP.
if ! cdp_up; then
  log "Opera CDP down -> launching"
  launch_opera
  cdp_up && log "Opera CDP up" || log "Opera CDP STILL down after launch"
fi

# 3) Ensure US egress. Two failure modes, healed differently:
#    (a) hung renderer  -> CDP up but egress UNKNOWN -> kill + relaunch Opera.
#    (b) wrong VPN region -> egress is a real country != US -> click Americas.
if cdp_up; then
  # Close leaked scratch tabs BEFORE anything tries to drive the browser.
  # Playwright attaches to every open target on connect, so a pile of abandoned
  # about:blank tabs is what pushed connectOverCDP past its timeout on 18 Aug.
  # Plain HTTP, no Playwright, so this cannot hang the way the thing it prevents does.
  sweep=$(timeout 60 python3 "$HERE/sweep-tabs.py" --port "$CDP_PORT" 2>&1 | tail -1)
  [ -n "$sweep" ] && log "$sweep"

  c=$(egress); log "egress=$c"

  # (a) Hung-renderer heal. Re-probe once to avoid acting on a transient blip
  #     (e.g. the country API briefly unreachable while the renderer is fine).
  if [ -z "$c" ] || [ "$c" = "UNKNOWN" ]; then
    sleep 3; c=$(egress); log "egress re-probe=$c"
  fi
  # Egress is now a network measurement, so UNKNOWN means the tunnel or the
  # internet, never a hung renderer. Restarting Opera cannot fix a network fault
  # and every restart costs two extra Case.net hits, so this only warns. A real
  # outage still surfaces: the monitors fail, and their persisted failure count
  # emails FAIL_ALERT_TO.
  if [ -z "$c" ] || [ "$c" = "UNKNOWN" ]; then
    log "WARN egress UNKNOWN (network/tunnel, not the browser) -> not restarting Opera"
  fi

  # (b) VPN region heal. Gated off since 27 Aug 2026.
  #
  # Opera GX's built-in VPN stopped establishing a tunnel on 20 Aug 2026 and
  # fails CLOSED, so "enabled" means every browser request is dropped: pages
  # time out, Opera's own gxcorner start page hangs forever, and a permanently
  # loading target blocks connectOverCDP from attaching to anything. Enabling it
  # therefore does not restore egress, it makes the browser undrivable.
  #
  # Tried and failed: clearing last_established_location, a full Opera restart,
  # a clean toggle off/on cycle, and this branch's own enable-plus-click-Americas
  # path (160+ times in the logs). The exits offered were European throughout
  # (last_established_location=FR, node h07-24-04.best.am4.osa), so this never
  # delivered the US egress it claims to be enforcing anyway.
  #
  # The monitors run with VPN_CHECK=false and do not require it. Set
  # VPN_MANAGE=true to re-enable this branch once there is a VPN worth managing.
  VPN_MANAGE=${VPN_MANAGE:-false}
  if [ "$VPN_MANAGE" != "true" ]; then
    [ "$c" = "US" ] || log "egress=$c (VPN_MANAGE=false; not touching Opera's VPN)"
  elif [ -n "$c" ] && [ "$c" != "US" ] && [ "$c" != "UNKNOWN" ]; then
    log "not US -> click Americas (attempt 1)"
    bash "$HERE/opera-click-americas.sh" >> "$LOG" 2>&1
    sleep 8; c=$(egress); log "egress after click=$c"
  fi
  if [ "$VPN_MANAGE" = "true" ] && [ -n "$c" ] && [ "$c" != "US" ] && [ "$c" != "UNKNOWN" ]; then
    log "still not US -> enable VPN toggles then click Americas (attempt 2)"
    node --import tsx "$HERE/opera-vpn-on.mjs" >> "$LOG" 2>&1
    bash "$HERE/opera-click-americas.sh" >> "$LOG" 2>&1
    sleep 8; c=$(egress); log "egress after enable+click=$c"
  fi
  [ "$c" = "US" ] && log "VPN OK (US)" || log "WARN VPN not US (monitor will alert loudly)"
fi

# 4) Ensure each monitor process is running. Use a pidfile + /proc cmdline check
#    (robust; avoids pgrep self-matching the supervisor's own command line).
#    Both dockets share this one Opera+VPN; they differ only in their env overrides.
monitor_alive(){
  local pidfile="$1"
  [ -f "$pidfile" ] || return 1
  local pid; pid=$(cat "$pidfile" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'opera-supervised'
}

# ensure_monitor <name> <pidfile> <logfile> <KEY=VAL ...env overrides>
ensure_monitor(){
  local name="$1" pidfile="$2" logfile="$3"; shift 3
  monitor_alive "$pidfile" && return 0
  log "monitor[$name] down -> starting"
  env DISPLAY=:99 CDP_PORT=9224 EXTERNAL_BROWSER=true NAV_WAIT=domcontentloaded VPN_CHECK=false "$@" \
    nohup node --import tsx src/monitor.ts --opera-supervised >> "$logfile" 2>&1 9>&- &
  echo $! > "$pidfile"
  log "monitor[$name] started pid $(cat "$pidfile")"
}

# Docket 1 — the main case (2622-CC00325); case/label/URL come from .env defaults.
ensure_monitor main "$PIDFILE" "$REPO/monitor-opera.log" \
  STATE_FILE=state-opera.json DOCKET_FILE=last-docket-opera.txt SNAPSHOTS_DIR=snapshots-opera \
  CASE_NAME='Randall King v. Monsanto (main case)' COURT_NAME='City of St. Louis Circuit Court, Missouri'

# Docket 2 — the related sub-docket (2622-CC00325-01). Same recipients/ntfy/interval
# (inherited from .env); overrides only the per-docket URL/label/files. Staggered so
# its first scrape doesn't collide with docket 1's.
ensure_monitor d01 "$PIDFILE2" "$REPO/monitor-opera-01.log" \
  TARGET_URL='https://www.courts.mo.gov/casenet/cases/newHeader.do?inputVO.caseNumber=2622-CC00325-01&inputVO.courtId=CT22&inputVO.isTicket=false#docket' \
  CASE_LABEL='2622-CC00325-01' CASE_NAME='Randall King v. Monsanto (settlement docket)' COURT_NAME='City of St. Louis Circuit Court, Missouri' \
  STATE_FILE=state-opera-01.json DOCKET_FILE=last-docket-opera-01.txt SNAPSHOTS_DIR=snapshots-opera-01 \
  START_DELAY_MS=45000

# Docket 3: St. Louis County Roundup injury case (20SL-CC03676, CT21, Judge Brian May,
# 93 plaintiffs v. Monsanto). Added 25 Sep 2026 at the client's request; in trial.
ensure_monitor slco "$PIDFILE3" "$REPO/monitor-opera-slco.log" \
  TARGET_URL='https://www.courts.mo.gov/casenet/cases/newHeader.do?inputVO.caseNumber=20SL-CC03676&inputVO.courtId=CT21&inputVO.isTicket=false#docket' \
  CASE_LABEL='20SL-CC03676' CASE_NAME='Theresa Aretino, et al. v. Monsanto Company' COURT_NAME='St. Louis County Circuit Court, Missouri' \
  STATE_FILE=state-opera-slco.json DOCKET_FILE=last-docket-opera-slco.txt SNAPSHOTS_DIR=snapshots-opera-slco \
  START_DELAY_MS=120000

# Docket 4: Shull v. Monsanto (25BA-CV04355, CT13 Boone County, Judge Jeff Harris).
# Added 25 Sep 2026 at the client's request; in final trial prep.
ensure_monitor shull "$PIDFILE4" "$REPO/monitor-opera-shull.log" \
  TARGET_URL='https://www.courts.mo.gov/casenet/cases/newHeader.do?inputVO.caseNumber=25BA-CV04355&inputVO.courtId=CT13&inputVO.isTicket=false#docket' \
  CASE_LABEL='25BA-CV04355' CASE_NAME='Marvin Shull v. Monsanto Company' COURT_NAME='Boone County Circuit Court, Missouri' \
  STATE_FILE=state-opera-shull.json DOCKET_FILE=last-docket-opera-shull.txt SNAPSHOTS_DIR=snapshots-opera-shull \
  START_DELAY_MS=300000
log "tick done"

# Keep the (cron-frequent) supervisor log bounded for indefinite running. It is not
# held open by any long-lived process, so an in-place rewrite is safe.
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 5000 ]; then
  tail -n 1500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi
