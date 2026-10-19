#!/usr/bin/env python3
"""Email Nic when the Case.net monitor stops genuinely reading the dockets.

The signal is when each King v. Monsanto docket was last *genuinely* read, taken
from the last-docket file the monitor writes. The monitor only writes that file on
a complete, successful extraction. A Cloudflare challenge, a timeout, and a partial
render all leave it untouched (the monitor's suspicious-count guard returns before
saving). So one timestamp catches every way this has actually failed:

  * the monitor process dying
  * the supervisor or the root cron that starts it dying
  * the usvpn WireGuard tunnel dropping
  * Opera wedging over CDP
  * Cloudflare challenging the browser

That breadth is the point. The failure alert inside the monitor could not fire when
the monitor was itself the broken thing, which is how King v. Monsanto went
unwatched from 20 Aug to 17 Sep 2026 without a single email.

Same two rules as wa-watchdog, for the same reasons:

  * Email only, never through the thing being watched.
  * Runs outside it: a systemd timer in the root network namespace, independent of
    the monitor, the supervisor, its cron, and the tunnel.

Content is checked as well as age, so a saved file that somehow held a block page or
a near-empty render counts as not read.

  STALE    a docket has not been genuinely read within STALE_MINUTES
  INVALID  the saved docket does not look like a docket
  OK       every docket read recently and looks real
  OFF      outside court hours, when the supervisor stops the monitors on purpose

Court hours (ACTIVE_TZ / ACTIVE_DAYS / ACTIVE_HOURS, same defaults as the
supervisor): outside them nothing is checked and nobody is emailed. Inside them a
docket's age runs from the later of its last read and that day's opening, so the
first check of a Monday does not see Friday's file as 64 hours stale, and a monitor
that never comes back up still alerts STALE_MINUTES into the window.
"""
from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import alertjson

HERE = os.path.dirname(os.path.abspath(__file__))
SAST = timezone(timedelta(hours=2))

# Text that only appears when the saved page is a block or challenge page rather
# than the docket. The last one is Case.net's own anti-scraping 403.
BLOCK_MARKERS = re.compile(
    r"just a moment|performing security verification|ray id|cf-chl|"
    r"attention required|access to any missouri judicial",
    re.IGNORECASE,
)

CASE_URL = ("https://www.courts.mo.gov/casenet/cases/newHeader.do?"
            "inputVO.caseNumber={case}&inputVO.courtId=CT22&inputVO.isTicket=false#docket")


def log(msg):
    print(f"[{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}Z] {msg}", flush=True)


# --------------------------------------------------- config, state, mail ----
# Copied from wa-watchdog rather than imported, for the reason alertjson.py gives:
# the monitors deploy independently and there is no shared import path on the box.
# Keep the two in step by hand if the mail path ever changes.

import json  # noqa: E402
import smtplib  # noqa: E402
import ssl  # noqa: E402
from email.message import EmailMessage  # noqa: E402
from email.utils import formatdate  # noqa: E402


def load_env(path):
    conf = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                conf[k.strip()] = v
    conf.update({k: v for k, v in os.environ.items()
                 if k in conf or k.startswith(("WATCHDOG_", "SMTP_", "ALERT_"))})
    return conf


def cfg(conf, key, default=None):
    return conf.get(key, default)


def cfg_int(conf, key, default):
    try:
        return int(str(conf.get(key, default)).strip())
    except (TypeError, ValueError):
        return default


def cfg_list(conf, key, default=""):
    return [x.strip() for x in str(cfg(conf, key, default) or "").split(",") if x.strip()]


def read_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"consecutive_bad": 0, "last_alert": 0, "last_state": "OK"}


def write_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, path)


# notifications@atab.ai is the data layer: notification-hub ingests it, and it is
# the only complete record of what this watchdog ever sent.
def with_always(conf, to_list):
    out = list(to_list)
    if not out:
        return out
    seen = {a.lower() for a in out}
    for addr in cfg_list(conf, "ALWAYS_ALERT_TO"):
        if addr.lower() not in seen:
            out.append(addr)
            seen.add(addr.lower())
    return out


