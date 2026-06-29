#!/usr/bin/env python3
"""Verify and fix fight durations using Wikipedia official round times."""

from __future__ import annotations

import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIGHTS_PATH = ROOT / "data" / "fights.json"
CACHE_DIR = ROOT / "data" / "wiki_cache"
CTX = ssl.create_default_context()
USER_AGENT = "EntertainingFightsDurationBot/1.0 (fight duration verification)"

# Verified against Wikipedia / official records (not YouTube runtime).
MANUAL = {
    "004": {
        "event": "UFC Fight Night: Lopes vs. Silva",
        "year": 2025,
        "ending": "TKO (spinning back elbow and punches), round 2",
        "endingCategory": "ko",
        "round": 2,
        "time": "4:48",
        "source": "Wikipedia UFC Fight Night: Lopes vs. Silva",
    },
    "015": {
        "ending": "KO (punches), round 1",
        "endingCategory": "ko",
        "round": 1,
        "time": "0:16",
        "source": "Wikipedia UFC 322",
    },
    "020": {
        "event": "UFC 308",
        "year": 2024,
        "ending": "Submission (face crank), round 1",
        "endingCategory": "submission",
        "round": 1,
        "time": "3:34",
        "source": "Wikipedia UFC 308",
    },
    "001": {
        "ending": "TKO, round 11",
        "endingCategory": "ko",
        "round": 11,
        "time": "0:28",
        "source": "Wikipedia / broadcast",
    },
    "010": {
        "ending": "KO, round 5",
        "endingCategory": "ko",
        "round": 5,
        "time": "1:52",
        "source": "Wikipedia Usyk vs Dubois 2",
    },
    "039": {
        "ending": "KO, round 7",
        "endingCategory": "ko",
        "round": 7,
        "time": "1:44",
        "source": "Wikipedia Gervonta Davis vs Ryan Garcia",
    },
    "049": {
        "round": 5,
        "time": "2:59",
        "source": "Wikipedia Michael Conlan vs Luis Alberto Lopez",
    },
    "050": {
        "round": 2,
        "time": "2:45",
        "source": "Wikipedia Inoue vs Donaire II",
    },
    "052": {
        "round": 5,
        "time": "2:59",
        "source": "Wikipedia Prograis vs Zepeda",
    },
    "057": {
        "round": 9,
        "time": "2:59",
        "source": "Wikipedia Lopez vs Kambosos",
    },
    "062": {
        "round": 7,
        "time": "1:39",
        "source": "Wikipedia Deontay Wilder vs Tyson Fury II",
    },
    "104": {
        "round": 2,
        "time": "3:26",
        "event": "Pride 28: High Octane",
        "pride": True,
        "source": "Wikipedia Pride 28",
    },
    "108": {
        "round": 1,
        "time": "6:10",
        "pride_r1_10min": True,
        "source": "Pride 21 (10-minute opening round)",
    },
    "111": {
        "ending": "DQ, round 3",
        "endingCategory": "ko",
        "round": 3,
        "time": "3:00",
        "source": "Wikipedia Holyfield vs Tyson II",
    },
    "124": {"scheduledRounds": 3, "round": None, "source": "ONE muay thai 3x3 min"},
    "129": {"scheduledRounds": 5, "round": None, "source": "ONE muay thai 5x3 min"},
    "131": {"scheduledRounds": 4, "round": None, "source": "K-1 MAX (3+3+3+3 min)"},
    "139": {
        "round": 4,
        "time": "2:25",
        "scheduledRounds": 5,
        "source": "K-1 Hercules '96 (3 min rounds)",
    },
}

PRIDE_10_MIN_R1 = {"Pride 21", "Pride Critical Countdown 2004"}


def get_round_length(sport, event=None, pride_r1_10min=False, round_num=1):
    if pride_r1_10min or (event in PRIDE_10_MIN_R1 and round_num == 1):
        return 600
    if event and "Pride 28" in event:
        return 600 if round_num == 1 else 300
    if sport == "boxing":
        return 180
    if sport in ("kickboxing", "muay thai"):
        return 180
    return 300


