import 'dotenv/config';
import { chromium, type Browser } from 'playwright-core';
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const CASENET_LANDING = env(
  'CASENET_LANDING',
  'https://www.courts.mo.gov/casenet/cases/searchCases.do',
);
const DOCKET_SELECTOR = env('DOCKET_SELECTOR', '#actualDocketData');
const CDP_PORT = env('CDP_PORT', '9222');

const INTERVAL_MS = Number(env('INTERVAL_MS', '1800000'));
const JITTER_PCT = Math.max(0, Math.min(100, Number(env('JITTER_PCT', '25'))));

const STATE_FILE = env('STATE_FILE', 'state.json');
const SNAPSHOTS_DIR = env('SNAPSHOTS_DIR', 'snapshots');
const DOCKET_FILE = env('DOCKET_FILE', 'last-docket.txt');

// Self-healing browser (relaunched automatically if CDP is unreachable).
// On a VPS this is headful Chromium/Chrome running under an Xvfb virtual display.
const BROWSER_BIN = env('BROWSER_BIN', '/usr/bin/google-chrome');
const BROWSER_PROFILE = env('BROWSER_PROFILE', `${process.env.HOME}/.casenet-browser-profile`);
const BROWSER_EXTRA_FLAGS = process.env.BROWSER_EXTRA_FLAGS ?? '';
const DISPLAY = env('DISPLAY', ':99');

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

const ONCE = process.argv.includes('--once');
const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;
let consecutiveFailures = 0;

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
};

async function loadState(): Promise<State> {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State;
}
async function saveState(s: State): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}
async function loadLastDocket(): Promise<string> {
  if (!existsSync(DOCKET_FILE)) return '';
  return readFile(DOCKET_FILE, 'utf8');
}
async function saveLastDocket(text: string): Promise<void> {
  await writeFile(DOCKET_FILE, text);
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

async function fetchSnapshot(): Promise<{ hash: string; docketText: string; fullHtml: string }> {
  const cdpUrl = await getCdpEndpoint();
  console.log(`[cdp] ${cdpUrl.slice(0, 60)}...`);
  const browser: Browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();

  try {
    await page.goto(CASENET_LANDING, { waitUntil: 'networkidle', timeout: 60_000 });
    const landingTitle = await page.title();
    if (/just a moment|attention required|error/i.test(landingTitle)) {
      throw new Error(`Blocked at landing (Cloudflare?): "${landingTitle}"`);
    }

    await page.waitForTimeout(1000 + Math.random() * 2000);

    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    const caseTitle = await page.title();
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
      { timeout: 30_000 },
    );
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    const fullHtml = await page.content();
    const docketText = await page.locator(DOCKET_SELECTOR).innerText();
    const hash = createHash('sha256').update(docketText).digest('hex');
    return { hash, docketText, fullHtml };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {}); // disconnect CDP only; leaves the browser running
  }
}

// ------------------------------------------------------ docket diff ---------
/** Docket entries are prepended (newest on top), so new content is the prefix
 *  of the new text that precedes the previous text. Returns the new lines. */
function extractNewEntries(oldText: string, newText: string): string {
  const norm = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const oldLines = norm(oldText);
  const newLines = norm(newText);

  const offset = newLines.length - oldLines.length;
  if (offset > 0) {
    let suffixMatches = true;
    for (let i = 0; i < oldLines.length; i++) {
      if (newLines[offset + i] !== oldLines[i]) {
        suffixMatches = false;
        break;
      }
    }
    if (suffixMatches) return newLines.slice(0, offset).join('\n');
  }
  const oldSet = new Set(oldLines);
  return newLines.filter((l) => !oldSet.has(l)).join('\n');
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
    `New filing(s) detected in case ${CASE_LABEL} (${CASE_NAME}).`,
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
      subject: `${CASE_NAME} docket entry (${CASE_LABEL})`,
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
  const { hash, docketText, fullHtml } = await fetchSnapshot();

  consecutiveFailures = 0;
  state = await notifyRecovered(state);

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
  if (JITTER_PCT === 0) return INTERVAL_MS;
  const span = INTERVAL_MS * (JITTER_PCT / 100);
  const offset = (Math.random() * 2 - 1) * span;
  return Math.max(60_000, Math.round(INTERVAL_MS + offset));
}

async function main(): Promise<void> {
  console.log(`[start] case=${CASE_LABEL}  interval=${Math.round(INTERVAL_MS / 1000)}s  jitter=±${JITTER_PCT}%`);
  console.log(`[start] cdp=http://127.0.0.1:${CDP_PORT}  display=${DISPLAY}  ntfy=${NTFY_TOPIC ? 'on' : 'off'}  vpnCheck=${VPN_CHECK}(${VPN_COUNTRY})  heartbeat=${HEARTBEAT_HOURS}h`);

  await tick().catch((e) => {
    console.error('[check] failed:', e instanceof Error ? e.message : e);
    consecutiveFailures++;
  });

  if (ONCE) return;

  const loop = (): void => {
    const delay = nextDelay();
    console.log(`[loop] next check in ${Math.round(delay / 1000)}s (${new Date(Date.now() + delay).toISOString()})`);
    setTimeout(() => {
      tick()
        .catch(async (e) => {
          console.error('[check] failed:', e instanceof Error ? e.message : e);
          consecutiveFailures++;
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