def send_mail(conf, to_list, subject, text, alert=None):
    to_list = with_always(conf, to_list)
    if not to_list:
        log("WARN: no recipients configured; skipping send")
        return False
    msg = EmailMessage()
    msg["From"] = cfg(conf, "ALERT_FROM", "nic@atab.ai")
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    if alert:
        text = alertjson.append_block(text, **alert)
        msg["X-Lacuna-Alert"] = "1"
    msg.set_content(text)
    host = cfg(conf, "SMTP_HOST", "mail.atab.ai")
    port = cfg_int(conf, "SMTP_PORT", 587)
    user = cfg(conf, "SMTP_USER", "")
    password = cfg(conf, "SMTP_PASS", "")
    # mail.atab.ai's certificate expired 2 Mar 2026; every monitor on the box runs
    # non-strict for that reason. Set SMTP_STRICT_TLS=true once it is renewed.
    strict = str(cfg(conf, "SMTP_STRICT_TLS", "false")).lower() in ("1", "true", "yes", "on")
    ctx = ssl.create_default_context()
    if not strict:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    server = smtplib.SMTP_SSL(host, port, timeout=45, context=ctx) if port == 465 \
        else smtplib.SMTP(host, port, timeout=45)
    try:
        server.ehlo()
        if port != 465:
            server.starttls(context=ctx)
            server.ehlo()
        if user:
            server.login(user, password)
        refused = server.send_message(msg)
    finally:
        try:
            server.quit()
        except (smtplib.SMTPException, OSError):
            pass
    accepted = [r for r in to_list if r not in refused]
    log(f"mail sent: subject={subject!r} accepted={accepted} refused={list(refused)}")
    return bool(accepted)


def parse_dockets(spec):
    """'LABEL:file,LABEL:file' -> [(label, file)]. Order kept, blanks skipped."""
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        label, _, path = part.partition(":")
        out.append((label.strip(), path.strip()))
    return out


def window_open_ts(conf, now):
    """Epoch seconds the current court-hours window opened, or None when closed.

    Same rule as the supervisor's in_active_window: ISO weekdays ACTIVE_DAYS,
    local time ACTIVE_HOURS (HHMM-HHMM, end exclusive) in ACTIVE_TZ."""
    tz = ZoneInfo(cfg(conf, "ACTIVE_TZ", "America/Chicago"))
    d0, d1 = (int(x) for x in cfg(conf, "ACTIVE_DAYS", "1-5").split("-"))
    h0, h1 = cfg(conf, "ACTIVE_HOURS", "0800-1700").split("-")
    local = datetime.fromtimestamp(now, tz)
    if not d0 <= local.isoweekday() <= d1:
        return None
    opens = local.replace(hour=int(h0[:2]), minute=int(h0[2:]), second=0, microsecond=0)
    closes = local.replace(hour=int(h1[:2]), minute=int(h1[2:]), second=0, microsecond=0)
    if not opens <= local < closes:
        return None
    return opens.timestamp()


def check_docket(path, now, stale_s, min_filed, since=None):
    """(kind, detail, age_minutes_or_None), kind one of "ok", "stale", "invalid".

    Never raises: a check that throws is a check that stops watching."""
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return "invalid", "no saved docket file", None
    age_m = (now - max(mtime, since or 0)) / 60.0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as exc:
        return "invalid", f"saved docket unreadable: {exc}", age_m
    if BLOCK_MARKERS.search(text):
        return "invalid", "saved docket is a block/challenge page, not the docket", age_m
    filed = text.count("Filed By")
    if filed < min_filed:
        return "invalid", (f"saved docket looks incomplete: {filed} 'Filed By' lines, "
                           f"expected at least {min_filed}"), age_m
    if age_m > stale_s / 60.0:
        return "stale", f"not genuinely read for {int(age_m)} min (limit {stale_s // 60})", age_m
    return "ok", f"read {int(age_m)} min ago, {filed} filings", age_m


def evaluate(conf, now):
    """(state, results). results is [(label, ok, detail, age_m)].

    INVALID outranks STALE: content that is not a docket is the worse finding,
    because a stale docket is at least a real one."""
    base = cfg(conf, "CASENET_DIR", "/home/casenet/casenet-monitor")
    stale_s = cfg_int(conf, "STALE_MINUTES", 90) * 60
    min_filed = cfg_int(conf, "MIN_FILED_BY", 20)
    opened = window_open_ts(conf, now)
    if opened is None:
        return "OFF", []
    results, kinds = [], []
    for label, fname in parse_dockets(cfg(conf, "DOCKETS", "")):
        path = fname if os.path.isabs(fname) else os.path.join(base, fname)
        kind, detail, age_m = check_docket(path, now, stale_s, min_filed, since=opened)
        results.append((label, kind == "ok", detail, age_m))
        kinds.append(kind)
    if not results:
        return "INVALID", [("config", False, "DOCKETS is empty; nothing is being watched", None)]
    if all(k == "ok" for k in kinds):
        return "OK", results
    return ("INVALID" if "invalid" in kinds else "STALE"), results


