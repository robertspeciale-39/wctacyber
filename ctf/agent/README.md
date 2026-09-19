# CTF Calendar Agent

Keeps **www.wctacyber.org/ctf** current. Every Monday (or whenever you press
the button) it re-runs the CTF search and updates the list.

It edits exactly one file: `ctf/events.json`. The page (`ctf/index.html`)
reads that file, so the agent can change *what is listed* but never *how the
page works*.

## What one run does

1. Pulls U.S.-hosted events from the CTFtime API that are open to everyone or
   high-school-only, and online (or in person in Las Vegas).
2. Sends that list, plus the current calendar, to Claude with web search.
   Claude checks each event against the rules (free, high schoolers allowed,
   remote or Las Vegas, before the window ends), flips "expected" events to
   "confirmed" when dates are announced, and adds new ones.
3. Checks Claude's answer in code before saving anything:
   - Every event must have the right fields and values. A bad update keeps the
     old version; a bad new event is dropped.
   - An event can only be removed with a stated reason (or because it ended).
   - Anything on the `excluded` list is never added.
   - If the list would shrink by more than 40%, nothing is written.
4. Drops events that ended over 30 days ago.
5. Tests every link. A dead official site switches to the event's CTFtime page.
6. Saves `ctf/events.json` and commits it. The run's Summary tab lists every change.

## One-time setup

**1. Add the files to the repo** (see the main deploy notes).

**2. Add your Claude API key as a secret**
1. Get a key at https://platform.claude.com (Settings → API Keys). API usage is
   billed separately from a Claude.ai subscription.
2. In GitHub, open the `wctacyber` repo → **Settings** → **Secrets and variables**
   → **Actions** → **New repository secret**.
3. Name: `ANTHROPIC_API_KEY`. Secret: paste the key. **Add secret**.

**3. Let the workflow push commits**
1. Repo → **Settings** → **Actions** → **General**.
2. Under **Workflow permissions**, choose **Read and write permissions** → **Save**.

## Running it

**Manually:** repo → **Actions** tab → **CTF Calendar Agent** (left sidebar) →
**Run workflow** → **Run workflow**. Tick *Dry run* first if you want to see
what it would change without committing. Open the finished run and click
**Summary** to read the change log.

**On a schedule:** automatic, Mondays at 6 AM Las Vegas time (5 AM in winter).
To change it, edit the `cron` line in `.github/workflows/ctf-agent.yml`
(times are UTC).

**On your own computer** (optional):
```
ANTHROPIC_API_KEY=sk-ant-... python ctf/agent/update_ctf.py --dry-run
```
`--no-llm` skips Claude and only prunes ended events and repairs links.

## Common edits (all in `ctf/events.json`)

- **Extend the calendar past May 2027:** change `"window": {"end": "2027-05-31"}`.
- **Keep an event off the page for good:** add it to `excluded` with a reason,
  e.g. `{"name": "Some CTF", "reason": "College only"}`. Also delete its entry
  from `events`.
- **Fix one listing by hand:** edit it directly. The agent keeps your wording
  unless it finds a real change.

## Cost

Each run is one Claude Sonnet 5 request with up to 30 web searches.
Token usage is billed at Sonnet 5 rates, and web searches are billed per search on
top of that. Check **Usage** in the Claude Console after the first run to see the
real per-run cost. To lower it, set a smaller cap with the
`CTF_AGENT_MAX_SEARCHES` environment variable in the workflow.

## Troubleshooting

| What you see | Fix |
|---|---|
| `ANTHROPIC_API_KEY is not set` | Step 2 above; the secret name must match exactly. |
| `Permission denied` / push rejected | Step 3 above. |
| `ABORTED: list would shrink` | The safety check tripped. Read the Summary; if the removals are real, run locally with `--force`. |
| Page didn't change after a run | Wait a minute for GitHub Pages, then hard-refresh (Ctrl+Shift+R). |
| Schedule stopped running | GitHub pauses schedules after 60 days with no repo activity. Re-enable it on the Actions tab. |
