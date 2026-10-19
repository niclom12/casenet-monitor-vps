// Print Opera's egress country (as seen THROUGH Opera's VPN) to stdout, e.g. "US".
// Prints "UNKNOWN" on any error. Used by supervisor.sh to decide VPN health.
//
// Every step is bounded. This script is called from the supervisor while it holds
// the single-instance lock, so if it blocks, the supervisor blocks, and every
// later tick exits at flock without healing anything. On 18 Aug 2026 an unbounded
// connectOverCDP here wedged the supervisor for 31 hours while the monitor sat
// dark: the browser's HTTP endpoints still answered, so nothing looked wrong.
//
// Two rules come out of the 20-27 Aug 2026 outage, and both are load-bearing.
//
// 1. ATTACH BEFORE OPENING ANYTHING. connectOverCDP attaches to every target that
//    exists when it runs, and a page still stuck loading never finishes attaching,
//    so the connect call blocks. Opening the probe tab first therefore guarantees
//    the hang whenever the network is down, which is exactly when this probe runs.
//
// 2. NEVER LEAVE THE TAB BEHIND. The old guard called process.exit(0), which skips
//    pending `finally` blocks, so each slow probe stranded a loading tab. At one
//    probe every three minutes those tabs accumulated until connectOverCDP could
//    not attach to anything, and the monitor was dark for seven days. The target id
//    is captured the moment the tab is opened so any exit path can close it with a
//    blocking call, including the guard, which cannot await.
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const CDP = process.env.CDP_PORT || '9224';
const HARD_TIMEOUT_MS = Number(process.env.EGRESS_HARD_TIMEOUT_MS || 45000);
const PROBE_URL = 'https://api.country.is/';

let targetId = null;

// Blocking, because the guard runs on the way to process.exit and cannot await.
function closeTargetSync() {
  if (!targetId) return;
  const id = targetId;
  targetId = null;
  try {
    execFileSync('curl', ['-sS', '--max-time', '5',
                          `http://127.0.0.1:${CDP}/json/close/${id}`],
                 { stdio: 'ignore' });
  } catch { /* the browser is gone, which closes the tab for us */ }
}

const guard = setTimeout(() => {
  closeTargetSync();
  console.log('UNKNOWN');
  process.exit(0);
}, HARD_TIMEOUT_MS);

// Belt and braces: any other way out of this process still closes the tab.
process.on('exit', closeTargetSync);

let out = 'UNKNOWN';
try {
  // 1. Attach FIRST, while the target list is quiet. See rule 1 above.
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`, { timeout: 15000 });
  try {
    const ctx = b.contexts()[0];

    // 2. Open the probe tab through the CDP HTTP API rather than newPage(), so its
    //    id is known before it can hang and cleanup never depends on Playwright.
    const made = await fetch(
      `http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(PROBE_URL)}`,
      { method: 'PUT', signal: AbortSignal.timeout(10000) });
    targetId = (await made.json()).id;

    // 3. Find the page Playwright now sees for that target, then read it.
    let p = null;
    for (let i = 0; i < 20 && !p; i++) {
      p = (ctx?.pages() || []).find((pg) => pg.url().includes('api.country.is'));
      if (!p) await new Promise((r) => setTimeout(r, 250));
    }
    if (p) {
      await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      const txt = await p.evaluate(() => document.body.innerText).catch(() => '');
      const m = String(txt).match(/"country"\s*:\s*"([A-Z]{2})"/);
      if (m) out = m[1];
    }
  } finally {
    closeTargetSync();
    await b.close().catch(() => {});
  }
} catch { /* leave UNKNOWN */ }

closeTargetSync();
clearTimeout(guard);
console.log(out);
