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
- **No scoring, no progress, no profiles.** A task is done or it is not, and
  that state lives in the running lab only. Nothing is written to
  `localStorage`, nothing is reported to the scoreboard, and no profile is
  read. A class shares these machines with nobody signed in, so a stored
  "best" would have been somebody else's — see *Why there is no score* below.

**Class names in `cli.css` that would have collided with `cs-shell.css` are
prefixed `cli-`** (`cli-chip`, `cli-count`, `cli-fold`, `cli-toast`, `cli-wrap`).
Keep that convention — the site stylesheet is global and unscoped.

## Why there is no score

Earlier versions kept a percentage, per-task points, a progress ring and a
personal best per student profile. All of it is gone.

The labs are used by a whole class on shared machines with no sign-in, so a
saved "best" belonged to whoever sat down last, and a percentage invited
students to optimise the number rather than finish the network. What is left
is the checklist: each task ticks when the network really satisfies it, and a
plain "3 of 8 done" above the list.

`grade()` returns `{ tasks, done, complete }`. There is no `percent`, no
`earned`, no `total` and no `points` on a task. Do not add them back without a
reason that survives the shared-machine problem.

## How a task ticks

Objectives are graded against device state, never against what was typed —
with one deliberate exception, the objectives that are *about* running a
diagnostic (`commandUsed`, `commandSequence`, `helpUsed`).

Those grade against the **canonical** command: the fully spelled-out form the
parser resolved after walking the command tree. Two consequences, both
intended:

- A legal abbreviation counts. `sh ip int br` is recorded as
  `show ip interface brief`, because typing abbreviations fast is a real
  competition skill.
- A command that did not parse counts for nothing. `show ipp route` produces a
  caret error, never reaches the transcript, and can never satisfy an
  objective — no matter how much of the right command it contains.

So a lab file names the whole command:

```json
{ "type": "commandUsed", "device": "R1", "cmd": "show ip interface brief" }
{ "type": "commandUsed", "device": "R1", "anyOf": ["show ip route", "show ip route static"] }
{ "type": "commandUsed", "device": "PC1", "re": "^ping 192\\.168\\.10\\.\\d+$" }
```

`re` is matched against the canonical form too, and is anchored at both ends
unless the pattern anchors itself. Prefer `cmd` or `anyOf`; reach for `re`
only where the argument genuinely varies.

`labs.test.js` enforces the other half of this: every command in every answer
key must be one the CLI actually accepts.

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

The switching and routing-protocol labs use four unit ids that exist only in
`cli-labs.json` — `v1` VLANs & Trunking, `v2` Inter-VLAN Routing, `s1` Spanning
Tree, `o1` OSPF. `data/units.json` still runs u1–u8, so in `resources.json`
those labs are filed under the unit whose material they extend: `u4` for the
VLAN, inter-VLAN and spanning tree labs, `u7` for the OSPF pair. If the
curriculum grows real units for them, that mapping is the thing to fix.

---

## Tests

```bash
node cli/tests/run.js            # engine: addressing, forwarding, ARP, routing, DHCP, faults
node cli/tests/cli.test.js       # the IOS command line: modes, parsing, help, show output
node cli/tests/switching.test.js # VLANs, trunking, spanning tree, layer 3 switching, OSPF
node cli/tests/labs.test.js      # every lab's answer key must finish every task
node cli/tests/e2e.js            # browser: needs playwright
node cli/tests/all.js            # all five
```

`e2e.js` serves all of `packet/` (so `../assets/` resolves) and checks the real
chrome, all five themes, and a full lab driven through the terminal until every
task is ticked. It blocks external requests, so a machine that cannot reach
Google Fonts still finishes instead of hanging. It skips itself with a message
if Playwright is absent. On a machine with a preinstalled Chromium:
`CHROMIUM_PATH=/path/to/chrome node cli/tests/e2e.js`.

