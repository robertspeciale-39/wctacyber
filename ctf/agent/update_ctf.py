#!/usr/bin/env python3
"""
WCTA CTF Calendar agent.

Re-runs the CTF search and rewrites ctf/events.json. It never touches the page
itself, so it cannot change how www.wctacyber.org/ctf works, only what it lists.

  python ctf/agent/update_ctf.py            # full run (needs ANTHROPIC_API_KEY)
  python ctf/agent/update_ctf.py --dry-run  # show what would change, write nothing
  python ctf/agent/update_ctf.py --no-llm   # no API key: prune ended events + fix dead links only

Standard library only. No pip install needed.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "events.json"
MODEL = os.environ.get("CTF_AGENT_MODEL", "claude-sonnet-5")
MAX_SEARCHES = int(os.environ.get("CTF_AGENT_MAX_SEARCHES", "30"))
UA = "Mozilla/5.0 (compatible; wctacyber-ctf-agent/1.0; +https://www.wctacyber.org/ctf)"

ENUMS = {
    "status": {"confirmed", "expected"},
    "mode": {"online", "hybrid", "in-person"},
    "eligibility": {"hs-only", "hs-division", "open"},
    "level": {"beginner", "mixed", "advanced"},
}
FIELDS = ["id", "name", "host", "url", "month", "start", "end", "status", "format",
          "mode", "location", "eligibility", "level", "summary", "ctftime"]
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH = re.compile(r"^\d{4}-\d{2}$")
LOG = []


def log(msg):
    print(msg)
    LOG.append(msg)


# ─── HTTP ────────────────────────────────────────────────────────────────────
def http(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def link_alive(url):
    """Dead = DNS/connection failure, 404/410, or 5xx. Bot blocks (401/403/429) count as alive."""
    for _ in range(2):
        try:
            status, _ = http(url, timeout=20)
            return status < 400
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 429):
                return True
            if e.code in (404, 410):
                return False
        except Exception:
            pass
    return False


# ─── CTFtime candidates ──────────────────────────────────────────────────────
def ctftime_candidates(today, end):
    """US-hosted events in the window that are online, or onsite in Las Vegas."""
    t0 = int(dt.datetime.combine(today, dt.time()).timestamp())
    t1 = int(dt.datetime.combine(end, dt.time(23, 59)).timestamp())
    _, body = http(f"https://ctftime.org/api/v1/events/?limit=1000&start={t0}&finish={t1}")
    events, countries, out = json.loads(body), {}, []
    for e in events:
        if e.get("restrictions") not in ("Open", "High-school"):
            continue
        if e.get("onsite") and "las vegas" not in (e.get("location") or "").lower():
            continue
        for o in e.get("organizers", []):
            if o["id"] not in countries:
                try:
                    countries[o["id"]] = json.loads(http(f"https://ctftime.org/api/v1/teams/{o['id']}/")[1]).get("country", "")
                except Exception:
                    countries[o["id"]] = ""
        if not any(countries[o["id"]] == "US" for o in e.get("organizers", [])):
            continue
        out.append({
            "title": e["title"], "start": e["start"], "finish": e["finish"], "url": e["url"],
            "ctftime": e["ctftime_url"], "restrictions": e["restrictions"], "format": e["format"],
            "onsite": e["onsite"], "location": e.get("location", ""),
            "organizers": [o["name"] for o in e.get("organizers", [])],
            "description": (e.get("description") or "")[:700],
        })
    return out


# ─── Claude ──────────────────────────────────────────────────────────────────
SYSTEM = """You maintain the CTF competition calendar for a U.S. high school cybersecurity club
(West Career & Technical Academy, Las Vegas, NV). You update a JSON list of events. Use web search to verify.

WHAT QUALIFIES (every rule is required):
1. Hosted by a U.S. organization (university, school, nonprofit, company, conference, or government).
2. Free to enter.
3. High school students are allowed to compete. Acceptable: built for high school; has a high school
   division/bracket/scoreboard; or open to anyone with no college-only, .edu-email, 18+, or invite-only rule.
   Exclude college-only events, events requiring a .edu address, 18+ events, and prequalified/invite-only finals.
   If you cannot confirm high schoolers may compete, do NOT add the event.
4. Playable remotely (online, or hybrid with full online play). The only in-person events allowed are in
   Las Vegas, Nevada.
5. Takes place (or starts) on or before the window end date.

YOUR JOB:
- For each "expected" event, search whether this season's dates are announced. If so, set status
  "confirmed" with start/end and the new official url. If still unannounced, keep it expected.
- For each "confirmed" event, check for postponements, cancellations, or date changes.
- Add newly announced qualifying events, using the CTFtime candidates plus your own searches
  (high-school CTFs such as CYBER.ORG, picoCTF, university high school outreach CTFs, and Las Vegas events).
