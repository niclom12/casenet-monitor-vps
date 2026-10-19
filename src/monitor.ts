import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright-core';
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Agent, setGlobalDispatcher } from 'undici';

// Force IPv4 for all fetch() calls. Through a VPN tunnel, undici's default
// happy-eyeballs tries the IPv6 address first and can stall (ntfy + the country
// check silently time out). IPv4-only makes phone push and the VPN-country guard
// reliable. Does not affect Playwright's localhost CDP socket.
setGlobalDispatcher(
  new Agent({ connect: { family: 4 } } as ConstructorParameters<typeof Agent>[0]),
);

const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
};

// --------------------------------------------------------------- config -----
const TARGET_URL = env('TARGET_URL');
const CASE_LABEL = env('CASE_LABEL', 'CASE');
const CASE_NAME = env('CASE_NAME', CASE_LABEL);
// Which court, in words a reader outside the desk recognises. Printed at the top of
// every case alert: the client could not tell which case an alert was about (27 Sep 2026).
const COURT_NAME = env('COURT_NAME', 'Missouri circuit court');
// An edit to an entry older than this goes to FAIL_ALERT_TO (Nic) only. Clerks
// re-render months-old entries; a client does not need an email for that.
const OLD_UPDATE_DAYS = Number(env('OLD_UPDATE_DAYS', '14'));

/** The three lines that open every case alert, so the case is never ambiguous. */
function caseHeader(): string[] {
  return [`Case:        ${CASE_NAME}`, `Court:       ${COURT_NAME}`, `Case number: ${CASE_LABEL}`, ``];
}
const CASENET_LANDING = env(
  'CASENET_LANDING',
  'https://www.courts.mo.gov/casenet/cases/searchCases.do',
);
const DOCKET_SELECTOR = env('DOCKET_SELECTOR', '#actualDocketData');
const CDP_PORT = env('CDP_PORT', '9222');

const INTERVAL_MS = Number(env('INTERVAL_MS', '1800000'));
const JITTER_PCT = Math.max(0, Math.min(100, Number(env('JITTER_PCT', '25'))));
// Slower overnight. Between 18 and 21 Sep 2026 a third of the checks made between
// 00:00 and 07:00 UTC (US evening/night) failed on Cloudflare challenges or slow
// docket AJAX, against a tenth during the US day. Fewer visits in that window
// means fewer challenges and fewer failure emails; the court is not filing then.
const NIGHT_INTERVAL_MS = Number(env('NIGHT_INTERVAL_MS', String(INTERVAL_MS)));
const NIGHT_UTC_HOURS = env('NIGHT_UTC_HOURS', '0-7'); // "start-end", end exclusive
// One retry inside a check. Every failure seen so far cleared on the next visit,
// so a reload after a short pause turns a 30-minute gap into a one-minute one.
const CHECK_RETRIES = Number(env('CHECK_RETRIES', '1'));
const RETRY_PAUSE_MS = Number(env('RETRY_PAUSE_MS', '60000'));
// Where a failed attempt leaves its screenshot and HTML, so the next diagnosis
// has something to look at. Bounded; oldest are removed.
const FAILURES_DIR = env('FAILURES_DIR', 'failures');
const FAILURES_KEEP = Number(env('FAILURES_KEEP', '20'));

const STATE_FILE = env('STATE_FILE', 'state.json');
const SNAPSHOTS_DIR = env('SNAPSHOTS_DIR', 'snapshots');
const DOCKET_FILE = env('DOCKET_FILE', 'last-docket.txt');

// Self-healing browser (relaunched automatically if CDP is unreachable).
// On a VPS this is headful Chromium/Chrome running under an Xvfb virtual display.
const BROWSER_BIN = env('BROWSER_BIN', '/usr/bin/google-chrome');
const BROWSER_PROFILE = env('BROWSER_PROFILE', `${process.env.HOME}/.casenet-browser-profile`);
const BROWSER_EXTRA_FLAGS = process.env.BROWSER_EXTRA_FLAGS ?? '';
const DISPLAY = env('DISPLAY', ':99');

// When true, the monitor does NOT launch/own the browser — it only attaches to an
// already-running CDP endpoint (e.g. Opera GX under Xvfb, kept alive + VPN-pinned by
// the external supervisor). If that CDP is down, we fail loudly and let the supervisor
// relaunch it, rather than spawning a non-VPN Chrome.
const EXTERNAL_BROWSER = env('EXTERNAL_BROWSER', 'false') === 'true';
// Playwright navigation wait condition. CaseNet behind Cloudflare often never reaches
// 'networkidle' (60s timeouts), so the Opera path uses 'domcontentloaded'.
const NAV_WAIT = env('NAV_WAIT', 'networkidle') as 'load' | 'domcontentloaded' | 'networkidle';

// VPN guard — pause + alert if egress country is not VPN_COUNTRY.
const VPN_CHECK = env('VPN_CHECK', 'true') !== 'false';
const VPN_COUNTRY = env('VPN_COUNTRY', 'US');

// Phone push (ntfy).
const NTFY_URL = env('NTFY_URL', 'https://ntfy.sh');
const NTFY_TOPIC = process.env.NTFY_TOPIC && process.env.NTFY_TOPIC.length > 0 ? process.env.NTFY_TOPIC : undefined;

