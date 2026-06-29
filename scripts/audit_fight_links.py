#!/usr/bin/env python3
"""Audit YouTube watch links in data/fights.json for broken or misleading videos."""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIGHTS_PATH = ROOT / "data" / "fights.json"
CTX = ssl.create_default_context()
USER_AGENT = "EntertainingFightsLinkAudit/1.0"
REQUEST_DELAY_SEC = 0.35

BAD = re.compile(
    r"(?i)(ea sports|video game|gameplay|ufc \d+ game|ps[45]|xbox|nintendo|"
    r"simulation|virtual|esports|undisputed 3|ufc 4)"
)
CLIP = re.compile(
    r"(?i)(highlights?|best moments|compilation|montage|extended clip|"
    r"fight clip|knockout only|all knockouts|recap|preview|trailer)"
)
GOOD = re.compile(r"(?i)(full fight|free fight|complete fight|entire fight|полный бой)")


def fetch_json(url: str, timeout: int = 25) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_text(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, context=CTX, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_video_id(url: str) -> str | None:
    if not url or "youtube.com/results" in url:
        return None
    match = re.search(r"(?:v=|/embed/|youtu\.be/)([a-zA-Z0-9_-]{11})", url)
    return match.group(1) if match else None


def fetch_video_meta(video_id: str) -> dict:
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    oembed_url = (
        "https://www.youtube.com/oembed?"
        + urllib.parse.urlencode({"url": watch_url, "format": "json"})
    )
    try:
        oembed = fetch_json(oembed_url)
    except urllib.error.HTTPError as err:
        return {
            "ok": False,
            "error": f"oEmbed HTTP {err.code}",
            "title": "",
            "channel": "",
            "duration": 0,
            "categories": [],
        }

    title = oembed.get("title", "")
    channel = oembed.get("author_name", "")
    duration = 0
    categories: list[str] = []

    try:
        html = fetch_text(watch_url)
        length_match = re.search(r'"lengthSeconds"\s*:\s*"(\d+)"', html)
        if not length_match:
            length_match = re.search(r'"lengthSeconds"\s*:\s*(\d+)', html)
        if length_match:
            duration = int(length_match.group(1))
        if '"Gaming"' in html or '"gaming"' in html:
            categories.append("Gaming")
        cat_match = re.search(r'"category"\s*:\s*"([^"]+)"', html)
        if cat_match and cat_match.group(1) not in categories:
            categories.append(cat_match.group(1))
    except Exception as err:  # noqa: BLE001 — keep audit running for other fights
        return {
            "ok": False,
            "error": f"watch page: {err}",
            "title": title,
            "channel": channel,
            "duration": duration,
            "categories": categories,
        }

    return {
        "ok": True,
        "error": "",
        "title": title,
        "channel": channel,
        "duration": duration,
        "categories": categories,
    }


def fighter_in_title(fight: dict, title: str) -> bool:
    tl = title.lower()
    for name in (fight["fighter1"], fight["fighter2"]):
        parts = name.split()
        if parts[-1].lower() in tl or parts[0].lower() in tl:
            return True
    return False


def is_likely_non_english(title: str) -> bool:
    return bool(re.search(r"[\u0400-\u04FF]", title))


def audit_fight(fight: dict) -> dict | None:
    url = fight.get("watchUrl")
    if not url:
        return None

    video_id = extract_video_id(url)
    if not video_id:
        return {
            "id": fight["id"],
            "fighters": f"{fight['fighter1']} vs {fight['fighter2']}",
            "event": fight.get("event", ""),
            "watchUrl": url,
            "videoId": None,
            "issues": ["INVALID_URL"],
            "title": "",
            "channel": "",
            "durationSec": 0,
        }

    meta = fetch_video_meta(video_id)
    issues: list[str] = []
    if not meta["ok"]:
        issues.append(f"FETCH_ERROR: {meta['error']}")

    title = meta["title"]
    channel = meta["channel"]
    duration = meta["duration"]
    categories = meta["categories"]
    expected_sec = int((fight.get("durationMinutes") or 0) * 60)

    if "Gaming" in categories or BAD.search(title) or BAD.search(channel):
        issues.append("GAME_OR_FAKE")
    if CLIP.search(title) and not GOOD.search(title):
        issues.append("LIKELY_CLIP")
    if expected_sec >= 25 * 60 and duration < 15 * 60:
        issues.append(f"TOO_SHORT({duration // 60}m vs ~{expected_sec // 60}m)")
    elif expected_sec >= 15 * 60 and duration < 8 * 60:
        issues.append(f"TOO_SHORT({duration // 60}m vs ~{expected_sec // 60}m)")
    elif expected_sec >= 8 * 60 and duration < expected_sec * 0.4:
        issues.append(f"TOO_SHORT({duration // 60}m vs ~{expected_sec // 60}m)")
    elif duration < 45 and expected_sec > 180:
        issues.append(f"VERY_SHORT({duration}s)")
    if (
        title
        and not is_likely_non_english(title)
        and not fighter_in_title(fight, title)
    ):
        issues.append("NAME_MISMATCH")

    if not issues:
        return None

    return {
        "id": fight["id"],
        "fighters": f"{fight['fighter1']} vs {fight['fighter2']}",
        "event": fight.get("event", ""),
        "watchUrl": url,
        "videoId": video_id,
        "issues": issues,
        "title": title,
        "channel": channel,
        "durationSec": duration,
    }


def load_fights(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)["fights"]


def format_report(issues: list[dict], total_with_urls: int) -> str:
    lines = [
        f"Fight link audit: {len(issues)} issue(s) in {total_with_urls} direct YouTube link(s)",
        "",
    ]
    for row in issues:
        mins, secs = divmod(int(row["durationSec"]), 60)
        lines.append(f"#{row['id']} {row['fighters']} ({row['event']})")
        lines.append(f"  {row['watchUrl']}")
        lines.append(f"  {mins}:{secs:02d} | {row['channel']} | {row['title'][:100]}")
        lines.append(f"  {', '.join(row['issues'])}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json",
        dest="json_path",
        metavar="PATH",
        help="Write machine-readable results to PATH",
    )
    parser.add_argument(
        "--fights",
        type=Path,
        default=FIGHTS_PATH,
        help=f"Path to fights.json (default: {FIGHTS_PATH})",
    )
    args = parser.parse_args()
    fights_path = args.fights

    fights = load_fights(fights_path)
    with_urls = [f for f in fights if f.get("watchUrl")]
    issues: list[dict] = []

    for fight in fights:
        if not fight.get("watchUrl"):
            continue
        row = audit_fight(fight)
        if row:
            issues.append(row)
        time.sleep(REQUEST_DELAY_SEC)

    payload = {
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fightsWithUrls": len(with_urls),
        "issueCount": len(issues),
        "issues": issues,
    }

    report = format_report(issues, len(with_urls))
    print(report, end="")

    if args.json_path:
        Path(args.json_path).parent.mkdir(parents=True, exist_ok=True)
        with Path(args.json_path).open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")

    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
