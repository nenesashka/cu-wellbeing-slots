import datetime as dt
import json
import unittest
from unittest import mock
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check


def page(event_id, registration_open, entries):
    data = {"id": event_id, "reg_open": registration_open, "recurring_events": entries}
    return "<script>(function(){return " + json.dumps(data) + ";})()</script>"


class CheckTests(unittest.TestCase):
    def test_two_events_are_kept_distinct_and_slots_are_filtered(self):
        now = dt.datetime(2026, 10, 25, tzinfo=dt.timezone.utc)
        entries = [
            {"id": 20, "date_iso8601": "2026-11-02T14:00:00+03:00", "tickets_left": 1, "unavaliable": False},
            {"id": 21, "date_iso8601": "2026-11-01T11:15:00+03:00", "tickets_left": 2, "unavaliable": False},
            {"id": 22, "date_iso8601": "2026-10-24T11:15:00+03:00", "tickets_left": 1, "unavaliable": False},
            {"id": 23, "date_iso8601": "2026-11-03T11:15:00+03:00", "tickets_left": 0, "unavaliable": False},
            {"id": 24, "date_iso8601": "2026-11-04T11:15:00+03:00", "tickets_left": 1, "unavaliable": True},
            {"id": 25, "date_iso8601": "2026-11-05T16:30:00+03:00", "tickets_left": None,
             "tickets_limited": False, "unavaliable": False},
        ]
        result = check.parse_event(page(3558805, True, entries), 3558805, now)
        self.assertEqual([slot["id"] for slot in result["slots"]], ["21", "20", "25"])
        self.assertEqual(result["slots"][0]["start"], "2026-11-01T11:15:00+03:00")
        with self.assertRaises(ValueError):
            check.parse_event(page(3558805, True, entries), 3219855, now)
        recurring = check.parse_event(page(3219855, False, entries), 3219855, now)
        self.assertTrue(recurring["registration_open"],
                        "available child slots override the parent's closed flag")
        self.assertEqual([slot["id"] for slot in recurring["slots"]], ["21", "20", "25"])
        closed = check.parse_event(page(3219855, False, []), 3219855, now)
        self.assertFalse(closed["registration_open"])
        self.assertEqual(closed["slots"], [])

    def test_partial_source_failure_delivers_both_statuses_once(self):
        delivered = []
        def fake_check(name, _event_id):
            if name == "lilia":
                raise TimeoutError("source unavailable")
            return {"registration_open": True, "slots": [{"id": "1", "start": "2026-11-01T11:15:00+03:00"}]}
        with mock.patch.object(check, "check_event", side_effect=fake_check), \
             mock.patch.object(check, "deliver", side_effect=delivered.append):
            with self.assertRaisesRegex(RuntimeError, "One or more"):
                check.main()
        self.assertEqual(len(delivered), 1)
        self.assertEqual(set(delivered[0]["events"]), {"svetlana", "lilia"})
        self.assertEqual(delivered[0]["events"]["lilia"], {"error": "source_unavailable"})


if __name__ == "__main__":
    unittest.main()