// Heartbeat push every N hours so silence is never ambiguous.
const HEARTBEAT_HOURS = Number(env('HEARTBEAT_HOURS', '24'));

// Failure alerting — tell us when the docket can't be reached at all.
const FAIL_ALERT_THRESHOLD = Number(env('FAIL_ALERT_THRESHOLD', '2'));
const FAIL_REALERT_HOURS = Number(env('FAIL_REALERT_HOURS', '12'));

// Optional one-time delay before the first check. Used to stagger multiple monitor
// instances that share one browser so their first scrapes don't hit Cloudflare at
// the same instant (after the first check, per-check jitter keeps them desynced).
const START_DELAY_MS = Number(env('START_DELAY_MS', '0'));

const ONCE = process.argv.includes('--once');
// One hour, not four. Case.net's 403 is rate limiting that clears in about a
// minute, so the old ceiling punished a transient refusal with a whole day of
// silence on a docket that is checked every thirty minutes.
const MAX_BACKOFF_MS = 60 * 60 * 1000;
let consecutiveFailures = 0;

/** Raise the failure count and write it through, so a restart cannot lose it. */
async function bumpFailures(): Promise<void> {
  consecutiveFailures++;
  try {
    const st = await loadState();
    await saveState({ ...st, consecutiveFailures });
  } catch (e) {
    console.error("[fail-count] could not persist:", e instanceof Error ? e.message : e);
  }
}

/** Clear it on a good check, in memory and in the state that gets written. */
function clearFailures(state: State): State {
  consecutiveFailures = 0;
  return { ...state, consecutiveFailures: 0 };
}

// ---------------------------------------------------------------- email -----
function getTransporter() {
  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT', '587'));
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    // NOTE: some mail hosts use a self-signed / hostname-mismatched cert. If yours
    // has a valid public cert, set SMTP_STRICT_TLS=true to enforce verification.
    tls: { rejectUnauthorized: env('SMTP_STRICT_TLS', 'false') === 'true' },
  });
}

// Case/docket alerts go to the full recipient list (ALERT_TO).
function getAlertAddresses() {
  return {
    from: env('ALERT_FROM', process.env.SMTP_USER ?? ''),
    to: env('ALERT_TO'),
  };
}

// Operational failure/recovery alerts go to a separate, usually narrower list
// (FAIL_ALERT_TO) so monitor-health noise doesn't reach case-only recipients.
// Falls back to ALERT_TO if FAIL_ALERT_TO is not set.
function getFailAlertAddresses() {
  return {
    from: env('ALERT_FROM', process.env.SMTP_USER ?? ''),
    to: env('FAIL_ALERT_TO', env('ALERT_TO')),
  };
}

// Used ONLY by the failure ("CANNOT REACH DOCKET") and recovery alerts — routed
// to FAIL_ALERT_TO. Case docket-entry alerts use sendAlert() / ALERT_TO instead.
async function sendEmail(subject: string, text: string): Promise<void> {
  const { from, to } = getFailAlertAddresses();
  try {
    await getTransporter().sendMail({ from, to, subject, text });
    console.log(`[email] sent (failure-list -> ${to})`);
  } catch (e) {
    console.error('[email] failed:', e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------- ntfy ------
async function notify(
  title: string,
  body: string,
  opts: { priority?: string; tags?: string; click?: string } = {},
): Promise<void> {
  if (!NTFY_TOPIC) return;
  const headers: Record<string, string> = {
    // Title/Tags must be ASCII-safe for ntfy headers.
    Title: title.replace(/[^\x20-\x7E]/g, ' '),
  };
  if (opts.priority) headers.Priority = opts.priority;
  if (opts.tags) headers.Tags = opts.tags;
  if (opts.click) headers.Click = opts.click;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });
      console.log(`[ntfy] push sent${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      console.error(`[ntfy] attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  console.error('[ntfy] giving up after 3 attempts');
}

// --------------------------------------------------------------- state ------
type State = {
  lastHash?: string;
  lastChange?: string;
  baselineAt?: string;
  lastHeartbeatAt?: string;
  failAlertSent?: boolean;
  lastFailAlertAt?: string;
  // Persisted, because the supervisor restarts this process roughly every twelve
  // minutes and the checks are thirty minutes apart. Held only in memory, the
  // counter was reset to zero before it could ever reach FAIL_ALERT_THRESHOLD,
  // so the docket went unread from 20 to 27 Aug 2026 without a single alert. The
  // self-heal was silencing the alarm it was meant to trigger.
  consecutiveFailures?: number;
  // Per-entry identity tracking: enotice id -> content hash. This, not lastHash,
  // is the source of truth for "what's new" — it is date/position independent, so
  // a backdated entry inserted mid-list is still detected. See docs/ARCHITECTURE.
  knownEntries?: Record<string, string>;
  // Changed entry hashes seen once and not yet confirmed. An update alerts only
  // when the same new content is seen on two consecutive reads: on 27 Sep 2026
  // Case.net showed a January entry with a different hearing time for 25 minutes
  // and then reverted, which sent the client two UPDATE emails for nothing.
  pendingUpdates?: Record<string, string>;
  entriesBaselineAt?: string;
};

// One docket entry, keyed by its stable per-row `btnEnotice{N}` id.
type Entry = { id: string; date: string; text: string };

/** Stable fingerprint of an entry's content. Changes iff the entry's visible text
 *  (or its date) changes — that is what flags an "updated" entry. */
function entryHash(e: Entry): string {
  return createHash('sha256').update(`${e.date}\n${e.text}`).digest('hex').slice(0, 16);
}

// If a single check turns up more than this many changes it's almost certainly a
// re-baseline / parse glitch, not a real burst of filings — send ONE summary
// instead of spamming this many phone pushes.
const MAX_INDIVIDUAL_ALERTS = 10;

async function loadState(): Promise<State> {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State;
}
// The supervisor stops every monitor outside court hours, so a monitor can be
// killed at any moment. Write to a temp file and rename over the old one: a kill
// mid-write leaves the previous file whole, never a truncated one that fails to
// parse (or, worse, an empty knownEntries that re-baselines silently).
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}
async function saveState(s: State): Promise<void> {
  await writeAtomic(STATE_FILE, JSON.stringify(s, null, 2));
}
async function loadLastDocket(): Promise<string> {
  if (!existsSync(DOCKET_FILE)) return '';
  return readFile(DOCKET_FILE, 'utf8');
}
async function saveLastDocket(text: string): Promise<void> {
  await writeAtomic(DOCKET_FILE, text);
}

// ------------------------------------------------ self-healing browser ------
async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function launchBrowser(): void {
  // Headful Chromium under the configured (Xvfb) display. NOT headless — a real
  // headful fingerprint is what gets past Cloudflare's managed challenge.
  const flags = [
    `--user-data-dir="${BROWSER_PROFILE}"`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-features=Translate,site-per-process',
    '--window-size=1920,1080',
    `--remote-debugging-port=${CDP_PORT}`,
    BROWSER_EXTRA_FLAGS,
    'about:blank',
  ].join(' ');
  const sh = `rm -f "${BROWSER_PROFILE}"/Singleton* 2>/dev/null; exec "${BROWSER_BIN}" ${flags}`;
  const child = spawn('bash', ['-c', sh], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DISPLAY },
  });
  child.unref();
}