- Remove an event only if it is cancelled or you found it no longer qualifies. Give the reason.
- Do not add events you only half-verified. Never invent dates, URLs, or rules.

EVENT FORMAT (every field required, same keys as the input):
id           stable slug, keep existing ids; new ids like "name-2027"
name, host   plain text
url          official event site (https). If the official site is not up, use the CTFtime page.
month        "YYYY-MM" of the start (or expected start)
start, end   "YYYY-MM-DD" for confirmed events (dates in U.S. Eastern time); null for expected
status       "confirmed" (dates published) or "expected" (dates not published; month from last year)
last_held    for expected events only, e.g. "Mar 9-19, 2026"; omit for confirmed
format       short, e.g. "Jeopardy", "Attack-Defense", "Jeopardy + coding"
mode         "online" | "hybrid" | "in-person"
location     "" for online; e.g. "Online + Newark, NJ" or "Las Vegas, NV"
eligibility  "hs-only" | "hs-division" | "open"
level        "beginner" | "mixed" | "advanced"
summary      1-2 plain sentences, under 240 characters, written for students and their coach.
             Say what matters: who it is for, key times, anything unusual. No hype.
ctftime      CTFtime event or CTF page url, or ""

REPLY with a short note, then exactly one block:
<events_json>{"events": [ ...every event to keep... ],
 "changes": [{"id": "...", "action": "added|updated|removed", "reason": "..."}]}</events_json>
