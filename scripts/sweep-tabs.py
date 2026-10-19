#!/usr/bin/env python3
"""Close leaked browser tabs before they make the browser undrivable.

Playwright's connectOverCDP attaches to every open target when it connects, so
the handshake gets slower as tabs pile up. On 18 Aug 2026 Opera had reached 117
abandoned about:blank tabs, connectOverCDP passed the 30s timeout, and the
monitor went dark for 31 hours. Tabs leak whenever a run is killed or hangs
between newPage() and close(), and Opera restores them on the next launch, so
restarting the browser does not clear them.

This deliberately uses the plain CDP HTTP endpoints rather than Playwright.
connectOverCDP is the call that hangs once tabs pile up, so the thing that
prevents the pile-up must not depend on it.

    sweep-tabs.py [--port 9224] [--keep 1] [--max 4] [--dry-run]

The threshold is deliberately low. 25 was chosen from the 117-tab incident and
was far too generous: the handshake degrades within a handful of privileged
targets, so the sweep has to keep the count near zero rather than catch a pile.

Exits non-zero only if the browser could not be reached at all.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

# Targets safe to close: scratch pages nothing is waiting on.
#
# The settings pages matter as much as the blank ones. opera-vpn-on.mjs and
# opera-click-americas.sh leave chrome://settings and opera://settings tabs
# behind, and those are privileged targets: connectOverCDP stalls attaching to
# them long before the raw page count looks alarming. On 27 Aug 2026 the browser
# was undrivable at 31 targets while the sweeper reported "under the 25
# threshold; nothing to do", and sweeping them by hand took connectOverCDP from
# a 150s timeout to 0.2s.
DISPOSABLE_URLS = ("about:blank", "", "chrome://startpage/")
DISPOSABLE_SUBSTRINGS = (
    "casenet/error/error.do",
    "chrome://settings",
    "opera://settings",
    "api.country.is",
    "gxcorner.games",
)


def api(port, path, timeout=10):
    url = "http://127.0.0.1:%d%s" % (port, path)
    return urllib.request.urlopen(url, timeout=timeout).read().decode("utf-8", "replace")


def disposable(target):
    if target.get("type") != "page":
        return False
    url = (target.get("url") or "").strip()
    if url in DISPOSABLE_URLS:
        return True
    return any(s in url for s in DISPOSABLE_SUBSTRINGS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9224)
    ap.add_argument("--keep", type=int, default=1,
                    help="blank tabs to leave behind; closing every page can exit the browser")
    ap.add_argument("--max", type=int, default=4,
                    help="only sweep once the page count exceeds this")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        targets = json.loads(api(args.port, "/json/list", timeout=15))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print("sweep-tabs: cannot reach CDP on %d: %s" % (args.port, exc), file=sys.stderr)
        return 1

    pages = [t for t in targets if t.get("type") == "page"]
    doomed = [t for t in targets if disposable(t)][args.keep:]

    # Sweep on every tick, not only once a pile has built up. The count threshold
    # was the whole reason this never ran: connectOverCDP blocks on a SINGLE page
    # that is still loading, so the browser was undrivable at seven targets while
    # this printed "under the 25 threshold; nothing to do". --max is kept as a
    # floor for how many pages may remain untouched, not as a gate on running.
    if not doomed:
        print("sweep-tabs: %d targets, %d pages, nothing disposable"
              % (len(targets), len(pages)))
        return 0
    if args.dry_run:
        print("sweep-tabs: would close %d of %d pages" % (len(doomed), len(pages)))
        return 0

    closed = failed = 0
    for t in doomed:
        try:
            api(args.port, "/json/close/" + t["id"], timeout=10)
            closed += 1
        except (urllib.error.URLError, OSError):
            failed += 1

    print("sweep-tabs: %d targets (%d pages) -> closed %d, failed %d"
          % (len(targets), len(pages), closed, failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