def calc_duration(
    sport,
    scheduled_rounds,
    end_round=None,
    end_time_str=None,
    event=None,
    pride_r1_10min=False,
):
    """In-ring elapsed time only (no corner or between-round breaks)."""
    if event and "Pride 28" in event:
        if end_round == 2 and end_time_str:
            parts = end_time_str.split(":")
            return 600 + int(parts[0]) * 60 + int(parts[1])
        if end_round == 1 and end_time_str:
            parts = end_time_str.split(":")
            return int(parts[0]) * 60 + int(parts[1])

    if (pride_r1_10min or event in PRIDE_10_MIN_R1) and end_round == 1:
        if end_time_str:
            parts = end_time_str.split(":")
            return int(parts[0]) * 60 + int(parts[1])
        return 600

    if end_round is None:
        return scheduled_rounds * get_round_length(sport, event, pride_r1_10min)

    rs = get_round_length(sport, event, pride_r1_10min, end_round)
    sec_in_round = rs
    if end_time_str:
        parts = end_time_str.strip().split(":")
        sec_in_round = int(parts[0]) * 60 + int(parts[1])
    return (end_round - 1) * get_round_length(sport, event, pride_r1_10min) + sec_in_round


def fmt_duration(sec):
    return f"{sec // 60}:{sec % 60:02d}"


def fmt_minutes(sec):
    return round(sec / 60, 1)


def clean_name(raw):
    text = re.sub(r"\[\[|\]\]", "", raw)
    text = re.sub(r"\([^)]*\)", "", text)
    if "|" in text:
        text = text.split("|")[-1]
    return text.strip()


def last_name(name):
    parts = re.sub(r"[^a-zA-Z\s'.-]", "", name).split()
    return parts[-1].lower() if parts else ""


def fetch_wiki_text(page):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{page}.json"
    if cache_file.exists():
        age = time.time() - cache_file.stat().st_mtime
        if age < 7 * 86400:
            return json.loads(cache_file.read_text())["wikitext"]

    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "parse", "page": page, "prop": "wikitext", "format": "json"}
    )
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, context=CTX, timeout=30) as resp:
                wikitext = json.load(resp)["parse"]["wikitext"]["*"]
            cache_file.write_text(json.dumps({"wikitext": wikitext}))
            time.sleep(2.5)
            return wikitext
        except Exception:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch Wikipedia page: {page}")


def parse_mma_bouts_wikitext(wikitext):
    bouts = []
    for block in re.findall(r"\{\{MMAevent bout\s*\n(.*?)\n\}\}", wikitext, re.S):
        lines = []
        for line in block.split("\n"):
            line = line.strip()
            if line.startswith("|"):
                line = line[1:]
            if line:
                lines.append(line)
        if len(lines) < 7:
            continue
        f1 = clean_name(lines[1])
        f2 = clean_name(lines[3])
        method = lines[4]
        rnd = int(re.sub(r"\D", "", lines[5]))
        clock = lines[6].strip()
        bouts.append({"f1": f1, "f2": f2, "method": method, "round": rnd, "time": clock})

    # Older UFC pages use a single-line template.
    for block in re.findall(r"\{\{MMAevent bout\|([^}]+)\}\}", wikitext):
        parts = [p.strip() for p in block.split("|")]
        if len(parts) < 7:
            continue
        try:
            def_idx = next(i for i, p in enumerate(parts) if p == "def.")
        except StopIteration:
            continue
        time_idx = None
        for i in range(len(parts) - 1, def_idx, -1):
            if re.match(r"\d+:\d+", parts[i]):
                time_idx = i
                break
        if time_idx is None or time_idx < def_idx + 3:
            continue
        try:
            rnd = int(re.sub(r"\D", "", parts[time_idx - 1]))
            clock = parts[time_idx]
        except ValueError:
            continue
        f1 = clean_name("|".join(parts[1:def_idx]))
        f2 = clean_name(parts[def_idx + 1])
        method = "|".join(parts[def_idx + 2 : time_idx - 1])
        bouts.append({"f1": f1, "f2": f2, "method": method, "round": rnd, "time": clock})

    return bouts


