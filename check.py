#!/usr/bin/env python3
"""Check both CU psychologists on Timepad and deliver one atomic result."""

import concurrent.futures
import datetime as dt
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")
EVENTS = {
    "svetlana": 3219855,
    "lilia": 3558805,
}
DATA_PATTERN = re.compile(r"\(function\(\)\{\s*return\s+(\{[\s\S]*?\});\s*\}\)\(\)")


def fetch_url(url, timeout):
    request = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; CareSlot/2.0)"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"Source HTTP {response.status}")
        return response.read().decode("utf-8")


def parse_event(html, event_id, now=None):
    match = DATA_PATTERN.search(html)
    if not match:
        raise ValueError("Timepad registration data unavailable")
    data = json.loads(match.group(1))
    if data.get("id") != event_id:
        raise ValueError("Wrong Timepad event")
    registration_open = data.get("reg_open")
    entries = data.get("recurring_events")
    if not isinstance(registration_open, bool) or not isinstance(entries, list):
        raise ValueError("Incomplete Timepad registration data")

    now = now or dt.datetime.now(dt.timezone.utc)
    slots = []
    for entry in entries:
        if entry.get("unavaliable") is not False:
            continue
        # Online appointments may have unlimited tickets. Timepad then sends
        # tickets_limited=false and tickets_left=null for bookable child events.
        limited = entry.get("tickets_limited")
        if limited is not False and int(entry.get("tickets_left") or 0) < 1:
            continue
        start = dt.datetime.fromisoformat(entry["date_iso8601"].replace("Z", "+00:00"))
        if start.tzinfo is None:
            raise ValueError("Timepad slot has no timezone")
        if start > now:
            slots.append({"id": str(entry["id"]), "start": start.astimezone(MOSCOW).isoformat()})
    slots.sort(key=lambda slot: slot["start"])
    # Recurring child appointments can be bookable even when the parent event
    # reports reg_open=false. The actual child ticket state takes precedence.
    return {"registration_open": registration_open or bool(slots), "slots": slots}


def check_event(name, event_id):
    event_url = f"https://cu-events.timepad.ru/event/{event_id}/"
    translated_url = "https://translate.yandex.ru/translate?" + urllib.parse.urlencode(
        {"url": event_url, "lang": "ru-en"}
    )
    # Timepad often blocks hosted runners. A short direct attempt keeps /check
    # responsive, then Yandex's translated page supplies the embedded data.
    for url, timeout in ((event_url, 12), (translated_url, 35)):
        try:
            return parse_event(fetch_url(url, timeout), event_id)
        except (OSError, RuntimeError, ValueError, KeyError, TypeError):
            continue
    raise RuntimeError(f"Could not check {name}")


def deliver(payload):
    request = urllib.request.Request(
        os.environ["DELIVERY_URL"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # A changed slot list can fan out to hundreds of subscribers in Apps Script.
    # Allow that paced broadcast to finish before treating the callback as lost.
    with urllib.request.urlopen(request, timeout=270) as response:
        if response.status != 200 or response.read().strip() != b"ok":
            raise RuntimeError("Result delivery rejected")


def main():
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(EVENTS)) as pool:
        futures = {pool.submit(check_event, name, event_id): name for name, event_id in EVENTS.items()}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                results[name] = future.result()
            except Exception as exc:
                # Do not print page content, callback URLs, or credentials.
                print(f"{name} check failed: {type(exc).__name__}", file=sys.stderr)
                results[name] = {"error": "source_unavailable"}

    deliver({"started_at": started_at,
             "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
             "source": os.environ.get("CHECK_SOURCE", ""), "events": results})
    if any("error" in result for result in results.values()):
        raise RuntimeError("One or more appointment checks failed")
    print("Check completed: " + ", ".join(
        f"{name}={len(results[name]['slots'])}" for name in EVENTS
    ))


if __name__ == "__main__":
    main()
