#!/usr/bin/env python3
"""Check Timepad booking on a GitHub-hosted runner and notify one Telegram chat."""

import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

EVENT_URL = "https://cu-events.timepad.ru/event/3219855/"
STATE_FILE = Path("state.json")
MOSCOW = ZoneInfo("Europe/Moscow")
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня",
          "июля", "августа", "сентября", "октября", "ноября", "декабря")


def fetch_page():
    request = urllib.request.Request(
        EVENT_URL,
        headers={"User-Agent": "Mozilla/5.0 (compatible; AppointmentWatcher/1.0)"},
    )
    with urllib.request.urlopen(request, timeout=80) as response:
        if response.status != 200:
            raise RuntimeError(f"Timepad HTTP {response.status}")
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


def report(slots):
    if not slots:
        return "Сейчас доступных слотов к психологу нет.\n" + EVENT_URL
    lines = ["Доступные слоты к психологу (МСК):"]
    for _, start in slots:
        lines.append(f"{start.day} {MONTHS[start.month - 1]}, {start:%H:%M}")
    lines.append("Запись: " + EVENT_URL)
    return "\n".join(lines)


def signature(slots):
    raw = "|".join(f"{slot_id}:{start.isoformat()}" for slot_id, start in slots)
    return hashlib.sha256(raw.encode()).hexdigest()


def send_telegram(message):
    token = os.environ["BOT_TOKEN"]
    chat_id = os.environ["CHAT_ID"]
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": message}).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
        if response.status != 200 or result.get("ok") is not True:
            raise RuntimeError("Telegram send failed")


def main():
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    try:
        slots = extract_slots(fetch_page())
        current = signature(slots)
        if os.environ.get("FORCE_REPORT") == "true" or state.get("error") or state.get("signature") != current:
            send_telegram(report(slots))
        state = {"signature": current, "error": False,
                 "last_checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    except Exception as exc:
        # Never print the bot token or private chat ID to workflow logs.
        print(f"Check failed: {type(exc).__name__}", file=sys.stderr)
        if not state.get("error"):
            send_telegram("Не удалось проверить запись на Timepad. Повторю при следующем запуске.")
        state["error"] = True
        state["last_checked_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        raise
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    print(f"Check completed: {len(slots)} available slots")


if __name__ == "__main__":
    main()