`labs.test.js` is the one that matters for content work: add a lab, add its
`solution` block, and the suite proves three things — the lab is completable,
every command in the answer key is one the CLI accepts, and the grader is not
rubber-stamping a half-finished configuration.

`switching.test.js` is where to add a check when you extend the engine. Every
assertion in it is behavioural: a VLAN that isolates, a trunk that carries, a
spanning tree that blocks exactly one port, a route OSPF really installed.

---

## Adding a lab

1. Write `cli/labs/<slug>.json`. Point `topologyRef` at one of the named
   topologies in `labs/topologies.json`, or inline your own `topology`.
2. Layer `config` overrides and `faults` on top — faults are declarative, so
   "wrong mask on PC2" is one line.
3. Write `tasks` as objective predicates over device state. `engine/grader.js`
   lists every check type — including `vlan`, `accessPort`, `trunkPort`,
   `subInterface`, `svi`, `ipRouting`, `routedPort`, `stpRoot`, `stpPriority`,
   `stpPort`, `stpBlocking`, `ospfProcess`, `ospfInterface`, `ospfNeighbor` and
   `ospfRoute`. `commandUsed`, `commandSequence` and `helpUsed` are the escape
   hatches for objectives about running a diagnostic rather than changing a
   configuration; see *How a task ticks* for what they match. Add
   `"once": true` to a task whose state cannot still be true at the end (watch
   a table fill, then clear it).
   Watch out for a task that asks a student to observe a failure they are about
   to fix: as a state check it un-ticks itself the moment they succeed. Grade
   the diagnostic command instead, or mark the task `once`.
4. Write the `solution` block — it is both the coach answer key shown in the
   workbench and the thing the test suite drives.
5. Add the lab to `cli-labs.json` **and** to `data/resources.json`. Give it a
   `topic` in `cli-labs.json` — that is the second filter row on the picker —
   and use one already in the manifest's `topics` list if it fits.
6. Run `node cli/tests/labs.test.js` and `python3 tools/check-data.py`.

---

## Known limits

- **Packet Tracer version.** Output text and interface naming follow PT's IOS
  15.x on a 1941 router and a 2960 switch (`GigabitEthernet0/0`, not `0/0/0`).
  If the team runs a build whose device models differ, add a profile to `MODELS`
  in `engine/net.js` and set `model` in the affected topologies. This is open
  item #3 in `roadmap.md` §10 and the one thing here that cannot be verified
  without the actual software.
- **Now in scope:** VLANs and trunking (802.1Q, native and allowed VLANs,
  DTP-style negotiation), inter-VLAN routing by dot1Q subinterface or SVI,
  layer 3 switching (`switch-3560`, `ip routing`, `no switchport`), per-VLAN
  spanning tree (root election, port roles and states, priority, cost,
  portfast, BPDU guard), and single-area OSPFv2 (network statements with
  wildcard masks, areas, router IDs, passive interfaces, SPF over interface
  cost, `default-information originate`).
- **Still not in scope, by design:** ACLs, NAT/PAT, SSH, port security, EIGRP,
  multi-area OSPF, VTP. The command tree has room; nothing is wired.
- **Spanning tree does not converge over time.** The tree is recomputed from
  state whenever something asks for it, so a priority change re-elects
  immediately rather than after 30 seconds of listening and learning. The exam
  question is "who is root and why", not "how long did 802.1D take"; if a lab
  ever needs the timers, that is a real change to `engine/stp.js`.
- **OSPF is modelled, not simulated.** Adjacencies and routes are derived from
  the running configuration rather than from hellos and LSAs, so there are no
  DR/BDR elections and no timers to mismatch. Everything a lab grades — wrong
  wildcard mask, wrong area, passive interface, cost-based path selection —
  behaves the way the real protocol would.
- **Fault locations are readable.** This is a public GitHub Pages site, so a
  student can open `labs/cli-u6-two-faults.json` and see where the faults are.
  Training rather than assessment, so that is probably fine — but if not, move
  the fault labs to coach storage and load them from there.
