// When to check. The monitors run all day, every day (Nic, 30 Oct 2026): fast in
// the trading window, slow outside it. Same window as the watchdog's
// ACTIVE_TZ / ACTIVE_DAYS / ACTIVE_HOURS: 08:00-17:00 Central, Monday to Friday.

export type Window = { tz: string; d0: number; d1: number; h0: number; h1: number };

/** "1-5" and "0800-1700" (end exclusive) -> a Window. Throws on a malformed value. */
export function parseWindow(tz: string, days: string, hours: string): Window {
  const d = days.match(/^(\d)-(\d)$/);
  const h = hours.match(/^(\d{4})-(\d{4})$/);
  if (!d || !h) throw new Error(`bad window: days="${days}" hours="${hours}"`);
  return { tz, d0: +d[1], d1: +d[2], h0: +h[1], h1: +h[2] };
}

/** True when `now`, in the window's time zone, is on an ISO weekday d0..d1 and at HHMM h0..h1-1. */
export function inWindow(w: Window, now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: w.tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const iso = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const hm = Number(get('hour')) * 100 + Number(get('minute'));
  return iso >= w.d0 && iso <= w.d1 && hm >= w.h0 && hm < w.h1;
}

/** Milliseconds to the next check. A failure does not stretch it: the next check is
 *  the normal one, so a run of Cloudflare refusals cannot turn into an hour unread. */
export function nextDelayMs(opts: {
  fast: boolean;
  fastMs: number;
  slowMs: number;
  jitterPct: number;
  rand?: () => number;
}): number {
  const base = opts.fast ? opts.fastMs : opts.slowMs;
  if (opts.jitterPct <= 0) return base;
  const span = base * (opts.jitterPct / 100);
  const offset = ((opts.rand ?? Math.random)() * 2 - 1) * span;
  return Math.max(60_000, Math.round(base + offset));
}