def parse_mma_bouts_markdown(text):
    """Parse Wikipedia results tables from WebFetch / HTML markdown."""
    bouts = []
    for line in text.split("\n"):
        if " def. " not in line or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|") if p.strip()]
        if len(parts) < 7:
            continue
        try:
            def_idx = next(i for i, p in enumerate(parts) if p == "def.")
        except StopIteration:
            continue
        if def_idx < 1 or def_idx + 4 >= len(parts):
            continue
        f1 = clean_name(parts[def_idx - 1])
        f2 = clean_name(parts[def_idx + 1])
        method = parts[def_idx + 2]
        rnd = int(re.sub(r"\D", "", parts[def_idx + 3]))
        clock = parts[def_idx + 4]
        if not re.match(r"\d+:\d+", clock):
            continue
        bouts.append({"f1": f1, "f2": f2, "method": method, "round": rnd, "time": clock})
    return bouts


def parse_wiki_bouts(wikitext):
    bouts = parse_mma_bouts_wikitext(wikitext)
    if not bouts:
        bouts = parse_mma_bouts_markdown(wikitext)
    return bouts


def method_to_ending(method, rnd):
    m = method.lower()
    if "decision" in m:
        return method.split("(")[0].strip() if "(" in method else method, "decision"
    if "submission" in m or "choke" in m:
        return f"{method}, round {rnd}", "submission"
    if "draw" in m:
        return method, "draw"
    if "dq" in m or "disqualification" in m:
        return f"DQ, round {rnd}", "ko"
    return f"{method}, round {rnd}", "ko"


def event_to_wiki_page(event):
    if event == "The Ultimate Fighter 1 Finale":
        return "The_Ultimate_Fighter_1"
    if "Freedom 250" in event:
        return "UFC_Freedom_250"
    if "Lopes vs. Silva" in event or "Lopes vs Silva" in event:
        return "UFC_Fight_Night:_Lopes_vs._Silva"
    if event == "UFC on Fox 29":
        return "UFC_on_Fox:_Poirier_vs._Gaethje"
    if event == "UFC Fight Night 33":
        return "UFC_Fight_Night:_Hunt_vs._Bigfoot"
    m = re.search(r"UFC\s+(\d+)", event)
    if m:
        return f"UFC_{m.group(1)}"
    return None


def match_bout(fight, bout):
    f1 = last_name(fight["fighter1"])
    f2 = last_name(fight["fighter2"])
    b1 = last_name(bout["f1"])
    b2 = last_name(bout["f2"])
    return {f1, f2} == {b1, b2}


def parse_stoppage_from_ending(ending):
    round_match = re.search(r"round\s*(\d+)", ending, re.I)
    if not round_match:
        return None, None
    rnd = int(round_match.group(1))
    time_match = re.search(r"(\d+):(\d+)", ending)
    if time_match:
        return rnd, f"{int(time_match.group(1))}:{int(time_match.group(2)):02d}"
    return rnd, None


def infer_clock_from_stored(stored_sec, rnd, sport, event=None):
    """Derive in-round clock from a stored duration (handles legacy rest-inclusive values)."""
    rs = get_round_length(sport, event)
    rest = 60

    implied = stored_sec - (rnd - 1) * rs
    if 0 < implied <= rs:
        return fmt_duration(implied)

    implied = stored_sec - (rnd - 1) * (rs + rest)
    if 0 < implied <= rs:
        return fmt_duration(implied)

    return fmt_duration(rs)


def load_git_baseline_seconds():
    """One-time helper: read pre-migration durations from git HEAD."""
    import subprocess

    try:
        raw = subprocess.check_output(["git", "show", "HEAD:data/fights.json"], cwd=ROOT, stderr=subprocess.DEVNULL)
        fights = json.loads(raw)["fights"]
        return {f["id"]: round(f["durationMinutes"] * 60) for f in fights}
    except Exception:
        return {}


