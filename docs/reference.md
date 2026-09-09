# keep

A work registry: mission control for tasks, experiments, and Claude Code/Codex sessions.
One markdown file per task in `tasks/` — YAML frontmatter is machine state, the body
is an append-only log (newest first). Every mutation is a git commit; manual terminal
use pushes best-effort in the background.


## Layout

- `bin/keep` — the CLI (sh launcher + `keep.js`, runs on Node; symlinked from `~/bin/keep`)
- `tasks/` — live tasks, one `.md` per task
- `archive/` — done tasks, swept here occasionally
- `digests/` — generated digests (Phase 2)
- `skills/keep/` — canonical shared Keep skill, symlinked into each agent's user skill directory
- `reviews/` — fleet-reviewer findings, one file per day
- `bin/alerts.js` — alert routing, rate policy, channel adapters, and brief composition
- `bin/unblock.js` — cross-card dependency resolution and linked-session delivery
- `bin/slack.js` — read-only Slack polling, fleet correlation, cards, and alerts
- `bin/standup.js` — weekday Castle standup evidence, generation, and scheduling
- `bin/ideas.js` — daily fleet-wide Fable ideas evidence, generation, and scheduling
- `bin/landed.js` — default-branch commit detection, card annotation, and scheduling
- `bin/lint.js` — deterministic card hygiene checks and their cached result
- `.keep/` — machine state (lock, markers, reviewer state), gitignored
- `.keep/holds/` — quiet-window ledgers, one JSON file per hold
- `.keep/unblocked/` — pending and delivered cross-card unblock records
- `steps/` — committed gated-step registries, one JSON file per project basename
- `.keep/steps/` — local step run ledgers and logs (gitignored)
- `.keep/review/_questions.json` — reviewer question/answer ledger

## CLI

```
keep add "title" [--kind task|experiment|idea|chore|bug] [--tag t]… [--project p]
                 [--plan "step"…] [--check-after when] [--check "recipe"] [--status s] [-m note]
keep checkin <id> -m "state + next step" [--next "text"] [--commit <sha>]... [--step <n|next>] [--status s] [--check-after when] [--clear-check-after]
keep plan <id> [--set "step"… | --add "text" | --insert <n> "text" | --remove <n>
                | --done <n> | --start <n> | --undo <n>]
keep list [--status s]… [--tag t] [--project p] [--overdue] [--brief] [--all]
keep show <id>
keep wait-on <card> <upstream> [<upstream>...]
keep deps [<card>]
keep done <id> [-m note] [--next "text"] [--commit <sha>]...
keep tag <id> +a -b
keep tags
keep overdue [--brief]
keep who <project> [--json]
keep hold <project> --for +15m -m "why" [--task <id>]
keep release <hold-id>
keep holds
keep steps [<project>] [--json]
keep step claim <project> <step> [--task <id>] [--for <dur>] [--wait] [--force] -m "why"
keep step run <project> <step> [--sha <sha>] [--no-done]
keep step done <project> <step> [--artifact <id>] [--sha <sha>] [--force] [-m note]
keep step fail <project> <step> [--force] -m "why"
keep step notify <project> <step>
keep ask "<question>" [--about <project>] [--task <id>] [--timeout <min>]
keep answer <qid> -m "<answer>"
keep questions [--all]
keep alert -m "text" --level attention|urgent [--key k] [--card id] [--from name] [--dry]
keep quiet <duration>|off
keep alerts [--all]
keep lint [--json] [--rule <name>] [--fix-hints]
keep brief [--send]
keep codex-jobs [--json] [--reap] [--dry]  # list companion jobs/brokers; optionally reap stale jobs, orphan pollers, and abandoned or idle brokers
keep standup [--since "YYYY-MM-DD HH:MM"|ISO] [--dry] [--show]
keep ideas [--dry] [--model <m>]
keep landed [--dry] [--only <id>]
keep landed policy narrow|broad
keep landed dry on|off
keep landed decisions [--disagree]
keep slack poll [--dry]
keep slack status
keep slack mode log|cards|alerts
keep verify <id>       # run a check recipe now (needs keep serve)
keep compact <sid>     # compact a live Claude or Codex session (needs keep serve)
keep resume            # post-restart: active tasks + agent-aware resume commands
keep sync              # pull --rebase + push
keep hook session-start  # used by the Claude Code SessionStart hook

keep review-queue [--limit n] [--min-score n] [--json]   # what deserves review now
keep review-bundle <id> [--budget n] [--raw]             # evidence delta since last review
keep review-note <id> --kind k --subject s -m "finding"  # attributed reviewer finding
keep review-idea "<title>" -m "<body>" [--cards a,b,c]   # fleet-wide workflow suggestion
keep review-ack <id> [-m note]                           # reviewed, nothing to flag
keep review-dismiss <id> <key> [-m why]                  # never raise this one again
keep review-budget [--json] [--model m]                  # may the reviewer spend right now?
keep review-tick [--force]                               # wake the reviewer (needs keep serve)
keep review-stats [--json]                               # last tick, skips, per-day counts
keep nudge <id> --session <sid> --key <k> -m "..." [--send]  # message a live agent (dry-run default)
```