def alert_body(state, results, consecutive, conf):
    now = datetime.now(SAST).strftime("%Y-%m-%d %H:%M SAST")
    base = cfg(conf, "CASENET_DIR", "/home/casenet/casenet-monitor")
    lines = [f"The Case.net monitor is not reading the King v. Monsanto docket ({state}).", "",
             f"  checked   {now}", f"  failed    {consecutive} consecutive watchdog checks", ""]
    for label, ok, detail, _ in results:
        lines.append(f"  {'ok  ' if ok else 'BAD '} {label:<18} {detail}")
    lines += [
        "",
        "Filings on a docket marked BAD are not reaching you until this is fixed.",
        "",
        "Likely causes, in the order they have actually happened:",
        "  1. Cloudflare challenging the browser",
        f"       grep -E 'extract|failed' {base}/monitor-opera-01.log | tail",
        "  2. The US tunnel is down",
        "       systemctl status usvpn",
        "       ip netns exec usvpn curl -s http://ip-api.com/json",
        "  3. The monitor or its supervisor is not running",
        "       pgrep -af 'monitor[.]ts'",
        f"       tail {base}/supervisor.log",
        "",
        "Sent by casenet-watchdog on lacuna-monitor.",
    ]
    return "\n".join(lines)


def run(conf, now=None, mailer=None):
    now = int(now if now is not None else time.time())
    threshold = cfg_int(conf, "WATCHDOG_FAIL_THRESHOLD", 2)
    throttle_h = cfg_int(conf, "WATCHDOG_REPEAT_HOURS", 6)
    state_path = cfg(conf, "WATCHDOG_STATE_FILE", os.path.join(HERE, "state.json"))
    to = cfg_list(conf, "ALERT_TO", "nic@atab.ai")
    mail = mailer or (lambda subj, body, alert=None: send_mail(conf, to, subj, body, alert))

    state, results = evaluate(conf, now)
    if state == "OFF":
        # The monitors are stopped on purpose. Leave the state alone: an alert
        # raised before the close stays open until a read in the next window.
        log("outside court hours: not checked")
        return 0
    for label, ok, detail, _ in results:
        log(f"{'OK ' if ok else 'BAD'} {label}: {detail}")
    st = read_state(state_path)
    was = st.get("last_state", "OK")
    bad_labels = [r[0] for r in results if not r[1]]

    if state == "OK":
        # One recovery email, and only if a problem was actually reported.
        if was != "OK" and st.get("alerted"):
            mail("Case.net monitor: RECOVERED",
                 "The Case.net monitor is genuinely reading the King v. Monsanto docket again.\n\n"
                 + "\n".join(f"  {l:<18} {d}" for l, _, d, _ in results)
                 + "\n\nSent by casenet-watchdog on lacuna-monitor.",
                 {"source": "casenet", "klass": "ops", "kind": "monitor_recovered",
                  "headline": "The Case.net monitor is reading the docket again",
                  "ts": now, "tier": "immediate", "entity": "King v. Monsanto",
                  "detail": {"state": "OK"}})
        st.update({"consecutive_bad": 0, "last_state": "OK", "alerted": False})
        write_state(state_path, st)
        return 0

    st["consecutive_bad"] = int(st.get("consecutive_bad", 0)) + 1
    st["last_state"] = state
    consecutive = st["consecutive_bad"]

    # One bad check can be a file mid-write; two in a row is real.
    if consecutive < threshold:
        log(f"below threshold ({consecutive}/{threshold}), not alerting yet")
        write_state(state_path, st)
        return 1

    since_last = now - int(st.get("last_alert", 0) or 0)
    if st.get("alerted") and since_last < throttle_h * 3600:
        log(f"already alerted {since_last // 60}m ago, throttled")
        write_state(state_path, st)
        return 1

    first = bad_labels[0] if bad_labels else "King v. Monsanto"
    mail(f"Case.net monitor: NOT READING DOCKET ({', '.join(bad_labels) or state})",
         alert_body(state, results, consecutive, conf),
         {"source": "casenet", "klass": "ops",
          "kind": "monitor_stale" if state == "STALE" else "monitor_invalid",
          "headline": f"Case.net monitor is not reading {', '.join(bad_labels)} ({state})",
          "ts": now, "tier": "immediate", "entity": "King v. Monsanto",
          "case_id": first, "url": CASE_URL.format(case=first),
          "detail": {"state": state, "bad": bad_labels, "consecutive_bad": consecutive}})
    st["last_alert"] = now
    st["alerted"] = True
    write_state(state_path, st)
    return 1


def main():
    conf = load_env(os.path.join(HERE, ".env"))
    sys.exit(run(conf))


if __name__ == "__main__":
    main()