Only list real changes in "changes"."""


def call_claude(system, user, api_key):
    """One Messages API turn with web search, following pause_turn continuations."""
    messages = [{"role": "user", "content": user}]
    texts = []
    for _ in range(10):
        body = json.dumps({
            "model": MODEL, "max_tokens": 20000, "system": system, "messages": messages,
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": MAX_SEARCHES}],
        }).encode()
        _, raw = http("https://api.anthropic.com/v1/messages", data=body, timeout=600, headers={
            "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        resp = json.loads(raw)
        texts += [b["text"] for b in resp["content"] if b.get("type") == "text"]
        if resp.get("stop_reason") == "pause_turn":
            messages.append({"role": "assistant", "content": resp["content"]})
            continue
        if resp.get("stop_reason") == "max_tokens":
            raise RuntimeError("Claude hit max_tokens before finishing the list")
        return "".join(texts)
    raise RuntimeError("Too many pause_turn continuations")


def extract(text):
    m = re.search(r"<events_json>\s*(\{.*\})\s*</events_json>", text, re.S)
    if not m:
        raise ValueError("No <events_json> block in Claude's reply")
    out = json.loads(m.group(1))
    return out.get("events", []), out.get("changes", [])


# ─── Validation + merge ──────────────────────────────────────────────────────
def problems(ev, window_end):
    p = [f"missing {k}" for k in FIELDS if k not in ev]
    if p:
        return p
    for k, allowed in ENUMS.items():
        if ev[k] not in allowed:
            p.append(f"bad {k}: {ev[k]!r}")
    if not re.match(r"^https?://", ev["url"] or ""):
        p.append("url must be http(s)")
    if not MONTH.match(ev["month"] or ""):
        p.append("bad month")
    elif ev["month"] > window_end[:7]:
        p.append("outside window")
    if ev["status"] == "confirmed":
        if not (DATE.match(ev["start"] or "") and DATE.match(ev["end"] or "")):
            p.append("confirmed needs start and end dates")
        elif ev["end"] < ev["start"]:
            p.append("end before start")
        elif ev["start"][:7] != ev["month"]:
            p.append("month does not match start")
    elif ev["start"] or ev["end"]:
        p.append("expected events must have null start/end")
    if not ev["summary"] or len(ev["summary"]) > 320:
        p.append("summary empty or too long")
    for k in ("name", "host", "format"):
        if not str(ev[k]).strip():
            p.append(f"empty {k}")
    return p


def ended(ev, today):
    if ev["status"] == "confirmed":
        return (ev.get("end") or ev.get("start")) < today.isoformat()
    return ev["month"] < today.isoformat()[:7]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def merge(old, proposed, changes, today, window_end, excluded=()):
    """Accept valid proposals; keep the old version when a proposal is invalid or removed without reason."""
    old_by_id = {e["id"]: e for e in old}
    blocked = [norm(x["name"]) for x in excluded]
    reasons = {c.get("id"): c for c in changes if c.get("action") == "removed" and c.get("reason")}
    result, seen = [], set()
    for ev in proposed:
        eid = ev.get("id")
        if not eid or eid in seen:
            log(f"- skipped proposal with missing/duplicate id: {eid!r}")
            continue
        issues = problems(ev, window_end)
        if eid not in old_by_id and any(b and b in norm(ev.get("name", "")) for b in blocked):
            log(f"- rejected new event `{eid}`: on the excluded list")
            continue
        if issues:
            if eid in old_by_id:
                log(f"- kept previous version of `{eid}` (proposal invalid: {'; '.join(issues)})")
                result.append(old_by_id[eid])
            else:
                log(f"- rejected new event `{eid}`: {'; '.join(issues)}")
            continue
        seen.add(eid)
        result.append({k: ev[k] for k in FIELDS + (["last_held"] if ev["status"] == "expected" and ev.get("last_held") else [])})
    for eid, ev in old_by_id.items():
        if eid in seen or any(r["id"] == eid for r in result):
            continue
        if eid in reasons or ended(ev, today):
            log(f"- removed `{eid}`: {reasons[eid]['reason'] if eid in reasons else 'ended'}")
        else:
            log(f"- kept `{eid}` (agent dropped it without a reason)")
            result.append(ev)
    return result


def prune(events, today):
    """Drop events that ended more than 30 days ago so the file stays tidy."""
    cutoff = today - dt.timedelta(days=30)
    keep = []
    for ev in events:
        if ended(ev, cutoff):
            log(f"- pruned `{ev['id']}` (ended over 30 days ago)")
        else:
            keep.append(ev)
    return keep


def fix_links(events):
    for ev in events:
        if not link_alive(ev["url"]):
            if ev.get("ctftime") and ev["ctftime"] != ev["url"] and link_alive(ev["ctftime"]):
                log(f"- `{ev['id']}`: {ev['url']} is down, linking to CTFtime instead")
                ev["url"] = ev["ctftime"]
            else:
                log(f"- WARNING `{ev['id']}`: {ev['url']} is unreachable and has no working fallback")


def diff(old, new):
    o, n = {e["id"]: e for e in old}, {e["id"]: e for e in new}
    lines = [f"- added `{i}`: {n[i]['name']}" for i in n if i not in o]
    lines += [f"- removed `{i}`: {o[i]['name']}" for i in o if i not in n]
    for i in n:
        if i in o and n[i] != o[i]:
            keys = [k for k in set(n[i]) | set(o[i]) if n[i].get(k) != o[i].get(k)]
            lines.append(f"- updated `{i}`: {', '.join(sorted(keys))}")
    return lines


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="show changes, write nothing")
    ap.add_argument("--no-llm", action="store_true", help="skip Claude; prune and fix links only")
    ap.add_argument("--force", action="store_true", help="write even if the list shrinks sharply")
    args = ap.parse_args()

    today = dt.date.today()
    data = json.loads(DATA.read_text())
    old = data["events"]
    window_end = data["window"]["end"]
    events = [dict(e) for e in old]

    if not args.no_llm:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            sys.exit("ANTHROPIC_API_KEY is not set. Add it as a repo secret, or run with --no-llm.")
        log("## Search")
        candidates = ctftime_candidates(today, dt.date.fromisoformat(window_end))
        log(f"- {len(candidates)} U.S. CTFtime candidates in window")
        user = (f"Today is {today.isoformat()}. Window ends {window_end}.\n\n"
                f"CURRENT EVENTS:\n{json.dumps(old, indent=1)}\n\n"
                f"EXCLUDED (the coach ruled these out; never add them):\n"
                f"{json.dumps(data.get('excluded', []), indent=1)}\n\n"
                f"CTFTIME CANDIDATES (U.S.-hosted, open or high-school, online or Las Vegas):\n"
                f"{json.dumps(candidates, indent=1)}")
        proposed, changes = extract(call_claude(SYSTEM, user, key))
        for c in changes:
            log(f"- Claude: {c.get('action')} `{c.get('id')}`: {c.get('reason', '')}")
        log("## Checks")
        events = merge(old, proposed, changes, today, window_end, data.get("excluded", []))

    events = prune(events, today)
    fix_links(events)
    events.sort(key=lambda e: (e["month"], e["status"] != "confirmed", e.get("start") or "", e["name"]))

    if len(events) < 0.6 * len(old) and not args.force:
        log(f"ABORTED: list would shrink from {len(old)} to {len(events)} events. Nothing written. "
            f"Re-run with --force if this is correct.")
        summary()
        sys.exit(1)

    changes = diff(old, events)
    log("## Result")
    log("\n".join(changes) if changes else "- no event changes")
    if args.dry_run:
        log("- dry run: events.json not written")
    else:
        data["events"] = events
        data["updated"] = today.isoformat()
        DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        log(f"- wrote {len(events)} events to ctf/events.json")
    summary()


def summary():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("# CTF Calendar Agent\n\n" + "\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