`when`: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `+15m`, `+3d`, `+12h`, `+2w`, `tomorrow`.

Statuses: `inbox → active → waiting/blocked → review → done`. `waiting` requires
`check_after` or an unresolved `depends_on` entry; `review` means the ball is in Owner's
court with an artifact to look at.
Experiments (`kind: experiment`) must have a `check_after` and ideally a `check` recipe
an agent can execute cold.

`keep lint` runs advisory daily hygiene checks including `malformed-card`, scope tags,
review next steps, waiting triggers, uncited commits, stale active work, old done cards,
and duplicate titles. It always exits successfully when findings exist, writes the latest
result to `.keep/lint.json`, and supports one-rule runs plus JSON output and fix hints.
The brief refreshes findings older than 20 hours and shows the first five.

Mutations auto-commit. Manual terminal use also pushes best-effort in the background;
Claude and Codex sessions leave commits local unless `KEEP_ALLOW_PUSH=1` is explicitly
set after push approval.

## Card dependencies

Use `keep wait-on <your-card> <upstream> [<upstream>...]` when one card cannot continue
until another finishes. It records `depends_on`, rejects missing cards and cycles, and
moves active or review work to waiting. `keep deps [<card>]` shows resolved and pending
edges. Do not use review for this: review is reserved for Owner's review.

When an upstream card becomes done, every completion path queues a local unblock record.
The daemon appends the dependency result to the dependent card, returns a fully unblocked
waiting card to active, and sends a fenced `[keep] unblocked` notice to its latest eligible
linked session. Busy or missing sessions are retried without delivering from the CLI.

## Plans

A card can carry an ordered checklist at the top of its body. Add one with `keep add
--plan "first" "second"`, replace it with `keep plan <id> --set ...`, or edit individual
steps with `--add`, `--insert`, `--remove`, `--start`, `--done`, and `--undo`. Existing
steps keep their state when a replacement has the same text. `keep checkin <id> --step
next -m "..."` completes the current doing step (or the first todo step) and records the
check-in in one mutation. The CLI alone maintains this section:

```markdown
## Plan
- [ ] Write the migration
- [~] Run it on staging
- [x] Design the schema
```

The next incomplete step appears in `keep list`, `keep resume`, `keep show`, session
startup context, `keep who`, and fleet-review bundles. The full checklist stays above
the newest-first card log so fresh agents and scheduled runs see the plan first.

## Auto-continue

For interactive Claude sessions, the Stop hook blocks once when a card explicitly
linked to that session is active and has a next plan step. Headless `claude -p` runs
are never continued. It will not block while an `AskUserQuestion` or `ExitPlanMode`
tool is unresolved, while Claude is in plan permission mode, or when the last non-empty
assistant text asks Owner a question. It will not repeat for the same card, position,
and step text; advancing the plan enables the next reminder. A session is capped at 25
continuations. The reminder fences the card's step text as data and clips it to 200
characters rather than treating card content as instructions.
`KEEP_AUTO_CONTINUE` defaults to `1`; set it to `0` to disable the feature globally, or
add `autocontinue: off` to a card's frontmatter to opt that card out. Codex sessions are
out of scope because their Stop hook protocol differs.

