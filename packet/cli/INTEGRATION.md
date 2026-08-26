# `/packet/cli/` — how it plugs into the site

This section is already wired in. This file records what it touches, so the
next person editing the site knows where the seams are.

## What it is

A working Cisco IOS command line in the browser, running on a stateful network
engine, with a library of graded scenario labs. Static, no build step, no
dependencies. Served at `www.wctacyber.org/packet/cli/`.

## What it touches outside this folder

Four things, all small:

| File | Change |
|---|---|
| `assets/cs-core.js` | One entry added to `NAV`: `{ href: 'cli/', label: 'CLI Lab' }`. That is what puts the tab on every page. |
| `data/resources.json` | A new `cli` array, one entry per lab, each with `url: "../cli/?lab=<slug>"`. |
| `resources/index.html` | One entry added to `KINDS` so the labs list on the Resources page. |
| — | Nothing else. No template, no CSS, no build. |

The section uses the site's own machinery rather than its own copies:

- **Chrome.** `index.html` loads `../assets/cs-core.js` and calls
  `PT.mountChrome({ nav: 'CLI Lab' })`, so the brand, nav, profile switcher and
  theme buttons are the shared ones.
- **Themes.** No theme code of its own. `cli.css` derives every colour from the
  tokens in `cs-shell.css`, so all five themes work and a student's `cs_theme`
  follows them here from the drill apps.
- **Profiles.** Progress is stored per active profile (`PT.active()`), under
  `pt_cli_progress_<id>`.
- **Scoreboard.** Finishing a lab calls `PT.recordBest(slug, seconds, meta)`;
  so does a clean 10/10 round of the command drill, under
  `cli-command-drill`. Labs that carry a `gate` also call `PT.recordGate`.

**Class names in `cli.css` that would have collided with `cs-shell.css` are
prefixed `cli-`** (`cli-chip`, `cli-ring`, `cli-fold`, `cli-toast`, `cli-wrap`).
Keep that convention — the site stylesheet is global and unscoped.

### Keeping the two manifests in sync

`cli/cli-labs.json` is what the section reads at runtime. `data/resources.json`
is what the rest of the site reads. They duplicate slug, name and unit on
purpose, the same way `tools/check-data.py` duplicates the round scope: an
accidental edit in one place gets caught instead of silently changing what
students study. `check-data.py` already validates the `cli` array generically
(unique slugs, real units, status/url agreement). A stricter check asserting the
two files agree would be a reasonable addition.

`cli-x1-baseline` is filed under `u5` in `resources.json` because the extension
track has no unit of its own and U5 is where those commands get touched. The two
sandboxes are filed under `u1`.

---

## Tests

```bash
node cli/tests/run.js         # engine: addressing, forwarding, ARP, routing, DHCP, faults
node cli/tests/cli.test.js    # the IOS command line: modes, parsing, help, show output
node cli/tests/labs.test.js   # every lab's own answer key must reach 100%
node cli/tests/e2e.js         # browser: needs playwright
node cli/tests/all.js         # all four
```

`e2e.js` serves all of `packet/` (so `../assets/` resolves) and checks the real
chrome, all five themes, and a full lab driven to 100% through the terminal. It
skips itself with a message if Playwright is absent. On a machine with a
preinstalled Chromium: `CHROMIUM_PATH=/path/to/chrome node cli/tests/e2e.js`.

`labs.test.js` is the one that matters for content work: add a lab, add its
`solution` block, and the suite proves the lab is completable and that the
grader is not rubber-stamping it.

---

## Adding a lab

1. Write `cli/labs/<slug>.json`. Point `topologyRef` at one of the named
   topologies in `labs/topologies.json`, or inline your own `topology`.
2. Layer `config` overrides and `faults` on top — faults are declarative, so
   "wrong mask on PC2" is one line.
3. Write `tasks` as objective predicates over device state. `engine/grader.js`
   lists every check type; `commandUsed` and `commandSequence` are the escape
   hatches for objectives about running a diagnostic rather than changing a
   configuration. Add `"once": true` to a task whose state cannot still be true
   at the end (watch a table fill, then clear it).
4. Write the `solution` block — it is both the coach answer key shown in the
   workbench and the thing the test suite drives.
5. Add the lab to `cli-labs.json` **and** to `data/resources.json`.
6. Run `node cli/tests/labs.test.js` and `python3 tools/check-data.py`.

---

## Known limits

- **Packet Tracer version.** Output text and interface naming follow PT's IOS
  15.x on a 1941 router and a 2960 switch (`GigabitEthernet0/0`, not `0/0/0`).
  If the team runs a build whose device models differ, add a profile to `MODELS`
  in `engine/net.js` and set `model` in the affected topologies. This is open
  item #3 in `roadmap.md` §10 and the one thing here that cannot be verified
  without the actual software.
- **Not in scope, by design:** VLANs and trunking, OSPF, ACLs, NAT/PAT, SSH,
  port security. The command tree has the hooks; nothing is wired. That matches
  `curriculum.md` §9, which puts those in the extension track.
- **Fault locations are readable.** This is a public GitHub Pages site, so a
  student can open `labs/cli-u6-two-faults.json` and see where the faults are.
  Training rather than assessment, so that is probably fine — but if not, move
  the fault labs to coach storage and load them from there.
