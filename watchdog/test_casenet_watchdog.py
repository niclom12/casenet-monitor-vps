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
            "WATCHDOG_STATE_FILE": os.path.join(self.dir, "state.json"),
            "ALERT_TO": "nic@atab.ai",
            # A window that is open at NOW and for the next 9 hours, so these
            # tests are about staleness alone. CourtHours below tests the window.
            "ACTIVE_TZ": "Etc/GMT-12",
            "ACTIVE_DAYS": "1-7",
            "ACTIVE_HOURS": "0000-2359",
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

    def test_every_bad_check_after_the_first_alerts(self):
        # No throttle: an hour of bad checks is five emails (the first check only
        # confirms nothing is mid-write).
        self.stale()
        for i in range(6):
            self.run_once(NOW + i * 600)
        self.assertEqual(len(self.sent), 5)

    def test_a_second_docket_going_bad_is_reported_while_the_first_is_open(self):
        # 29 Oct 2026: King had alerted, then Aretino went unread and the old
        # box-wide throttle swallowed it.
        self.put("main.txt", real_docket(), 200)
        self.put("d01.txt", real_docket(), 10)
        self.run_once()
        self.run_once(NOW + 600)
        self.put("d01.txt", real_docket(), 200)
        self.run_once(NOW + 1200)
        self.assertEqual(len(self.sent), 2)
        self.assertIn("2622-CC00325-01", self.sent[-1][0])

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


class ClientMail(Alerting):
    """The client list hears once per episode: >2 bad checks, grouped, then recovery."""

    def setUp(self):
        super().setUp()
        self.client_sent = []
        self.conf["CLIENT_ALERT_TO"] = "client@example.com"
        self.conf["DOCKET_NAMES"] = "2622-CC00325:Case A,2622-CC00325-01:Case A settlement"

    def client_mailer(self, subject, body):
        self.client_sent.append((subject, body))

    def run_once(self, now=NOW):
        return w.run(self.conf, now=now, mailer=self.mailer, client_mailer=self.client_mailer)

    def test_two_bad_checks_do_not_reach_the_client(self):
        self.stale()
        self.run_once()
        self.run_once(NOW + 600)
        self.assertEqual(self.client_sent, [])
        self.assertEqual(len(self.sent), 1)    # Nic already hears

    def test_third_bad_check_sends_one_grouped_email(self):
        self.stale()
        for i in range(6):
            self.run_once(NOW + i * 600)
        self.assertEqual(len(self.client_sent), 1)
        subject, body = self.client_sent[0]
        self.assertIn("2622-CC00325, 2622-CC00325-01", subject)
        self.assertIn("Case A settlement", body)
        self.assertIn("3 checks in a row", body)
        self.assertNotIn("systemctl", body)   # no ops detail for the client

    def test_a_further_docket_going_bad_sends_one_more(self):
        self.put("main.txt", real_docket(), 200)
        self.put("d01.txt", real_docket(), 10)
        for i in range(3):
            self.run_once(NOW + i * 600)
        self.put("d01.txt", real_docket(), 200)
        for i in range(3, 6):
            self.run_once(NOW + i * 600)
        self.assertEqual(len(self.client_sent), 2)
        self.assertIn("2622-CC00325-01", self.client_sent[1][0])

    def test_one_recovery_email_after_an_alert(self):
        self.stale()
        for i in range(3):
            self.run_once(NOW + i * 600)
        later = NOW + 3600
        self.fresh(later)
        self.run_once(later)
        self.run_once(later + 600)
        self.assertEqual([s for s, _ in self.client_sent].count(
            "Case.net monitor: reading every docket again"), 1)
        self.assertEqual(len(self.client_sent), 2)

    def test_no_client_recovery_if_the_client_was_never_told(self):
        self.stale()
        self.run_once()
        self.run_once(NOW + 600)               # Nic told, client not
        self.fresh(NOW + 1200)
        self.run_once(NOW + 1200)
        self.assertEqual(self.client_sent, [])

    def test_no_client_list_means_no_client_mail(self):
        del self.conf["CLIENT_ALERT_TO"]
        self.stale()
        for i in range(5):
            w.run(self.conf, now=NOW + i * 600, mailer=self.mailer)
        self.assertEqual(len(self.sent), 4)


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


class TradingWindow(Base):
    """Fast checks 08:00-17:00 Central on weekdays, slow ones the rest of the time."""

    # Mon 19 Oct 2026, Central Daylight Time (UTC-5).
    MON_0700 = 1_792_411_200   # 07:00 CDT, before the window
    MON_0800 = MON_0700 + 3600

    def setUp(self):
        super().setUp()
        for k in ("ACTIVE_TZ", "ACTIVE_DAYS", "ACTIVE_HOURS", "STALE_MINUTES"):
            del self.conf[k]          # the real defaults: 75 in, 150 out

    def both_read_minutes_before(self, now, minutes):
        for name in ("main.txt", "d01.txt"):
            p = os.path.join(self.dir, name)
            with open(p, "w") as fh:
                fh.write(real_docket())
            t = now - minutes * 60
            os.utime(p, (t, t))

    def test_window_bounds(self):
        self.assertIsNone(w.window_open_ts(self.conf, self.MON_0700))
        self.assertEqual(w.window_open_ts(self.conf, self.MON_0800), self.MON_0800)
        self.assertEqual(w.window_open_ts(self.conf, self.MON_0800 + 8 * 3600 + 3599), self.MON_0800)
        self.assertIsNone(w.window_open_ts(self.conf, self.MON_0800 + 9 * 3600))      # 17:00
        self.assertIsNone(w.window_open_ts(self.conf, self.MON_0800 - 2 * 86400))     # Saturday

    def test_off_hours_are_checked_with_the_longer_limit(self):
        night = self.MON_0700
        self.both_read_minutes_before(night, 100)
        self.assertEqual(w.evaluate(self.conf, night)[0], "OK")
        self.both_read_minutes_before(night, 160)
        self.assertEqual(w.evaluate(self.conf, night)[0], "STALE")

    def test_weekend_silence_alerts(self):
        saturday = self.MON_0800 - 2 * 86400
        self.both_read_minutes_before(saturday, 24 * 60)
        self.run_once(saturday)
        self.run_once(saturday + 600)
        self.assertEqual(len(self.sent), 1)

    def test_inside_the_window_the_short_limit_applies(self):
        later = self.MON_0800 + 3 * 3600
        self.both_read_minutes_before(later, 80)
        self.assertEqual(w.evaluate(self.conf, later)[0], "STALE")
        self.both_read_minutes_before(later, 60)
        self.assertEqual(w.evaluate(self.conf, later)[0], "OK")