Each continuation is appended to `.keep/continues.jsonl` with its card, session, step,
text, and timestamp. Fleet-review bundles count those entries since the last review so
the reviewer can spot thrash.

## Fleet presence and quiet windows

`keep who <project>` is a deterministic snapshot: open cards, matching live sessions,
scheduled checks, running Keep jobs, active holds, gated steps, and recent/dirty git state. It never
calls a model. If the daemon is unavailable, cards, holds, and git still render while
the session section is marked unknown. Project arguments accept a repo basename,
`castle/repo`, a `~` path, or an absolute path.

Use `keep hold <project> --for +15m -m "why"` before changing shared state such as a
deploy, migration, restart, or secret. The hold is written atomically under
`.keep/holds/`, appears in `keep who`, session-start context, and reviewer bundles,
and expires automatically. Release it early with `keep release <hold-id>`.

## Alerts and the morning brief

`keep alert` adds a judged push layer in front of Keep's cards. `attention` is for
something Owner should see soon; `urgent` is for something that warrants an immediate
phone notification and speaker announcement. Every accepted or deferred alert is
appended to `.keep/alerts.jsonl`, including each attempted channel's `ok`, `suppressed`,
or `failed` outcome; `keep alerts` shows the last 24 hours and `--all`
shows the full ledger. A repeated `--key` is dropped for six hours unless its level
rises from attention to urgent. `--card` also records `alert (<level>): <text>` on the
named card without claiming its session.

| Level | Present at the Mac | Away | During `keep quiet` |
| --- | --- | --- | --- |
| attention | sound | phone push | deferred to the brief |
| urgent | phone push + speaker | phone push + speaker | unchanged |
| brief | phone push | phone push | unchanged |

Presence is an idle time under five minutes. Phone pushes use `KEEP_PUSH_WEBHOOK` or
`~/.config/keep/push-webhook`; channel failures never crash the caller. Urgent speaker
delivery still observes the announce service's quiet hours. `keep quiet +2h` (or any
normal Keep duration) suppresses attention alerts until that time, and `keep quiet off`
clears it.

The desktop console's bell opens a persistent notification inbox for these alerts,
separate from session questions in “Waiting on you.” It includes deferred alerts and
failed deliveries. Read/unread state lives in `.keep/notifications.json`; marking a
message read never changes its card or acknowledges a session question. Repeated
keys show their latest message, and an escalation becomes unread again. Selecting a
message shows its linked card notes; session and reviewer buttons open the relevant
console view.

With desktop notification permission enabled, new accepted attention/urgent alerts
created while present also get a visual desktop banner. Existing sound, phone and
speaker routing remains in effect. Quiet/capped alerts and daily briefs remain in the
inbox without an additional desktop banner. The running shell claims each banner
once across windows/reloads; alerts older than two minutes stay in the inbox without
replaying interruptions. A desktop banner click opens that message. Quit stops desktop
delivery until the app is reopened. `KEEP_ALERT_CHANNELS=none` also disables desktop
banners; an explicit channel list must include `desktop` to enable them.

The default daily caps are 12 attention and 4 urgent alerts, with 30 minutes between
urgent alerts. The fleet reviewer has its own allowance inside those totals: 5
attention and 2 urgent alerts per day. The corresponding `KEEP_ALERT_*` environment
variables are `KEEP_ALERT_ATTENTION_DAILY`, `KEEP_ALERT_URGENT_DAILY`,
`KEEP_ALERT_URGENT_GAP_MIN`, `KEEP_ALERT_REVIEWER_ATTENTION_DAILY`, and
`KEEP_ALERT_REVIEWER_URGENT_DAILY`. Alerts rejected by a cap are recorded as deferred
so they still appear in the next brief. `KEEP_ALERT_DEDUPE_HOURS` changes the six-hour
dedupe window; `KEEP_ALERT_CHANNELS=none` disables channel processes for isolated use.

`keep brief` prints the current brief; `keep brief --send` also routes it. The daemon
sends one each local day at `KEEP_BRIEF_AT` (default `08:00`). It covers review cards,
questions and newly delivered answers, overdue checks, deferred alerts, recent
medium/high reviewer findings, active holds, and gated steps with pending commits. A
failed delivery retries every 30 minutes until 12:00 local, when the daemon records the
failure and gives up for that day; `keep brief --send` always sends immediately.

