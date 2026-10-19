"""Tests for casenet_watchdog. Stdlib unittest, no network, no clock reads."""
import os
import tempfile
import unittest

import alertjson
import casenet_watchdog as w

NOW = 1_789_700_000  # fixed clock


def real_docket(entries=30):
    """Text shaped like the monitor's saved docket: dated groups, 'Filed By' lines."""
    out = ["Sort by date: Descending Ascending", "All Entries", "09/16/2026"]
    for i in range(entries):
        out += ["Order", f"ORDER {i}: SO ORDERED JUDGE TIMOTHY BOYER",
                f"     Filed By: ATTORNEY {i}", "     On Behalf Of: MONSANTO CO"]
    return "\n".join(out) + "\n"


BLOCK_PAGE = ("<!doctype html><title>Just a moment...</title>"
              "Performing security verification. Ray ID: 8c1f")
CASENET_403 = ("Error 403 Access to any Missouri judicial website, including but not "
               "limited to Case.net, by a site data scraper ... is expressly prohibited.")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.sent = []
        self.conf = {
            "CASENET_DIR": self.dir,
            "DOCKETS": "2622-CC00325:main.txt,2622-CC00325-01:d01.txt",
            "STALE_MINUTES": "90",
            "MIN_FILED_BY": "20",
            "WATCHDOG_FAIL_THRESHOLD": "2",
            "WATCHDOG_REPEAT_HOURS": "6",
            "WATCHDOG_STATE_FILE": os.path.join(self.dir, "state.json"),
            "ALERT_TO": "nic@atab.ai",
        }

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, name, text, age_min):
        p = os.path.join(self.dir, name)
        with open(p, "w") as fh:
            fh.write(text)
        t = NOW - age_min * 60
        os.utime(p, (t, t))

    def mailer(self, subject, body, alert=None):
        self.sent.append((subject, body, alert))

    def run_once(self, now=NOW):
        return w.run(self.conf, now=now, mailer=self.mailer)


class CheckDocket(Base):
    def test_fresh_real_docket_is_ok(self):
        self.put("main.txt", real_docket(), 10)
        kind, detail, _ = w.check_docket(os.path.join(self.dir, "main.txt"), NOW, 5400, 20)
        self.assertEqual(kind, "ok", detail)

    def test_stale_real_docket_is_stale(self):
        self.put("main.txt", real_docket(), 120)
        kind, _, age = w.check_docket(os.path.join(self.dir, "main.txt"), NOW, 5400, 20)
        self.assertEqual(kind, "stale")
        self.assertAlmostEqual(age, 120, delta=1)

    def test_fresh_cloudflare_page_is_invalid_not_ok(self):
        # The case that matters most: a block page must never pass as a read.
        self.put("main.txt", BLOCK_PAGE, 1)
        kind, detail, _ = w.check_docket(os.path.join(self.dir, "main.txt"), NOW, 5400, 20)
        self.assertEqual(kind, "invalid")
        self.assertIn("not the docket", detail)

    def test_casenet_antiscraping_403_is_invalid(self):
        self.put("main.txt", CASENET_403 + "\n" + real_docket(), 1)
        kind, _, _ = w.check_docket(os.path.join(self.dir, "main.txt"), NOW, 5400, 20)
        self.assertEqual(kind, "invalid")

    def test_near_empty_render_is_invalid(self):
        self.put("main.txt", real_docket(entries=1), 1)
        kind, detail, _ = w.check_docket(os.path.join(self.dir, "main.txt"), NOW, 5400, 20)
        self.assertEqual(kind, "invalid")
        self.assertIn("incomplete", detail)

    def test_missing_file_is_invalid(self):
        kind, _, age = w.check_docket(os.path.join(self.dir, "nope.txt"), NOW, 5400, 20)
        self.assertEqual(kind, "invalid")
        self.assertIsNone(age)