def apply_fight_time(
    fight,
    end_round,
    end_time,
    ending=None,
    ending_category=None,
    scheduled_rounds=None,
    pride_r1_10min=False,
    event=None,
    year=None,
):
    sr = scheduled_rounds or fight["scheduledRounds"]
    sec = calc_duration(
        fight["sport"],
        sr,
        end_round,
        end_time,
        event or fight.get("event"),
        pride_r1_10min=pride_r1_10min,
    )
    fight["duration"] = fmt_duration(sec)
    fight["durationMinutes"] = fmt_minutes(sec)
    if scheduled_rounds:
        fight["scheduledRounds"] = scheduled_rounds
    if ending:
        fight["ending"] = ending
    if ending_category:
        fight["endingCategory"] = ending_category
    if event:
        fight["event"] = event
    if year is not None:
        fight["year"] = year


def main():
    with FIGHTS_PATH.open() as f:
        data = json.load(f)

    pages = sorted({event_to_wiki_page(fight["event"]) for fight in data["fights"] if event_to_wiki_page(fight["event"])})
    wiki_bouts = {}
    for page in pages:
        try:
            wikitext = fetch_wiki_text(page)
            wiki_bouts[page] = parse_wiki_bouts(wikitext)
            print(f"Loaded {len(wiki_bouts[page])} bouts from {page}")
        except Exception as exc:
            print(f"WARN: {page}: {exc}")
            wiki_bouts[page] = []

    updated = []
    unmatched = []
    git_baseline = load_git_baseline_seconds()

    for fight in data["fights"]:
        fid = fight["id"]
        old = fight["duration"]

        if fid in MANUAL:
            m = MANUAL[fid]
            sr = m.get("scheduledRounds", fight["scheduledRounds"])
            rnd = m.get("round")
            clk = m.get("time")
            ending = m.get("ending")
            cat = m.get("endingCategory")
            if ending is None and rnd is not None and clk:
                ending, cat = method_to_ending(fight["ending"].split(",")[0], rnd)
            apply_fight_time(
                fight,
                rnd,
                clk,
                ending=ending,
                ending_category=cat,
                scheduled_rounds=sr,
                pride_r1_10min=m.get("pride_r1_10min", False),
                event=m.get("event"),
                year=m.get("year"),
            )
            if fight["duration"] != old or m.get("ending") or m.get("event"):
                updated.append((fid, old, fight["duration"], m.get("source", "manual")))
            continue

        page = event_to_wiki_page(fight["event"])
        if fight["sport"] == "mma" and page and wiki_bouts.get(page):
            matched = next((b for b in wiki_bouts[page] if match_bout(fight, b)), None)
            if matched:
                ending, cat = method_to_ending(matched["method"], matched["round"])
                if cat in ("decision", "draw"):
                    apply_fight_time(fight, None, None, ending=ending, ending_category=cat)
                else:
                    apply_fight_time(fight, matched["round"], matched["time"], ending=ending, ending_category=cat)
                if fight["duration"] != old:
                    updated.append((fid, old, fight["duration"], f"Wikipedia {page}"))
                continue

        ending_lower = fight["ending"].lower()
        if any(x in ending_lower for x in ("decision", "draw")) and "round" not in ending_lower:
            apply_fight_time(fight, None, None)
            if fight["duration"] != old:
                updated.append((fid, old, fight["duration"], "in-ring (decision)"))
            continue

        rnd, clk = parse_stoppage_from_ending(fight["ending"])
        if rnd:
            if clk is None:
                stored = git_baseline.get(fid, round(fight["durationMinutes"] * 60))
                clk = infer_clock_from_stored(stored, rnd, fight["sport"], fight.get("event"))
            apply_fight_time(fight, rnd, clk)
            if fight["duration"] != old:
                updated.append((fid, old, fight["duration"], "in-ring (from ending)"))
            continue

        unmatched.append(fid)

    with FIGHTS_PATH.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"\nUpdated {len(updated)} fights:")
    for fid, old, new, src in updated:
        print(f"  {fid}: {old} -> {new} ({src})")
    if unmatched:
        print(f"\nUnmatched (kept existing duration): {len(unmatched)} — {', '.join(unmatched)}")


if __name__ == "__main__":
    main()
