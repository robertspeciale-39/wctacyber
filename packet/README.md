# packet

The Cisco Networking Challenge curriculum hub for the West CTA CyberPatriot team.
Static site, no build step, no dependencies. Deploys to
**https://www.wctacyber.org/packet/**

---

## Deploying it the first time

1. Create a repo named exactly **`packet`** in the same GitHub account that owns the
   `wctacyber.org` Pages site.
2. Push these files to the default branch.
3. Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
4. Wait a minute, then open `https://www.wctacyber.org/packet/`.

GitHub serves project repos under the user site's custom domain automatically, so there is
no DNS to configure and no certificate to wait for. Nothing here needs a `CNAME` file.

To verify:

```bash
curl -sI https://www.wctacyber.org/packet/ | head -1     # expect 200
```

If you get a 404, the Pages build has not finished or the repo name is not `packet`.

---

## Updating content

Almost everything is data. These are the files you edit; nothing else needs to change and
nothing gets rebuilt.

| Want to… | Edit | Notes |
|---|---|---|
| **Add a video** | `data/videos.json` | Add an object under the module number. Format is documented at the top of the file. |
| **Mark an app/lab/quiz/sheet as built** | `data/resources.json` | Flip `status` to `"done"` and set `url`. It appears everywhere at once. |
| **Set the round dates** | `data/rounds.json` | Set `date` to `YYYY-MM-DD`. The countdown turns on by itself. |
| **Fix the round scope** | `data/rounds.json` **and** `tools/check-data.py` | See the warning below. |
| **Add an explainer** | `content/module-NN.html` | Zero-padded, e.g. `module-08.html`. Then set `"explainer": true` on that module in `data/modules.json`. HTML fragment only, no `<html>` or `<body>`. |
| **Correct a module's objectives, vocab, commands** | `data/modules.json` | |
| **Change a unit's mastery gate or attached assets** | `data/units.json` | |
| **Add an external link** | `data/links.json` | |

### Adding a drill app

Drop the app's folder from `cyberspesh-app` into `apps/<slug>/index.html`, then set that
slug's `status` and `url` in `data/resources.json`:

```json
{ "slug": "binary-blitz", "status": "done", "url": "../apps/binary-blitz/" }
```

The module page will embed the first built app for that unit in an iframe automatically.

Apps can report a personal best to the scoreboard. From inside an app:

```js
if (window.parent && window.parent.PT) window.parent.PT.recordBest('binary-blitz', seconds);
```

Guard it like that so the app still works when opened standalone.

---

## ⚠️ The round scope table

`data/rounds.json` is the load-bearing assumption of this whole site. Every priority, every
readiness ring, and the entire unit ordering come from it. It is reconstructed from published
CyberPatriot progression, **not** from official coach materials.

**Confirm it against coach materials when each season posts.** If it changes, update both
`data/rounds.json` and the `EXPECTED_ROUND_SCOPE` constant in `tools/check-data.py`, then run
the checks below. The duplication is deliberate: it means an accidental edit to the data gets
caught instead of silently changing what students study.

The non-obvious part, which is correct as written: **scope is cumulative.** The State Round
row in the source table reads "Modules 1–17", but Modules 21–22 unlocked at Round 2 and never
leave, so State is 1–17 plus 21–22.

---

## Checking your work

```bash
python3 tools/check-data.py          # data integrity, exits non-zero on failure
python3 -m http.server 8899          # serve it
node tools/e2e.js http://localhost:8899   # 34 browser checks
```

`check-data.py` verifies all 23 modules exist exactly once, that the units partition them with
no gaps or overlaps, that rounds are cumulative and match the expected scope, that every
referenced asset slug exists, and that every video URL is a well-formed YouTube link.

`e2e.js` drives a real browser: round filtering against the expected scope, profile isolation,
readiness maths, every route, the accessibility floor, and horizontal scroll at 380/820/1920.

Open the site with `file://` and it will tell you to use a server instead. The browser blocks
`fetch` of local JSON, so the data layer cannot load.

---

## Layout

```
index.html          hub: round selector, readiness ring, 23-module grid
module/             template, ?m=13
unit/               template, ?u=u5
videos/             all videos grouped by module
scoreboard/         local profiles, projector mode
resources/          everything built, plus external links
coach/              round scope card, pacing, build status
sheets/             printable cheat sheets
content/            explainer fragments, one per module
data/               the manifests. This is the site.
assets/             cs-shell.css (Design System v3) · cs-core.js · hub.js
apps/               drill apps, dropped in from cyberspesh-app
labs/               lab guides rendered to HTML
tools/              check-data.py, e2e.js. Dev only, never served to students.
```

Routing is query-string on purpose: one template file instead of 23, and a `videos.json` edit
shows up on commit with nothing to regenerate.

---

## Design

`assets/cs-shell.css` is CyberSpesh Design System v3, extracted verbatim from
`cyberspesh-app/assets/app-shell.html` (Part 1) with the hub's own components built from the
same tokens (Part 2). The five themes and the shared `cs_theme` localStorage key mean a
student's theme choice follows them from the hub into every drill app.

**Do not put raw colour values in Part 2.** Everything resolves through a token. `--hue` is
set per element to one of `--u1`…`--u5` and carries the module's spiral strand, so a student
sees the same colour for the same kind of thinking across all 23 modules.

Two fixes in Part 2 are worth knowing about, because **the base app-shell has the same bugs**
and every drill app inherits them:

- `.shell` has an implicit `auto` grid column, which sizes to max-content and refuses to
  shrink. On a phone that lets a wide topbar drag the whole page sideways. Part 2 pins it to
  `minmax(0, 1fr)`.
- Mobile grid overrides using `1fr` do not collapse below min-content either. They need
  `minmax(0, 1fr)`.

---

## Student data

Progress lives in `localStorage` under `pt_*` keys, in the student's own browser. There is no
account, no server, and nothing leaves the device. A student can hand you a snapshot by
copying their stats code from the scoreboard, and that is the only way their data moves.

Clearing browser data clears their progress. Tell them that once, up front.
