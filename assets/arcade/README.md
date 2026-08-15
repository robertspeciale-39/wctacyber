# WCTA Arcade

A hidden maze game on the index page. Click the `[ ? ]` in the footer, work out
the terminal command, and it opens.

**The answer is `sudo pacman -S ghosts`.** The joke is that `pacman` is Arch
Linux's real package manager — so the puzzle teaches a command students will
meet again. Wrong guesses get graded replies (`apt` is told it's the wrong
distribution, a missing `sudo` is told it isn't root), and hints appear after
four and eight attempts.

---

## Files

| File | Size | What it is |
|---|---|---|
| `unlock.js` | ~9 KB | The gate. The **only** file `index.html` loads. |
| `arcade.css` | ~5 KB | Overlay, terminal and scoreboard styling. |
| `mazes.js` | ~7 KB | The five maze layouts and shared geometry. |
| `game.js` | ~35 KB | The engine: movement, ghost AI, levels, scoring, sound. |
| `scores.js` | ~8 KB | High scores, local and shared. |

Nothing is minified, on purpose — a cyber program's site is a reasonable place
for a student to hit "view source" and find something readable.

## What the index page gives up

Two lines of markup, one deferred script tag, and about eight lines of CSS for
the footer button. On a cold page load the browser fetches `unlock.js` and
nothing else; the engine, the styles and the maze data are only requested once
somebody clicks. This matters because the hero already preloads 97 WebP frames,
and an easter egg has no business competing with that.

## Playing

`W A S D` to move (arrows work too), `P` to pause, `M` for sound, `Esc` to
close. On a phone, swipe. Sound starts **muted** — nobody wants this going off
in a quiet classroom.

## The game

Five hand-built mazes that cycle, with speed and difficulty continuing to climb
past level five. Four ghosts with genuinely different logic:

| | Callsign | Behaviour |
|---|---|---|
| red | `SCANNER` | Goes straight at you. |
| pink | `SPOOF` | Aims four tiles ahead, to cut you off. |
| cyan | `SNIFFER` | Plays off the red ghost's position, so it flanks. |
| orange | `WORM` | Bold at range, breaks for its corner up close. |

Plus the arcade's scatter/chase waves, forced reversals on every mode change,
ghost-house release counters, cornering, and the red ghost speeding up as the
maze empties. These are the details that make it feel like the original rather
than four identical chasers.

## Turning on the shared leaderboard

Out of the box scores are saved per browser and the board is labelled
`LOCAL // OFFLINE`. To share them across devices, deploy the companion API
(separate repo, `wcta-arcade-api`) and set one line in `scores.js`:

```js
var API = "https://your-deployment.vercel.app";
```

If the API is ever unreachable the game silently falls back to local scores and
relabels the board, rather than erroring at the player.

## Development

The suite needs a static server at the repo root:

```bash
python3 -m http.server 8099
./tools/test-all.sh
```

| Tool | Purpose |
|---|---|
| `tools/validate-mazes.mjs` | Dimensions, reachability, **dead ends**, shared core block |
| `tools/test-movement.mjs` | Walls, cornering, the tunnel, the ghost-house door |
| `tools/test-ghosts.mjs` | Each ghost's target tile, mode flips, frightened chain, determinism |
| `tools/test-unlock.mjs` | The zero-cost page load, every wrong-answer branch, focus and scroll handling |
| `tools/test-scores.mjs` | Initials entry, persistence, offline fallback |
| `tools/test-soak.mjs` | Long play, level cycling, mobile layout, reduced motion |
| `tools/arcade-dev.html` | Boots straight into the game, skipping the puzzle |
| `tools/show.mjs` | Prints a maze as text, marking dead ends with `!` |

**If you edit a maze, run `validate-mazes.mjs`.** It catches the failures that
are invisible until someone plays for ten minutes — an unreachable pellet, or a
dead-end corridor a ghost can seal with no escape. The original game has no
dead ends and that is a fairness rule, not an aesthetic one.

Mazes are written as 14-column **left halves** and mirrored on load, so
symmetry can't drift on one row. Rows 11–17 across columns 9–18 are shared by
every maze — that block holds the ghost house and its feeds, and the validator
fails the build if a maze diverges there.