## Castle standup

`keep standup` overwrites `standup.md` with an at-most-three-sentence Castle update
covering work since the previous weekday's generation time. `--since` overrides that
cutoff (a bare date and time is Pacific), `--dry` prints the fenced evidence and prompt
without calling a model or writing files, and `--show` prints the current note. The
daemon generates it on weekdays at `KEEP_STANDUP_AT` (default `11:30`) in
`KEEP_STANDUP_TZ` (default `America/Los_Angeles`), retries failures every 15 minutes
until 13:00 Pacific, and displays the latest note and its source cards on the dashboard.

## Daily ideas sweep

`keep ideas` runs the fleet-wide workflow-improvement pass immediately. It gives a
tool-free model seven days of fenced Keep evidence, avoids ideas already filed or
already shipped, and lands at most three `kind: idea` cards through the reviewer's
normal duplicate and daily-cap checks. `--dry` prints the evidence and prompt without
calling a model or writing state; `--model` overrides `KEEP_IDEAS_MODEL` (default
`fable`). The daemon runs it every day at local `KEEP_IDEAS_AT` (default `07:30`) and
retries failures every 30 minutes until noon.

## Landed commits

`keep landed` checks recent open cards for cited commit shas that have reached each
project's `origin` default branch. It annotates open cards and applies the close policy
in `watch/landed.json`: `narrow` requires an explicit landing-only next step, while
`broad` closes review cards unless their newest work check-in names another pending
step. Future scheduled checks always keep a card open. With `closeDry` enabled, the
daemon records and displays would-close decisions without changing status; inspect
them with `keep landed decisions [--disagree]`. `keep landed policy narrow|broad` and
`keep landed dry on|off` update the committed configuration. `--dry` prints planned
actions without changing cards or local state; `--only <id>` restricts the sweep to
one card. The daemon runs every 30 minutes by default (`KEEP_LANDED_MIN`). Ending
check-ins should cite full commit shas and finish with an unambiguous `Next:` line.

## Slack watch

