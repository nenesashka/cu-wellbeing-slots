#!/usr/bin/env python3
"""Fetch Timepad booking in the cloud and deliver results to the Telegram webhook."""

import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

EVENT_URL = "https://cu-events.timepad.ru/event/3219855/"
TRANSLATE_URL = "https://translate.yandex.ru/translate?" + urllib.parse.urlencode(
    {"url": EVENT_URL, "lang": "ru-en"}
)
MOSCOW = ZoneInfo("Europe/Moscow")


def fetch_page():
    try:
        return fetch_url(EVENT_URL)
    except urllib.error.HTTPError as error:
        if error.code != 403:
            raise
        # Timepad rejects GitHub-hosted IP addresses. Yandex's translated view
        # preserves the embedded registration data and is reachable from GitHub.
        return fetch_url(TRANSLATE_URL)


def fetch_url(url):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; AppointmentWatcher/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=80) as response:
        if response.status != 200:
            raise RuntimeError(f"Source HTTP {response.status}")
        return response.read().decode("utf-8")


def extract_slots(html, now=None):
    match = re.search(r"\(function\(\)\{\s*return\s+(\{[\s\S]*?\});\s*\}\)\(\)", html)
    if not match:
        raise RuntimeError("Timepad registration data unavailable")
    data = json.loads(match.group(1))
    entries = data.get("recurring_events")
    if not isinstance(entries, list):
        raise RuntimeError("Timepad slot list unavailable")
    now = now or dt.datetime.now(dt.timezone.utc)
    slots = []
    for entry in entries:
        if entry.get("unavaliable") is not False or int(entry.get("tickets_left") or 0) < 1:
            continue
        start = dt.datetime.fromisoformat(entry["date_iso8601"].replace("Z", "+00:00"))
        if start.tzinfo is None:
            raise RuntimeError("Timepad slot has no timezone")
        if start > now:
            slots.append((str(entry["id"]), start.astimezone(MOSCOW)))
    return sorted(slots, key=lambda slot: slot[1])


def deliver(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        os.environ["DELIVERY_URL"], data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 200 or response.read().strip() != b"ok":
                raise RuntimeError("Result delivery rejected")
    except urllib.error.HTTPError:
        raise RuntimeError("Result delivery HTTP error") from None


def main():
    try:
        slots = extract_slots(fetch_page())
        deliver({"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "slots": [
            {"id": slot_id, "start": start.isoformat()} for slot_id, start in slots
        ]})
    except Exception as exc:
        # Callback failures cannot be reported through the same callback.
        print(f"Check failed: {type(exc).__name__}", file=sys.stderr)
        if not isinstance(exc, RuntimeError) or not str(exc).startswith("Result delivery"):
            deliver({"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                     "error": "Timepad unavailable"})
        raise RuntimeError("Appointment check failed") from None
    print(f"Check completed: {len(slots)} available slots")


if __name__ == "__main__":
    main()
