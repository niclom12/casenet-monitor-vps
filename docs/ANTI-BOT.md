# Anti-bot: headful, Xvfb, and Cloudflare — honestly

CaseNet sits behind Cloudflare. That's the single biggest risk to this working on a VPS, so
here's the straight story.

## Why headful (not headless)
Cloudflare's "managed challenge" fingerprints the browser. Vanilla **headless** Chromium leaks
tells (`navigator.webdriver`, headless UA/GPU quirks, missing window chrome) and typically lands
you in the `"just a moment…"` loop. A **real headful Chrome** rendered into an **Xvfb** virtual
display presents a normal-browser fingerprint and usually clears the *non-interactive* challenge
on its own. That's the approach here — same as the original laptop deployment (which used a real
headful Opera). On a server you get "headful without a monitor" via Xvfb.

Middle options exist (`--headless=new`, `playwright-extra` + stealth, `patchright`/`rebrowser`).
They're better than vanilla headless but still less reliable than true-headful-under-Xvfb against
Cloudflare. Start with what this repo does; reach for stealth only if needed.

## Why the IP matters as much as the browser
Cloudflare scores the **IP** too. Two facts from the working deployment:
- A **ProtonVPN US** exit IP (a VPN/datacenter IP) **does** currently pass CaseNet's Cloudflare.
  So you do **not** strictly need residential egress here — Proton US is empirically enough today.
- A **bare VPS datacenter IP with no VPN** is far more likely to be challenged/blocked. Always
  scrape through the US VPN; never off it (the `VPN_CHECK` guard enforces this).

This can change if Cloudflare tightens CaseNet's config or blocklists a Proton range. If that
happens, switch Proton servers (new `.conf`) or move to a residential proxy via
`BROWSER_EXTRA_FLAGS=--proxy-server=...`.

## The persistent profile matters
`BROWSER_PROFILE` is a persistent `--user-data-dir`. Once Chrome solves a challenge, the
`cf_clearance` cookie lives there and smooths subsequent loads. **Don't delete the profile**
casually — a fresh profile may have to re-clear Cloudflare.

## What would actually break automation
If Cloudflare escalates CaseNet to an **interactive** challenge (Turnstile checkbox / CAPTCHA),
no unattended headful browser will pass it silently. Mitigations:
- Solve it **once** by hand over the same persistent profile (VNC into `:99`, click through),
  then let the saved cookie carry the daemon for a while.
- Or front it with a CAPTCHA-solving/residential service.

This is the one risk you can't fully engineer away from a datacenter — see TROUBLESHOOTING.

## Politeness (keeps you off the radar)
- Default cadence is 30 min with ±25% jitter — gentle and non-robotic. Don't crank it down.
- The monitor hits the search landing page before the case page (looks like a real session).
- One page load per check; it disconnects CDP but leaves the browser warm.
