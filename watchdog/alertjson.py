#!/usr/bin/env python3
"""The machine-readable block every Lacuna monitor appends to its alert email.

VENDORED COPY. The canonical file is services/notification-hub/alertjson.py in
the Lacuna Analysis repo. It is copied here rather than imported because the
monitors deploy independently and there is no shared import path on the box. Do
not edit this copy on its own: change the canonical file and re-copy it to every
location listed at the bottom of this docstring. A monitor emitting a different
shape is worse than one emitting nothing, because the hub will store the wrong
thing without complaining.

Format, from notification-hub/CONTRACT.md section 5:

    --- LACUNA-ALERT-JSON ---
    {"v":1,"source":"polymarket","class":"signal","kind":"price_tier1",...}
    --- END-LACUNA-ALERT-JSON ---

Three rules the callers have to keep, which this module cannot enforce on its
own:

  * The block is the LAST thing in the text/plain part, so a mail client preview
    never leads with it.
  * It goes in the text part only. The HTML part is untouched, so what Nic reads
    on his phone does not change at all.
  * The sender also sets the header ``X-Lacuna-Alert: 1``.

Python 3 standard library only. Pure functions, no IO, no clock reads: the
caller passes ``ts``.

Vendored copies:
    services/polymarket-monitor/alertjson.py
    services/pacer-rss-monitor/alertjson.py
    shared/scotus/alertjson.py
    ~/repos/wa-gateway/watchdog/alertjson.py   (deployed /home/casenet/wa-watchdog)
    ~/repos/casenet-monitor-vps/src/alertjson.ts  (a TypeScript port, same shape)
"""

import json

BEGIN = "--- LACUNA-ALERT-JSON ---"
END = "--- END-LACUNA-ALERT-JSON ---"

# CONTRACT.md section 3. A monitor that invents a third class would be stored and
# then silently filtered out of every digest, so it is rejected here instead.
CLASSES = ("signal", "ops")

# CONTRACT.md section 2. `unknown` is included because it is a legal value, not a
# failure state: losing a notification is worse than storing one badly.
SOURCES = ("polymarket", "pacer", "casenet", "wa-watchdog", "scotus", "unknown")


def _one_line(value):
    """Collapse whitespace so the headline can never break the single JSON line.

    json.dumps escapes a newline rather than emitting one, so this is not what
    keeps the block parseable. It is so the headline reads as one line when a
    human looks at the raw source of the mail.
    """
    return " ".join(str(value).split())


def render_block(*, source, kind, headline, klass="signal", ts=None, tier=None,
                 case_id=None, entity=None, url=None, detail=None, v=1):
    """The three-line block, with no trailing newline.

    `v`, `source`, `kind` and `headline` are required. Every other field is
    omitted from the JSON when it is None, which the contract allows: a parser
    reads an absent field and a null field the same way.
    """
    source = _one_line(source)
    kind = _one_line(kind)
    headline = _one_line(headline)
    if not source:
        raise ValueError("alertjson: source is required")
    if not kind:
        raise ValueError("alertjson: kind is required")
    if not headline:
        raise ValueError("alertjson: headline is required")
    if klass not in CLASSES:
        raise ValueError(f"alertjson: class must be one of {CLASSES}, got {klass!r}")

    # Field order follows CONTRACT.md section 5 so a raw block read by eye looks
    # like the one in the contract. JSON object order is not semantic; this is
    # for the human diffing a live email against the document.
    payload = {"v": v, "source": source, "class": klass, "kind": kind}
    if ts is not None:
        payload["ts"] = int(ts)
    if tier is not None:
        payload["tier"] = _one_line(tier)
    if case_id is not None:
        payload["case_id"] = _one_line(case_id)
    if entity is not None:
        payload["entity"] = _one_line(entity)
    payload["headline"] = headline
    if url is not None:
        payload["url"] = _one_line(url)
    if detail is not None:
        payload["detail"] = detail

    # ensure_ascii=True is deliberate. The block travels through a shared relay
    # that is free to re-encode the text part (quoted-printable, 8-bit, or a
    # charset conversion), and a case name carrying an accent or a curly quote is
    # exactly the kind of thing that arrives mangled. Pure ASCII survives all of
    # them unchanged, and \uXXXX round-trips back to the original string.
    line = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    return f"{BEGIN}\n{line}\n{END}"


def append_block(text_body, **kwargs):
    """`text_body` with the block appended as the last thing in it.

    Separated by one blank line so it reads as a footer rather than as part of
    the alert. Takes the same keyword arguments as render_block.
    """
    block = render_block(**kwargs)
    body = (text_body or "").rstrip()
    if not body:
        return block + "\n"
    return f"{body}\n\n{block}\n"