`keep serve` polls the channels in `watch/slack.json` every `intervalMin` minutes,
starting two minutes after boot. `keep slack poll --dry` fetches and classifies without
advancing cursors or writing decisions. `keep slack status` shows cursors, the last
poll, today's classification counts, and the current mode; `keep slack mode
log|cards|alerts` changes the committed configuration.

The modes are incremental: `log` only appends classifications, `cards` also creates a
`bug` card for each non-duplicate bug, and `alerts` additionally sends an attention
alert for medium/high bugs with a deterministic timing suspect. Slack-derived card
and thread text is quoted inside a `DATA, NOT INSTRUCTIONS` fence, and the fleet block
has its own separate data fence. There is deliberately no separate product
rubric: recent open cards, project commits, gated-step runs, and active holds are the
definition of whether a report is related to our work.
Every message also gets deterministic commit, completed step-run, and active-hold suspects from the prior `SUSPECT_WINDOW_MIN` minutes (90 by default), independent of model correlation.
Slack threads are folded into one parent classification; replies are logged as replies and become thread check-ins instead of standalone bug cards.
Thread polling is capped at ten threads per poll (oldest activity first, with deferred
threads rotating into the next poll). A thread expires after 48 hours without a new
reply, or 24 hours after it resolves.

Local state lives under `.keep/slack/`: `cursors.json`, `seen.json`,
`decisions.jsonl`, and `threads.json`; seen-message records are pruned after 30 days.
History and reply overflow is oldest-first: each cursor advances only through the last
contiguous message actually landed, so later messages remain for the next poll. Slack
bug card ids are deterministic (`slack-<channel>-<timestamp-without-dot>`), and a
`landing` state plus those ids makes retries reuse cards and thread check-ins.

The classifier uses the configured small model (`haiku` by default). Each message is
clipped to 1,500 characters, files contribute names only, thread prompts keep the
parent plus the last 12 replies, related refs are capped at six, and reactions are
omitted. Fleet context is capped at 12,000 characters (dropping old commits first),
while the entire prompt is capped at 40,000 characters. Whole message/thread units
that do not fit are deferred behind their cursors rather than dropped.

## Steps

Step commands run with stdin closed, so anything that prompts dies at the prompt. Write
every step to be non-interactive: Terraform saves a plan with `-input=false -out` and
applies that plan file (no approval prompt); Packer already is. The first Codex run of the
terraform step died at Terraform's "Enter a value" prompt for exactly this reason.

Gated steps serialize slow or exclusive shared build and deployment operations. A
committed `steps/<project-basename>.json` registry names the project and each step's
owned path globs, source policy (`landed` or `any`), command, optional preparation and
artifact pattern, follow-up instruction, default claim duration, and—for landed
steps—a dedicated sibling worktree. Local run history, waiters, and mirrored command
logs live under `.keep/steps/<project-basename>/` and are never committed.

Run `keep steps <project>` before changing a governed path. It shows the last recorded
artifact, current claim and run, waiters, and up to 20 local `origin/<default>` commits
that have not reached the last recorded run; `--json` exposes the same snapshot. Claim
with `keep step claim ... -m "why"`, add `--wait` to queue a one-time session
notification behind another holder, and release the claim by finishing with `keep
step done` or `keep step fail`. A `running` ledger record blocks a new claim even
after its hold expires; `step claim --force` explicitly abandons that run and warns.
Only the session that started a running run may finish it (manual terminal use has no
session); `step done --force` and `step fail --force` override that ownership check.

`keep step run` mirrors the command's output live and into the local run log. A
failed step prints its log path; read it before re-running. A
`from: any` step runs only in the project or one of its linked worktrees and records
HEAD plus dirty state. A `from: landed` step first fetches `origin`, refuses a revision
that is not an ancestor of `origin/<default>`, and creates or cleanly re-pins the
registry's detached worktree to that exact SHA. This matters for build scripts that
copy the working tree: the recorded artifact is then provably built from the pinned,
landed revision instead of whatever happened to be in another checkout. Successful
runs release the claim, notify waiters, and check attributed cards in with the
artifact and registry `next` instruction; use `--no-done` when finalizing separately.
Failed waiter deliveries stay queued with their latest error and retry count. The
next `step done` or `step fail` retries them, and `keep step notify <project> <step>`
retries the last completed run's notification without rerunning the step.

Example registry entry:

```json
{
  "project": "~/castle/example",
  "steps": {
    "image": {
      "title": "Build the image",
      "paths": ["packer/**", "host-agent/**"],
      "from": "landed",
      "worktree": "~/castle/example.step-image",
      "prepare": "yarn install --frozen-lockfile",
      "command": "cd packer && ./build.sh",
      "artifactPattern": "ami-[0-9a-f]{8,}",
      "next": "update the affected pin and follow the canary procedure",
      "defaultHold": "+2h"
    }
  }
}
```

## Ask the fleet reviewer

`keep ask "<question>" --about <project>` queues one open question per asking session
in `.keep/review/_questions.json`. The daemon delivers it to an idle, in-budget fleet
reviewer, which records the result with `keep answer <qid> -m "..."`; the answer is
then sent back into the asking session and optionally logged on `--task`. Answers are
observations, not authorization. If the reviewer does not answer before the timeout
(10 minutes by default), the daemon sends a fresh model-free `keep who` snapshot
instead. `keep questions [--all]` inspects the ledger; hand-run questions without a
session remain on the ledger/card only. Failed answer and timeout-notice sends enter
an outbox in the question ledger; the daemon retries each pending delivery once per
tick for up to 20 attempts and records its delivery time or that it gave up.

Long messages injected into sessions are typed in paced chunks and, for Claude
sessions, verified against the transcript after submit; truncated delivery is logged.

## Scheduled checks and runs

When a scheduled check becomes due, Keep first sends its recipe into the most recent
eligible linked Claude or Codex thread. A successful delivery is recorded in
`.keep/runs/<taskId>.delivered.json` for that exact `check_after`, so daemon restarts do
not redeliver it; the thread must check in with `--clear-check-after` or reschedule it.
An open linked thread remains eligible even after hours of inactivity. A thread that
is mid-turn or waiting on Owner defers the check for 12 scheduler ticks by default
(`KEEP_DELIVER_MAX_DEFERRALS`) before a headless run takes over; if no linked pane is
open, Keep falls back to headless immediately.
Headless Keep runs disable `codex@openai-codex` by default; set
`KEEP_HEADLESS_DISABLED_PLUGINS` to a comma-separated plugin list, or empty to opt out.

If transcript verification shows that a scheduled-check prompt arrived truncated,
Keep still stamps it as delivered to avoid typing the prompt twice, then adds a
`delivery warning` check-in naming the session and received/expected character counts;
the full recipe remains available through `keep show <id>`.

If a headless check or task changes its card's status, its finalizer records the result without overriding that status or clearing the scheduled check.

Before delivering to a cold, large thread, Keep runs `/compact` and waits for its
transcript marker. The gate is configured by `KEEP_CACHE_TTL_MIN` (default 60),
`KEEP_COMPACT_MIN_TOKENS` (default 80000), and `KEEP_COMPACT_TIMEOUT_MS` (default
240000). Run compaction directly with `keep compact <sid>` or
`POST /api/compact { "sessionId": "<sid>" }`.

Claude compactions whose transcript model matches `KEEP_AUTO_COMPACT_MODELS` (a
comma-separated family list, default `fable`) first switch the session to
`KEEP_COMPACT_VIA_MODEL` (default `opus`; set it to `off` to disable the swap).
Prompt caches are per model, so the Opus summary is uncached regardless of timing,
while this avoids spending scarce Fable quota on summarization. Typed `/model`
commands also persist the saved default in Claude's `settings.json`, so Keep records
the exact settings value before switching. Claude Code's expected `Switch model?`
cache-warning dialog is confirmed automatically. Keep restores the session by
reissuing that exact value (including `[1m]`) when the session was using the configured
model, or by reissuing the transcript model ID otherwise; it then repairs the `model`
key in `settings.json` to its original value, including removing the key when it was absent.
While compaction is running—typically one to three minutes—new Claude sessions would
therefore start on Opus. Keep writes `.keep/compact/<sessionId>.swap.json` before
switching and removes it only after a confirmed session restore. A retained file and
`MODEL RESTORE UNCONFIRMED` in the daemon log mean both the session and `settings.json`
may need a manual fix. Direct `keep compact <sid>` calls and compact-before-deliver
use this swap too; on startup, a `PENDING MODEL SWAP` line reports each retained swap
file for manual inspection.

Auto-compact now targets large Claude sessions only after their prompt cache is cold:
from `KEEP_CACHE_TTL_MIN` (default 60) through
`KEEP_AUTO_COMPACT_MAX_IDLE_MIN` (default 1440), with no lead-window setting. Set
`KEEP_AUTO_COMPACT=off|dry|on` (default `off`); the context gate is
`KEEP_AUTO_COMPACT_MIN_TOKENS` (default 100000). Decisions are stamped once per idle
period in `.keep/compact/<sessionId>.json` and appended to
`.keep/compact/_log.jsonl`, including the model used for the swap or `null` when none
ran. A compacted session is not re-compacted until it grows past the token floor again.
Run `dry` for a day and review that log before enabling `on`.

## wt — worktrees

`wt` gives agent work an isolated linked worktree while leaving the shared main
checkout untouched. Managed trees live at `~/wt/<repo>/<name>` on `wt/<name>`.

```sh
wt new <repo> [<name>] [--no-install] [--base <ref>]
wt ls [<repo>]
wt path <repo> <name>
wt main [<path>]
wt rm <path | repo/name> [--force] [--delete]
wt land [<path>] [--dry-run] [--no-push]
wt guard [on|off|status]
```

Commit freely in the worktree. To land it, run `wt land`: it fetches and rebases
onto `origin/<default>`, shows the commits, then pushes `HEAD:<default>` without
checking out or changing the main checkout. After landing, `wt rm` recycles the
tree for the next agent; use `--delete` to remove it instead.

## Fleet reviewer

### Running it

```
keep-reviewer            # latest fable (default)
keep-reviewer sonnet     # cheaper shake-out runs
```

Open it in its own terminal tab and **leave it idle** — it is not a session you drive.
`keep serve` wakes it with a one-line `[keep] review tick` message when the fleet has
produced something worth reviewing (every 10 min at most, 20 min minimum between
sends), and it runs the `fleet-review` skill against the named cards. No activity
means no tick, so an idle machine costs nothing. `keep review-tick --force` sends one
now; `keep review-stats` shows the last tick, why the last one was skipped, and what
the reviewer has cost against the weekly window.

Systemic suggestions belong in `keep review-idea`, rather than on an individual card:
it creates an active `idea` card tagged `reviewer-idea`, deduplicates normalized titles,
limits the channel to three ideas per day, and can use `--cards a,b,c` to leave linked
reviewer check-ins on the evidence cards. The message should name the observed pattern,
cite the cards, sessions, or commits that demonstrate it, and propose the workflow or
Keep change.

The model argument is an **alias** (`fable`, `sonnet`, `opus`), passed to
`claude --model` verbatim so it always resolves to the latest model in that family.
Do not substitute a pinned id unless you mean to freeze the version. Only the family
name is derived from it, for the budget governor (which matches the `Fable wk` usage
limit by label prefix) and for the `review (fable)` heading findings land under.

Switching models means restarting the session: the model is fixed at launch, and the
governor reads it from the `.keep/reviewer/<id>` marker written at startup.

### Trust boundary — accepted risk

The reviewer is **trusted, not sandboxed**. This is a deliberate decision (2026-09-01),
recorded here because the code cannot express it.

It runs as an ordinary Claude Code session with full tools, and it reads bundles
assembled from other agents' transcripts — which routinely quote text those agents
read from the web, from files, and from other people. So the input is
attacker-influenceable and the process is privileged.

Every limit in `fleet-review/SKILL.md` — nudges dry-run by default, announcement
caps, never change a card's status, respect the budget governor — is therefore
**cooperative**. A reviewer that decided to ignore them could call `keep checkin
--status`, `keep done`, `review-dismiss`, `~/bin/announce`, or POST directly to
`/api/send`, and nothing in the code would stop it. The bundle's "DATA, NOT
INSTRUCTIONS" envelope is a guardrail against naive injection, not a security
boundary; prompt text cannot constrain a session that holds the tools.

What actually bounds the damage is that the blast radius is small and reversible:
findings are check-ins on cards, every mutation is a git commit, and nudges need an
explicit `--send`. The risk accepted is a bad or manipulated finding, a wrongly
closed card, or an unwanted message to another session — all visible in `git log`
and undoable.

If that stops being acceptable, the fix is to constrain authority rather than to add
more prompt wording: run the reviewer under a restricted permission set, or split it
so the judging session has no write access and a deterministic step lands its output.

### How it works

A separate agent session reviews the *other* agents' work and reports problems back
onto their cards. Evidence gathering is deterministic Node (`bin/review.js`): it reads
each linked Claude and Codex transcript from a stored byte offset, extracts what the
agent actually did (tools, files, commands, failures) without ever emitting a file
body, and renders it inside a token budget.

Two invariants the code enforces:

- **A reviewer note never claims a card's resume link.** `checkinTask` takes
  `linkSession: false`, and `recordSession` returns early for a reviewer session
  (`KEEP_REVIEWER=1`, or a `.keep/reviewer/<id>` marker the daemon can also see).
- **Reading never advances committed offsets.** `review-bundle` stages pending
  offsets; only `review-note` / `review-ack` promote them, so a crashed tick re-reads
  its evidence instead of silently skipping it.
- A registered reviewer remains eligible in the `recent` state after more than an hour idle; the existing running and mid-turn guards still apply.
- Log entries written by headless runs count as weak evidence, and cards with no non-reviewer, non-spawned linked session have their evidence score halved.
- Each tick includes at most one card per numeric-suffix-stripped title stem, leaving sibling cohort cards eligible for later ticks.
- `KEEP_REVIEW_TICK_LIMIT` controls the per-tick candidate limit and defaults to 5.

Findings dedupe on `sha1(task, kind, normalized subject)` — never on the prose, which
varies every tick — and go quiet for 24h unless the status or HEAD moves.
