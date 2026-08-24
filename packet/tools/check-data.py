#!/usr/bin/env python3
"""
Manifest integrity checker for the packet site.

Run from the repo root:   python3 tools/check-data.py

Dev-only. Never runs in the browser. Exits non-zero on any failure so it can go
in a pre-commit hook or a GitHub Action.

The load-bearing check is ROUND SCOPE: the module set each round exposes must
match cisco-module-map.md section 2 exactly. Every priority on the roadmap and
every readiness ring on the site is derived from it. If that table drifts, the
whole site is quietly wrong, so it is asserted against a hardcoded expectation
here rather than trusted.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load(name: str):
    p = DATA / name
    if not p.exists():
        err(f"{name}: missing")
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError as e:
        err(f"{name}: invalid JSON at line {e.lineno} col {e.colno} — {e.msg}")
        return None


# --------------------------------------------------------------------------
# Expected round scope. Source: cisco-module-map.md section 2.
# Scope is CUMULATIVE, which is why state carries 21-22 forward even though its
# own row in the source table reads "1-17".
# --------------------------------------------------------------------------
EXPECTED_ROUND_SCOPE = {
    "practice": {1, 2},
    "r1": set(range(1, 8)),
    "r2": set(range(1, 12)) | {21, 22},
    "state": set(range(1, 18)) | {21, 22},
    "semis": set(range(1, 24)),
}

# Expected unit -> module mapping. Source: curriculum.md section 5.
EXPECTED_UNIT_MODULES = {
    "u1": [1, 2],
    "u2": [3, 4, 5, 6, 7],
    "u3": [8, 9, 10, 11],
    "u4": [21, 22],
    "u5": [12, 13, 14],
    "u6": [15, 16, 17],
    "u7": [18, 19, 20, 23],
    "u8": [],
}

YT = re.compile(
    r"^https://(www\.)?(youtube\.com/(watch\?v=[\w-]{11}|playlist\?list=[\w-]+|embed/[\w-]{11})|youtu\.be/[\w-]{11})"
)


def main() -> int:
    rounds = load("rounds.json")
    units = load("units.json")
    modules = load("modules.json")
    resources = load("resources.json")
    videos = load("videos.json")
    load("links.json")

    if errors:
        report()
        return 1

    # ---- modules: all 23, exactly once ------------------------------------
    mods = modules["modules"]
    nums = [m["n"] for m in mods]
    if sorted(nums) != list(range(1, 24)):
        missing = sorted(set(range(1, 24)) - set(nums))
        dupes = sorted({n for n in nums if nums.count(n) > 1})
        if missing:
            err(f"modules.json: missing module(s) {missing}")
        if dupes:
            err(f"modules.json: duplicate module(s) {dupes}")

    by_n = {m["n"]: m for m in mods}
    valid_strands = set(rounds["strands"])
    for m in mods:
        if m["strand"] not in valid_strands:
            err(f"module {m['n']}: unknown strand {m['strand']!r}")
        if m["unit"] not in units["units"]:
            err(f"module {m['n']}: unknown unit {m['unit']!r}")
        if not m.get("objectives"):
            warn(f"module {m['n']}: no objectives")
        if not m.get("vocab"):
            warn(f"module {m['n']}: no vocabulary")
        if m.get("explainer") and not (ROOT / "content" / f"module-{m['n']:02d}.html").exists():
            err(f"module {m['n']}: explainer:true but content/module-{m['n']:02d}.html is missing")
        if not m.get("explainer") and (ROOT / "content" / f"module-{m['n']:02d}.html").exists():
            warn(f"module {m['n']}: explainer file exists but explainer:false — flip it to show up")

    # ---- units: partition modules 1-23 with no gaps or overlaps -----------
    seen: dict[int, str] = {}
    for uid, u in units["units"].items():
        if u["modules"] != EXPECTED_UNIT_MODULES.get(uid):
            err(
                f"unit {uid}: modules {u['modules']} != curriculum.md section 5 "
                f"expectation {EXPECTED_UNIT_MODULES.get(uid)}"
            )
        for n in u["modules"]:
            if n in seen:
                err(f"module {n} claimed by both {seen[n]} and {uid}")
            seen[n] = uid
        for p in u.get("prereq", []):
            if p not in units["units"]:
                err(f"unit {uid}: unknown prereq {p!r}")
        if u["unlock"] not in rounds["rounds"]:
            err(f"unit {uid}: unknown unlock round {u['unlock']!r}")
    uncovered = sorted(set(range(1, 24)) - set(seen))
    if uncovered:
        err(f"units.json: module(s) {uncovered} belong to no unit")

    # ---- modules.json and units.json must agree both directions ----------
    for uid, u in units["units"].items():
        for n in u["modules"]:
            if n in by_n and by_n[n]["unit"] != uid:
                err(f"module {n}: units.json puts it in {uid}, modules.json says {by_n[n]['unit']}")

    # ---- ROUND SCOPE: the load-bearing check ------------------------------
    for rid, r in rounds["rounds"].items():
        got = set(r["modules"])
        want = EXPECTED_ROUND_SCOPE.get(rid)
        if want is None:
            err(f"rounds.json: unexpected round {rid!r}")
            continue
        if got != want:
            err(
                f"ROUND SCOPE DRIFT — {rid}: extra={sorted(got - want)} "
                f"missing={sorted(want - got)}. Check against cisco-module-map.md section 2."
            )
        # a round's units must be exactly the units whose modules it fully covers
        for uid in r["units"]:
            if uid not in units["units"]:
                err(f"round {rid}: unknown unit {uid!r}")
                continue
            um = set(units["units"][uid]["modules"])
            if um and not um <= got:
                err(f"round {rid}: lists unit {uid} but does not cover its modules {sorted(um - got)}")

    # rounds must be cumulative
    order = rounds["order"]
    for a, b in zip(order, order[1:]):
        sa, sb = set(rounds["rounds"][a]["modules"]), set(rounds["rounds"][b]["modules"])
        if not sa <= sb:
            err(f"rounds are not cumulative: {b} drops {sorted(sa - sb)} that {a} had")

    for rid, r in rounds["rounds"].items():
        d = r.get("date")
        if d is None:
            warn(f"round {rid}: no date set — the countdown stays off until you fill it in")
        elif not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            err(f"round {rid}: date {d!r} is not YYYY-MM-DD")

    # ---- resources: slug uniqueness, unit validity, url presence ---------
    slugs: dict[str, str] = {}
    for kind, items in resources.items():
        if kind.startswith("_"):
            continue
        for it in items:
            s = it["slug"]
            if s in slugs:
                err(f"resources.json: duplicate slug {s!r} in {kind} and {slugs[s]}")
            slugs[s] = kind
            if it["unit"] not in units["units"]:
                err(f"resource {s}: unknown unit {it['unit']!r}")
            if it["status"] not in ("todo", "wip", "done"):
                err(f"resource {s}: bad status {it['status']!r}")
            if it["status"] == "done" and not it.get("url"):
                err(f"resource {s}: status done but no url")
            if it["status"] != "done" and it.get("url"):
                warn(f"resource {s}: has a url but status is {it['status']!r}")

    # every slug a unit references must exist
    for uid, u in units["units"].items():
        for key in ("apps", "labs", "sheets"):
            for s in u.get(key, []):
                if s not in slugs:
                    err(f"unit {uid}: references unknown {key[:-1]} {s!r}")
        q = u.get("quiz")
        if q and q not in slugs:
            err(f"unit {uid}: references unknown quiz {q!r}")

    # ---- videos ----------------------------------------------------------
    vm = videos["byModule"]
    if sorted(int(k) for k in vm) != list(range(1, 24)):
        err("videos.json: byModule must have a key for every module 1-23")
    total = 0
    for k, vids in vm.items():
        for v in vids:
            total += 1
            if not v.get("title") or not v.get("url"):
                err(f"videos.json module {k}: an entry is missing title or url")
                continue
            if not YT.match(v["url"]):
                err(f"videos.json module {k}: {v['url']!r} is not a well-formed YouTube URL")
            if "start" in v and not isinstance(v["start"], int):
                err(f"videos.json module {k}: `start` must be seconds as an integer")
    if total == 0:
        warn("videos.json: empty — every module renders the 'no videos yet' placeholder")

    report()
    return 1 if errors else 0


def report() -> None:
    for w in warnings:
        print(f"  warn  {w}")
    for e in errors:
        print(f"  FAIL  {e}")
    print()
    if errors:
        print(f"{len(errors)} error(s), {len(warnings)} warning(s)")
    else:
        print(f"OK — data layer consistent. {len(warnings)} warning(s).")


if __name__ == "__main__":
    sys.exit(main())