async function ensureBrowser(): Promise<void> {
  if (await cdpAlive()) return;
  if (EXTERNAL_BROWSER) {
    // Don't spawn our own Chrome — the supervisor owns the (VPN-pinned) Opera browser.
    throw new Error(
      `External browser CDP unreachable on port ${CDP_PORT} — supervisor must relaunch Opera+VPN`,
    );
  }
  console.log('[heal] browser CDP unreachable — relaunching...');
  await notify('casenet-monitor: restarting browser', 'Browser CDP was down; auto-relaunching.', {
    priority: 'low',
    tags: 'wrench',
  });
  launchBrowser();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await cdpAlive()) {
      console.log(`[heal] browser back up after ${(i + 1) * 2}s`);
      await new Promise((r) => setTimeout(r, 3000)); // settle
      return;
    }
  }
  throw new Error('Browser relaunch failed — CDP still down after 50s');
}

// -------------------------------------------------------------- VPN guard ---
async function egressCountry(): Promise<string | null> {
  try {
    const res = await fetch('https://api.country.is/', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { country?: string };
    return j.country ?? null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- fetch ------
async function getCdpEndpoint(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  if (!res.ok) throw new Error(`CDP not reachable on port ${CDP_PORT}`);
  const info = (await res.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}

/** Read the docket as a list of individually-identified entries straight from the
 *  rendered DOM. CaseNet renders the docket as `<table id="dockets">` whose <tbody>
 *  alternates `tr.dateSeparator` (a date header) with entry rows; every entry row
 *  carries exactly one `id="btnEnotice{N}"` — a stable per-entry key that also
 *  covers doc-less court memos (unlike docketSeq/parentDocId). Returns null if the
 *  table/shape isn't found, so the caller can fall back to the text diff. */
async function extractEntries(page: import('playwright-core').Page): Promise<Entry[] | null> {
  try {
    const raw = await page.evaluate(() => {
      const table = document.querySelector('table#dockets');
      if (!table) return null;
      const DATE_RE = /(\d{2}\/\d{2}\/\d{4})/;
      const out: Array<{ id: string; date: string; text: string }> = [];
      let currentDate = '';
      for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
        const el = tr as HTMLElement;
        const rowText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (el.classList.contains('dateSeparator')) {
          const m = rowText.match(DATE_RE);
          if (m) currentDate = m[1];
          continue;
        }
        if (!rowText) continue;
        const btn = el.querySelector('[id^="btnEnotice"]');
        const id = btn
          ? (btn as HTMLElement).id.replace(/^btnEnotice/, '')
          : `noid:${currentDate}:${rowText.slice(0, 60)}`;
        out.push({ id, date: currentDate, text: rowText });
      }
      return out;
    });
    if (!raw || !Array.isArray(raw)) return null;
    return raw as Entry[];
  } catch (e) {
    console.error('[extract] entry extraction failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

type Snapshot = {
  hash: string;
  docketText: string;
  fullHtml: string;
  entries: Entry[] | null;
};

/** Keep a screenshot and the HTML of a failed attempt under FAILURES_DIR. */
async function dumpFailure(page: Page, attempt: number, err: unknown): Promise<void> {
  try {
    await mkdir(FAILURES_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(FAILURES_DIR, `${stamp}_${CASE_LABEL}_try${attempt}`);
    const msg = err instanceof Error ? err.message : String(err);
    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(`${base}.html`, `<!-- ${page.url()} | ${msg} -->\n${html}`);
    console.log(`[failure-dump] ${base}.{png,html}`);
    // prune: keep the newest FAILURES_KEEP pairs for this docket
    const mine = (await readdir(FAILURES_DIR))
      .filter((f) => f.includes(`_${CASE_LABEL}_`))
      .sort();
    const pairs = Math.floor(mine.length / 2);
    for (const f of mine.slice(0, Math.max(0, (pairs - FAILURES_KEEP) * 2))) {
      await unlink(join(FAILURES_DIR, f)).catch(() => {});
    }
  } catch (e) {
    console.error('[failure-dump] could not write:', e instanceof Error ? e.message : e);
  }
}

async function fetchSnapshot(): Promise<Snapshot> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CHECK_RETRIES + 1; attempt++) {
    try {
      return await fetchSnapshotOnce(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt > CHECK_RETRIES) break;
      console.log(
        `[check] attempt ${attempt} failed (${e instanceof Error ? e.message : e}); retrying in ${Math.round(RETRY_PAUSE_MS / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
  }
  throw lastErr;
}

async function fetchSnapshotOnce(attempt: number): Promise<Snapshot> {
  const cdpUrl = await getCdpEndpoint();
  console.log(`[cdp] ${cdpUrl.slice(0, 60)}...`);
  const browser: Browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();

  try {
    // Best effort only. The landing page exists to look like a human arriving,
    // not to gate the read. Case.net serves it a 403 while still serving the case
    // page a 200 (verified 17 Sep 2026 from a US exit), so treating a blocked
    // landing as fatal stopped the monitor before it reached the docket it wants.
    await page.goto(CASENET_LANDING, { waitUntil: NAV_WAIT, timeout: 60_000 }).catch(() => {});
    const landingTitle = await page.title().catch(() => '');
    if (/just a moment|attention required|error/i.test(landingTitle)) {
      console.log(`[check] landing page blocked ("${landingTitle}") — continuing to the case page`);
    }

    await page.waitForTimeout(1000 + Math.random() * 2000);

    await page.goto(TARGET_URL, { waitUntil: NAV_WAIT, timeout: 60_000 });

    // Cloudflare's "Just a moment..." interstitial is a JS challenge that clears
    // itself after a few seconds and then lands on the real page. Reading the
    // title the instant navigation resolves catches the challenge rather than the
    // answer, so a page that would have loaded fine was being recorded as a block.
    let caseTitle = await page.title();
    if (/just a moment|checking your browser/i.test(caseTitle)) {
      console.log(`[check] Cloudflare interstitial — waiting for it to clear`);
      await page
        .waitForFunction(
          () => !/just a moment|checking your browser/i.test(document.title),
          null,
          { timeout: 30_000 },
        )
        .catch(() => {});
      caseTitle = await page.title();
      console.log(`[check] after interstitial: "${caseTitle}"`);
    }

    if (/just a moment|attention required|error|520/i.test(caseTitle)) {
      throw new Error(`Blocked at case page (Cloudflare?): "${caseTitle}"`);
    }

    const docketTab = page.locator('a', { hasText: 'Docket Entries' });
    if ((await docketTab.count()) > 0) {
      await docketTab.first().click();
    }
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el !== null && el.offsetParent !== null && el.innerText.trim().length > 0;
      },
      DOCKET_SELECTOR,
      // 60s, not 30s. The docket arrives by AJAX after the tab click, and through
      // the US tunnel the round trip plus Cloudflare's check regularly pushes that
      // past thirty seconds. A hand-run read that timed out at 30s returned all
      // 135 entries at 45s on 17 Sep 2026.
      { timeout: 60_000 },
    );
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    const fullHtml = await page.content();
    const docketText = await page.locator(DOCKET_SELECTOR).innerText();
    const hash = createHash('sha256').update(docketText).digest('hex');
    const entries = await extractEntries(page);
    console.log(
      `[extract] ${entries ? `${entries.length} entries` : 'FAILED (table#dockets not found) — will use text fallback'}`,
    );
    return { hash, docketText, fullHtml, entries };
  } catch (e) {
    await dumpFailure(page, attempt, e);
    throw e;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {}); // disconnect CDP only; leaves the browser running
  }
}

// ------------------------------------------------------ docket diff ---------
const DATE_LINE = /^\d{2}\/\d{2}\/\d{4}$/;

/** Split docket text into date-labelled blocks, newest first. Lines before the
 *  first date (the "Sort by date / Display options" UI chrome) are dropped. */
function parseDocketByDate(text: string): Array<{ date: string; lines: string[] }> {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const blocks: Array<{ date: string; lines: string[] }> = [];
  let cur: { date: string; lines: string[] } | null = null;
  for (const l of lines) {
    if (DATE_LINE.test(l)) {
      cur = { date: l, lines: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(l);
    }
    // lines before the first date header are UI chrome — ignore.
  }
  return blocks;
}

/** Count-aware ("multiset") difference: return the lines that appear MORE times
 *  in `next` than in `prev`, preserving order. Unlike a plain set difference this
 *  keeps a genuinely new entry even when its label (e.g. "Note to Clerk eFiling")
 *  already occurs elsewhere in the docket. */
function newLinesInBlock(prev: string[], next: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const l of prev) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of next) {
    const c = remaining.get(l) ?? 0;
    if (c > 0) remaining.set(l, c - 1);
    else out.push(l);
  }
  return out;
}

/** Diff the docket by date. Each date is compared independently, so an in-place
 *  change under one date (e.g. a hearing flipped to "Cancelled") never masks new
 *  entries under another date. Returns the new lines, grouped under their date. */
function extractNewEntries(oldText: string, newText: string): string {
  const oldByDate = new Map<string, string[]>();
  for (const b of parseDocketByDate(oldText)) {
    // if a date appears twice, concatenate so counts stay correct.
    oldByDate.set(b.date, (oldByDate.get(b.date) ?? []).concat(b.lines));
  }
  const seenDate = new Set<string>();
  const sections: string[] = [];
  for (const b of parseDocketByDate(newText)) {
    if (seenDate.has(b.date)) continue; // fold duplicate date headers into the first
    seenDate.add(b.date);
    const newBlock = parseDocketByDate(newText)
      .filter((x) => x.date === b.date)
      .flatMap((x) => x.lines);
    const fresh = newLinesInBlock(oldByDate.get(b.date) ?? [], newBlock);
    if (fresh.length) sections.push(`${b.date}\n${fresh.join('\n')}`);
  }
  return sections.join('\n');
}

async function saveSnapshot(html: string, hash: string): Promise<string> {
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(SNAPSHOTS_DIR, `${stamp}_${hash.slice(0, 8)}.html`);
  await writeFile(path, html);
  return path;
}

async function sendAlert(
  newEntries: string,
  prevHash: string,
  newHash: string,
  snapshotPath: string,
): Promise<void> {
  const detectedAt = new Date().toISOString();
  const commentary = newEntries.trim() || '(could not isolate new lines — see snapshot)';

  // Email — case/docket alert goes to the full ALERT_TO list.
  const { from, to } = getAlertAddresses();
  const body = [
    ...caseHeader(),
    `New filing(s) detected on the docket.`,
    ``,
    `========== NEW DOCKET CONTENT ==========`,
    commentary,
    `========================================`,
    ``,
    `Case URL:    ${TARGET_URL}`,
    `Detected at: ${detectedAt}`,
    `Snapshot:    ${snapshotPath}`,
    `Hash:        ${prevHash.slice(0, 8)} -> ${newHash.slice(0, 8)}`,
  ].join('\n');

  try {
    await getTransporter().sendMail({
      from,
      to,
      subject: `${CASE_NAME}: new docket entry (${COURT_NAME}, ${CASE_LABEL})`,
      text: body,
    });
    console.log(`[alert] email sent (case-list -> ${to})`);
  } catch (e) {
    console.error('[alert] email failed:', e instanceof Error ? e.message : e);
  }

  const pushBody = commentary.length > 1200 ? commentary.slice(0, 1200) + '\n…(truncated, see email)' : commentary;
  await notify(`New docket entry: ${CASE_LABEL}`, pushBody, {
    priority: 'high',
    tags: 'rotating_light,page_facing_up',
    click: TARGET_URL,
  });
}

/** Explain why a batch is large, from state rather than guesswork. A real
 *  re-baseline leaves knownEntries empty or nearly so; a clerk entering a
 *  bundle of filings does not. Getting this wrong once cost a day of chasing. */
function summaryReason(total: number, knownCount: number): string {
  if (knownCount < 5) {
    return `(First run or re-baseline: only ${knownCount} entries were on record, so everything reads as new. Summary sent instead of ${total} individual alerts.)`;
  }
  return `(Genuine batch, not a re-baseline: ${knownCount} entries were already on record. The court published these together. Summary sent instead of ${total} individual alerts.)`;
}

/** One email + one push per check: a single entry in the usual format, several
 *  entries listed in one message, and an implausibly large count as a summary. */
async function alertEntries(fresh: Entry[], updated: Entry[], snapshotPath: string, knownCount: number): Promise<void> {
  const total = fresh.length + updated.length;
  const detectedAt = new Date().toISOString();
  const { from, to } = getAlertAddresses();

  if (total > MAX_INDIVIDUAL_ALERTS) {
    const body = [
      ...caseHeader(),
      `${total} docket changes: ${fresh.length} new, ${updated.length} updated.`,
      summaryReason(total, knownCount),
      ``,
      ...fresh.map((e) => `NEW      ${e.date}  ${e.text.slice(0, 140)}`),
      ...updated.map((e) => `UPDATED  ${e.date}  ${e.text.slice(0, 140)}`),
      ``,
      `Case URL: ${TARGET_URL}`,
      `Snapshot: ${snapshotPath}`,
      `Detected: ${detectedAt}`,
    ].join('\n');
    try {
      await getTransporter().sendMail({
        from,
        to,
        subject: `${CASE_NAME}: ${total} docket changes (${COURT_NAME}, ${CASE_LABEL})`,
        text: body,
      });
      console.log(`[alert] summary email sent (${total} changes -> ${to})`);
    } catch (e) {
      console.error('[alert] summary email failed:', e instanceof Error ? e.message : e);
    }
    await notify(
      `${total} docket changes: ${CASE_LABEL}`,
      `${fresh.length} new, ${updated.length} updated. See email / snapshot.`,
      { priority: 'high', tags: 'rotating_light', click: TARGET_URL },
    );
    console.warn(`[alert] ${total} changes exceeded cap ${MAX_INDIVIDUAL_ALERTS}; sent one summary`);
    return;
  }

  const items = [
    ...fresh.map((e) => ({ kind: 'NEW' as const, e })),
    ...updated.map((e) => ({ kind: 'UPDATED' as const, e })),
  ];
  // One email and one push per case per check (Nic, 19 Oct 2026). A clerk who
  // posts a weekend's filings at Monday's opening produced 10 separate emails
  // and 10 pushes on 20SL-CC03676 in one morning; the reader wants one message
  // listing everything that landed, in full.
  if (items.length > 1) {
    const subject = fresh.length && updated.length
      ? `${fresh.length} new, ${updated.length} updated docket entries`
      : `${items.length} ${fresh.length ? 'new' : 'updated'} docket entries`;
    const body = [
      ...caseHeader(),
      `${subject}:`,
      ``,
      ...items.flatMap(({ kind, e }, i) => [
        `${i + 1}. ${kind === 'NEW' ? 'New' : 'Updated'}, dated ${e.date}:`,
        `   ${e.text}`,
        ``,
      ]),
      `Docket: ${TARGET_URL}`,
      `Detected: ${detectedAt}`,
    ].join('\n');
    try {
      await getTransporter().sendMail({
        from,
        to,
        subject: `${CASE_NAME}: ${subject} (${COURT_NAME}, ${CASE_LABEL})`,
        text: body,
      });
      console.log(`[alert] combined email sent (${items.map((x) => x.e.id).join(',')} -> ${to})`);
    } catch (err) {
      console.error('[alert] email failed:', err instanceof Error ? err.message : err);
    }
    const lines = items.map(({ e }) => `${e.date} ${e.text.length > 160 ? e.text.slice(0, 160) + '…' : e.text}`);
    await notify(`${subject}: ${CASE_LABEL}`, lines.join('\n').slice(0, 1200), {
      priority: 'high',
      tags: 'rotating_light,page_facing_up',
      click: TARGET_URL,
    });
    return;
  }
  for (const { kind, e } of items) {
    const label = kind === 'NEW' ? 'New docket entry' : 'Updated docket entry';
    const body = [
      ...caseHeader(),
      `${label}, dated ${e.date}:`,
      e.text,
      ``,
      `Docket: ${TARGET_URL}`,
      `Detected: ${detectedAt}`,
    ].join('\n');
    try {
      await getTransporter().sendMail({
        from,
        to,
        subject: `${CASE_NAME}: ${kind === 'NEW' ? 'new docket entry' : 'docket entry updated'} ${e.date} (${COURT_NAME}, ${CASE_LABEL})`,
        text: body,
      });
      console.log(`[alert] ${kind} email sent (enotice ${e.id} -> ${to})`);
    } catch (err) {
      console.error('[alert] email failed:', err instanceof Error ? err.message : err);
    }
    const pushBody = `${e.date}\n${e.text.length > 900 ? e.text.slice(0, 900) + '…' : e.text}`;
    await notify(`${label}: ${CASE_LABEL}`, pushBody, {
      priority: 'high',
      tags: kind === 'NEW' ? 'rotating_light,page_facing_up' : 'pencil2,page_facing_up',
      click: TARGET_URL,
    });
  }
}

/** Entry-identity path: diff current entries against the known set by id/hash,
 *  alert per new/updated entry, and persist the refreshed known set. Returns the
 *  next State (does not save it — the caller does). */
async function handleEntries(
  state: State,
  entries: Entry[],
  ctx: { hash: string; docketText: string; fullHtml: string; startedAt: string },
): Promise<State> {
  const { hash, docketText, fullHtml, startedAt } = ctx;

  // Refreshed known set = old set with every current entry's hash written through
  // (a merge, so an entry that transiently vanishes from a render doesn't re-alert
  // when it returns). Old ids are retained.
  const known = state.knownEntries;
  const newKnown: Record<string, string> = { ...(known ?? {}) };
  for (const e of entries) newKnown[e.id] = entryHash(e);

  // First run under entry-tracking: record everything as known, do NOT alert.
  if (!known) {
    console.log(`[check] entry baseline established (${entries.length} entries) — no alerts`);
    await saveLastDocket(docketText);
    return { ...state, knownEntries: newKnown, entriesBaselineAt: startedAt, lastHash: hash };
  }

  // Guard against a partial render (docket half-loaded) masquerading as mass change.
  const knownCount = Object.keys(known).length;
  if (knownCount > 20 && entries.length < knownCount * 0.5) {
    console.warn(
      `[check] suspicious entry count ${entries.length} vs known ${knownCount} — skipping diff this cycle`,
    );
    return state; // leave known + lastHash untouched; no alerts
  }

  const fresh: Entry[] = [];
  const updated: Entry[] = [];
  const pending: Record<string, string> = { ...(state.pendingUpdates ?? {}) };
  for (const e of entries) {
    const prev = known[e.id];
    const h = entryHash(e);
    if (prev === undefined) {
      fresh.push(e);
    } else if (prev !== h) {
      if (pending[e.id] === h) {
        updated.push(e); // same new content on two reads in a row: a real edit
        delete pending[e.id];
      } else {
        pending[e.id] = h; // first sighting: hold it, keep the old hash as known
        newKnown[e.id] = prev;
        console.log(`[check] enotice=${e.id} ${e.date} changed; holding until the next read confirms it`);
      }
    } else {
      delete pending[e.id]; // flipped back: nothing to report
    }
  }

  // Edits to old entries are clerk housekeeping, not news: Nic only, no push.
  const cutoff = Date.now() - OLD_UPDATE_DAYS * 86400_000;
  const entryTime = (d: string) => {
    const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : Date.now();
  };
  const oldUpdated = updated.filter((e) => entryTime(e.date) < cutoff);
  const liveUpdated = updated.filter((e) => entryTime(e.date) >= cutoff);
  for (const e of oldUpdated) {
    console.log(`  UPDATED-OLD enotice=${e.id} ${e.date} ${e.text.slice(0, 80)} (Nic only)`);
    await sendEmail(
      `${CASE_NAME}: old docket entry ${e.date} changed (${CASE_LABEL}), not sent to client`,
      [...caseHeader(), `An entry dated ${e.date} changed on two consecutive reads. Sent to ops only.`, ``, e.text, ``, `Docket: ${TARGET_URL}`].join('\n'),
    ).catch((err) => console.error('[alert] old-update email failed:', err instanceof Error ? err.message : err));
  }
  updated.length = 0;
  updated.push(...liveUpdated);

  if (fresh.length === 0 && updated.length === 0) {
    if (oldUpdated.length === 0) console.log(`[check] no change (${entries.length} entries)`);
    await saveLastDocket(docketText);
    return await maybeHeartbeat({ ...state, knownEntries: newKnown, lastHash: hash, pendingUpdates: pending });
  }

  const snapshotPath = await saveSnapshot(fullHtml, hash);
  console.log(`[check] CHANGED: ${fresh.length} new, ${updated.length} updated -> ${snapshotPath}`);
  for (const e of fresh) console.log(`  NEW     enotice=${e.id} ${e.date} ${e.text.slice(0, 80)}`);
  for (const e of updated) console.log(`  UPDATED enotice=${e.id} ${e.date} ${e.text.slice(0, 80)}`);
  await alertEntries(fresh, updated, snapshotPath, knownCount);
  await saveLastDocket(docketText);
  return { ...state, knownEntries: newKnown, lastHash: hash, lastChange: startedAt, pendingUpdates: pending };
}

async function maybeHeartbeat(state: State): Promise<State> {
  const now = Date.now();
  const last = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;
  if (now - last < HEARTBEAT_HOURS * 3600_000) return state;
  const lastChange = state.lastChange ?? '(none yet)';
  await notify(
    `casenet-monitor alive: ${CASE_LABEL}`,
    `Monitoring OK. Last docket change: ${lastChange}. Checked: ${new Date().toISOString()}`,
    { priority: 'min', tags: 'green_heart' },
  );
  console.log('[heartbeat] sent');
  return { ...state, lastHeartbeatAt: new Date().toISOString() };
}

// ----------------------------------------------------- failure alerting ----
async function onFailure(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  if (consecutiveFailures < FAIL_ALERT_THRESHOLD) return;

  const state = await loadState();
  const now = Date.now();
  const lastAlert = state.lastFailAlertAt ? Date.parse(state.lastFailAlertAt) : 0;
  const due = !state.failAlertSent || now - lastAlert > FAIL_REALERT_HOURS * 3600_000;
  if (!due) return;

  const body = [
    `WARNING: casenet-monitor cannot reach the docket for case ${CASE_LABEL} (${CASE_NAME}).`,
    ``,
    `Consecutive failed checks: ${consecutiveFailures}`,
    `Most likely cause: VPN is off or not on a ${VPN_COUNTRY} server, or Case.net is down/blocking.`,
    ``,
    `Fix: ensure the VPN is connected to a ${VPN_COUNTRY} server. The monitor recovers`,
    `automatically and sends an "all clear" once it can read the docket again.`,
    ``,
    `Last error: ${msg}`,
    `At: ${new Date().toISOString()}`,
  ].join('\n');

  await sendEmail(`${CASE_NAME} monitor: CANNOT REACH DOCKET`, body);
  await notify(
    `Monitor can't reach docket: ${CASE_LABEL}`,
    `${consecutiveFailures} failed checks. Check the VPN is ON and set to ${VPN_COUNTRY}. Last error: ${msg}`,
    { priority: 'urgent', tags: 'warning' },
  );
  await saveState({ ...state, failAlertSent: true, lastFailAlertAt: new Date().toISOString() });
  console.log('[fail-alert] sent');
}

async function notifyRecovered(state: State): Promise<State> {
  if (!state.failAlertSent) return state;
  await sendEmail(
    `${CASE_NAME} monitor: recovered`,
    `casenet-monitor can read the docket again for case ${CASE_LABEL}.\nRecovered at: ${new Date().toISOString()}`,
  );
  await notify(`Monitor recovered: ${CASE_LABEL}`, `Docket is reachable again.`, {
    priority: 'default',
    tags: 'white_check_mark',
  });
  console.log('[fail-alert] recovery sent');
  return { ...state, failAlertSent: false, lastFailAlertAt: undefined };
}

// --------------------------------------------------------------- tick -------
async function tick(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[check] ${startedAt}`);

  await ensureBrowser();

  if (VPN_CHECK) {
    const country = await egressCountry();
    if (country && country !== VPN_COUNTRY) {
      await notify(
        `casenet-monitor PAUSED: VPN not ${VPN_COUNTRY}`,
        `Egress country is ${country}, expected ${VPN_COUNTRY}. Connect the VPN to a ${VPN_COUNTRY} server.`,
        { priority: 'urgent', tags: 'warning' },
      );
      throw new Error(`VPN egress is ${country}, not ${VPN_COUNTRY} — refusing to scrape`);
    }
    console.log(`[vpn] egress country=${country ?? 'unknown(ok)'}`);
  }

  let state = await loadState();
  const oldDocket = await loadLastDocket();
  const { hash, docketText, fullHtml, entries } = await fetchSnapshot();

  state = clearFailures(state);
  state = await notifyRecovered(state);

  // ---- Preferred path: per-entry identity tracking (date/position independent) ----
  if (entries && entries.length > 0) {
    state = await handleEntries(state, entries, { hash, docketText, fullHtml, startedAt });
    await saveState(state);
    return;
  }

  // ---- Fallback path: whole-text hash + by-date diff (DOM shape changed / empty) ----
  console.warn('[check] entry extraction unavailable — using text-diff fallback');
  if (state.lastHash === hash) {
    console.log(`[check] no change (${hash.slice(0, 8)})`);
    state = await maybeHeartbeat(state);
    await saveState(state);
    return;
  }

  const snapshotPath = await saveSnapshot(fullHtml, hash);

  if (!state.lastHash) {
    console.log(`[check] baseline established (${hash.slice(0, 8)}) -> ${snapshotPath}`);
    await saveLastDocket(docketText);
    await saveState({ ...state, lastHash: hash, baselineAt: startedAt });
    return;
  }

  const newEntries = extractNewEntries(oldDocket, docketText);
  console.log(`[check] CHANGED ${state.lastHash.slice(0, 8)} -> ${hash.slice(0, 8)} (${snapshotPath})`);
  console.log(`[check] new content:\n${newEntries.slice(0, 500)}`);

  await sendAlert(newEntries, state.lastHash, hash, snapshotPath);
  await saveLastDocket(docketText);
  await saveState({ ...state, lastHash: hash, lastChange: startedAt });
}

function nextDelay(): number {
  if (consecutiveFailures > 0) {
    const backoff = Math.min(MAX_BACKOFF_MS, INTERVAL_MS * Math.pow(2, consecutiveFailures - 1));
    console.log(`[backoff] ${consecutiveFailures} failures, waiting ${Math.round(backoff / 1000)}s`);
    return backoff;
  }
  const base = isNightUtc() ? NIGHT_INTERVAL_MS : INTERVAL_MS;
  if (JITTER_PCT === 0) return base;
  const span = base * (JITTER_PCT / 100);
  const offset = (Math.random() * 2 - 1) * span;
  return Math.max(60_000, Math.round(base + offset));
}

/** True when the current UTC hour falls inside NIGHT_UTC_HOURS ("0-7" = 00:00 to 06:59). */
function isNightUtc(now: Date = new Date()): boolean {
  const m = NIGHT_UTC_HOURS.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const h = now.getUTCHours();
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

async function main(): Promise<void> {
  console.log(
    `[start] case=${CASE_LABEL}  interval=${Math.round(INTERVAL_MS / 1000)}s  night(${NIGHT_UTC_HOURS}Z)=${Math.round(NIGHT_INTERVAL_MS / 1000)}s  jitter=±${JITTER_PCT}%  retries=${CHECK_RETRIES}`,
  );
  consecutiveFailures = (await loadState()).consecutiveFailures ?? 0;
  if (consecutiveFailures > 0) {
    console.log(`[start] resuming with ${consecutiveFailures} failure(s) already on record`);
  }
  console.log(`[start] cdp=http://127.0.0.1:${CDP_PORT}  display=${DISPLAY}  ntfy=${NTFY_TOPIC ? 'on' : 'off'}  vpnCheck=${VPN_CHECK}(${VPN_COUNTRY})  heartbeat=${HEARTBEAT_HOURS}h`);

  if (!ONCE && START_DELAY_MS > 0) {
    console.log(`[start] staggering first check by ${Math.round(START_DELAY_MS / 1000)}s`);
    await new Promise((r) => setTimeout(r, START_DELAY_MS));
  }

  await tick().catch(async (e) => {
    console.error('[check] failed:', e instanceof Error ? e.message : e);
    await bumpFailures();
  });

  if (ONCE) return;

  const loop = (): void => {
    const delay = nextDelay();
    console.log(`[loop] next check in ${Math.round(delay / 1000)}s (${new Date(Date.now() + delay).toISOString()})`);
    setTimeout(() => {
      tick()
        .catch(async (e) => {
          console.error('[check] failed:', e instanceof Error ? e.message : e);
          await bumpFailures();
          await onFailure(e).catch((err) =>
            console.error('[fail-alert] error:', err instanceof Error ? err.message : err),
          );
        })
        .finally(loop);
    }, delay);
  };
  loop();
}

main().catch((e) => {
  console.error('[fatal]', e instanceof Error ? e.message : e);
  process.exit(1);
});