class Evaluate(Base):
    def test_all_fresh_is_ok(self):
        self.put("main.txt", real_docket(), 20)
        self.put("d01.txt", real_docket(), 5)
        state, _ = w.evaluate(self.conf, NOW)
        self.assertEqual(state, "OK")

    def test_one_stale_docket_is_stale(self):
        self.put("main.txt", real_docket(), 20)
        self.put("d01.txt", real_docket(), 200)
        state, results = w.evaluate(self.conf, NOW)
        self.assertEqual(state, "STALE")
        self.assertEqual([r[0] for r in results if not r[1]], ["2622-CC00325-01"])

    def test_invalid_outranks_stale(self):
        self.put("main.txt", real_docket(), 200)   # stale
        self.put("d01.txt", BLOCK_PAGE, 1)          # invalid
        state, _ = w.evaluate(self.conf, NOW)
        self.assertEqual(state, "INVALID")

    def test_empty_config_is_invalid_not_silently_ok(self):
        self.conf["DOCKETS"] = ""
        state, _ = w.evaluate(self.conf, NOW)
        self.assertEqual(state, "INVALID")


class Alerting(Base):
    def stale(self):
        self.put("main.txt", real_docket(), 200)
        self.put("d01.txt", real_docket(), 200)

    def fresh(self, now=NOW):
        for n in ("main.txt", "d01.txt"):
            p = os.path.join(self.dir, n)
            with open(p, "w") as fh:
                fh.write(real_docket())
            os.utime(p, (now - 60, now - 60))

    def test_one_bad_check_does_not_alert(self):
        self.stale()
        self.assertEqual(self.run_once(), 1)
        self.assertEqual(self.sent, [])

    def test_second_bad_check_alerts_once(self):
        self.stale()
        self.run_once()
        self.run_once(NOW + 600)
        self.assertEqual(len(self.sent), 1)
        subject, body, alert = self.sent[0]
        self.assertIn("NOT READING DOCKET", subject)
        self.assertIn("2622-CC00325-01", body)
        self.assertEqual(alert["source"], "casenet")
        self.assertEqual(alert["klass"], "ops")

    def test_repeat_is_throttled(self):
        self.stale()
        for i in range(6):                     # an hour of checks
            self.run_once(NOW + i * 600)
        self.assertEqual(len(self.sent), 1)

    def test_realerts_after_throttle_window(self):
        self.stale()
        self.run_once()
        self.run_once(NOW + 600)
        self.run_once(NOW + 600 + 6 * 3600 + 60)
        self.assertEqual(len(self.sent), 2)

    def test_recovery_emails_once_after_a_real_alert(self):
        self.stale()
        self.run_once()
        self.run_once(NOW + 600)               # alerted
        later = NOW + 1800
        self.fresh(later)
        self.run_once(later)
        self.run_once(later + 600)             # still OK: no second recovery
        subjects = [s[0] for s in self.sent]
        self.assertEqual(subjects.count("Case.net monitor: RECOVERED"), 1)

    def test_no_recovery_email_if_nobody_was_told(self):
        self.stale()
        self.run_once()                        # one bad check, below threshold
        self.fresh()
        self.run_once(NOW + 60)
        self.assertEqual(self.sent, [])

    def test_alert_payload_is_accepted_by_alertjson(self):
        # A malformed block is stored wrong by the hub without complaint, so prove
        # the real renderer takes what this watchdog hands it.
        self.stale()
        self.run_once()
        self.run_once(NOW + 600)
        _, body, alert = self.sent[0]
        rendered = alertjson.append_block(body, **alert)
        self.assertIn(alertjson.BEGIN, rendered)


class Recipients(unittest.TestCase):
    def test_default_recipient_is_nic_only(self):
        self.assertEqual(w.cfg_list({}, "ALERT_TO", "nic@atab.ai"), ["nic@atab.ai"])

    def test_data_layer_is_copied_but_never_the_reason_to_send(self):
        conf = {"ALWAYS_ALERT_TO": "notifications@atab.ai"}
        self.assertEqual(w.with_always(conf, ["nic@atab.ai"]),
                         ["nic@atab.ai", "notifications@atab.ai"])
        self.assertEqual(w.with_always(conf, []), [])


if __name__ == "__main__":
    unittest.main()
