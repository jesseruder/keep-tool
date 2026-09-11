# keep

A work registry: mission control for tasks, experiments, and Claude Code/Codex sessions.
One markdown file per task in `tasks/` — YAML frontmatter is machine state, the body
is an append-only log (newest first). Registry mutations create local Git commits;
remote sync is optional and belongs on a private registry remote.


## Layout

Application paths (`bin/` and `skills/`) live in the source checkout. Task and runtime
paths live in your separate data directory (`~/keep` by default). Never commit
registry data or credentials to the public source repository.

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
- `.keep/artifacts/` — committed per-card durable artifacts, force-added like `.keep/handoffs/`
- `.keep/holds/` — quiet-window ledgers, one JSON file per hold
- `.keep/unblocked/` — pending and delivered cross-card unblock records
- `steps/` — committed gated-step registries, one JSON file per project basename
- `.keep/steps/` — local step run ledgers and logs (gitignored)

## CLI

```
keep add "title" [--kind task|experiment|idea|chore|bug] [--tag t]… [--project p]
                 [--plan "step"…] [--check-after when] [--check "recipe"] [--status s] [-m note]
keep checkin <id> -m "state + next step" [--next "text"] [--commit <sha>]... [--step <n|next>] [--status s] [--check-after when] [--check "recipe"] [--clear-check-after] [--handoff waiting|needs-input]
keep plan <id> [--set "step"… | --add "text" | --insert <n> "text" | --remove <n>
                | --done <n> | --start <n> | --undo <n>]
keep list [--status s]… [--tag t] [--project p] [--overdue] [--brief] [--all]
keep show <id>
keep artifact <card> [<file>...] [-m note]
keep link <card> --session <sid> --agent claude|codex
keep wait-on <card> <upstream>[#<step>] [<upstream>...] -m "why"
keep deps [<card>]
keep done <id> [-m note] [--next "text"] [--commit <sha>]...
keep tag <id> +a -b
keep tags
keep overdue [--brief]
keep who <project> [--json] [--scope <resource>]
keep hold <project> --for +15m -m "why" [--task <id>] [--scope <resource>]...
keep release <hold-id>
keep holds
keep steps [<project>] [--json]
keep step claim <project> <step> [--task <id>] [--for <dur>] [--wait] [--force] -m "why"
keep step run <project> <step> [--sha <sha>] [--no-done]
keep step done <project> <step> [--artifact <id>] [--sha <sha>] [--force] [-m note]
keep step fail <project> <step> [--force] -m "why"
keep step notify <project> <step>
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

`keep link` repairs a session's ownership metadata when work was recorded from a
different project directory. It transfers that explicit session from its old card to
the named card and does not launch, wake, or message the session. The target card's
status, schedule, activity timestamp, and body are preserved.

Claude subagent lifecycle tracking uses `keep hook lifecycle` for both
`SubagentStart` and `SubagentStop` in Claude's user settings. These observation-only
hooks write bounded, content-free records under `.keep/lifecycle/<session-id>`;
they never block a turn or inject a message. The dashboard reconciles child
transcripts when completion hooks are missing and falls back to existing transcript
tracking for sessions that have not loaded the hooks. Existing Claude sessions may
need to restart/resume before newly configured hooks take effect.

An agent that needs the owner ends its turn with the question: the console shows every
pane's final turn in Waiting on you, and a reply typed there is the answer. Something
only the owner can supply, and that must outlive the session, is a `keep needs` block.

`when`: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `+15m`, `+3d`, `+12h`, `+2w`, `tomorrow`.

Statuses: `inbox → active → waiting/blocked → review/landing → done`. `waiting` requires
`check_after` or an unresolved `depends_on` entry; `review` means the ball is in the owner's
court with an artifact to look at.
Experiments (`kind: experiment`) must have a `check_after` and a `check` recipe
an agent can execute cold.

Scheduled recipes are polled every minute. `--check-after` plus a recipe records a
turn-scoped waiting handoff; add `--handoff needs-input` when scheduling and also
asking for a decision. A later turn invalidates that handoff. Card state is separate
from conversation readiness: a live session that has proposed a next step belongs in
Waiting on you even without a question. See the shared [Keep skill](../skills/keep/SKILL.md)
and [status model](session-reliability.md). `keep help` is the complete command
reference; this list is a quick overview.

Testing: `npm run test:scenarios` replays deterministic session transitions for both
agents; `npm run test:scenarios:browser` checks the isolated desktop-web UI.
See [scenario testing](session-scenarios.md) for seeds and failure replay.

`keep lint` runs advisory daily hygiene checks including `malformed-card`, scope tags,
review next steps, waiting triggers, uncited commits, stale active work, old done cards,
duplicate titles, and `tmp-artifact` citations. It always exits successfully when findings exist, writes the latest
result to `.keep/lint.json`, and supports one-rule runs plus JSON output and fix hints.
The brief refreshes findings older than 20 hours and shows the first five.
The `unsatisfiable-wait` rule flags unresolved waits whose upstream has no live linked
session, scheduled check recipe, or log activity in 24 hours. It also flags whole-card or step waits whose reason or recent downstream check-ins
cite a commit already on the upstream's origin default branch. Hints identify the
narrower wait to use while preserving existing fact targets. Stale or missing daemon session evidence does not prove that
a linked session is gone. Reviewer bundle headers include bounded, card-specific cached
lint findings as advisory evidence.

Mutations auto-commit. Manual terminal use also pushes best-effort in the background;
Claude and Codex sessions leave commits local unless `KEEP_ALLOW_PUSH=1` is explicitly
set after push approval.

## Card dependencies

Use `keep wait-on <your-card> <upstream> -m "why"` when one card cannot continue
until another finishes, or `<upstream>#<n>` for a specific plan step. Every new wait
requires a nonempty reason, stored with that dependency. Step numbers are positional;
re-check `keep deps` after inserting or removing upstream steps.

Prefer a target that describes the fact you actually need:

```sh
keep wait-on <card> <upstream> --commit <sha>[,<sha>] -m "need these commits on origin"
keep wait-on <card> <upstream> --deployed <sha> --target <name> -m "need this deployment"
keep wait-on <card> <upstream> --status review,landing,done -m "need a reviewable result"
```

Commit waits resolve when every SHA reaches the upstream project's origin default
branch, verified through the existing `keep landed` sweep. Deployment waits resolve
from a `deployed <sha> to <target>` entry on the upstream card, as recorded by the deploy
hook. Status waits resolve when the upstream reaches any listed status (`review`,
`landing`, or `done`). Quote a pipe-separated status list if using `|` instead of commas.

A bare whole-card wait is refused with exit code 2 when the upstream has a plan;
the error lists its steps. Select a step or fact target, or pass `--whole` to explicitly
wait for completion of the entire card. A broad wait on an upstream in `review` or
`landing`, or with kind `idea`, also warns on stderr that it may sit for days and
suggests fact targets. Warnings alone do not fail the command.

`keep wait-on` rejects missing cards and cycles and moves active or review work to
waiting. `keep deps [<card>]` shows resolved and pending targets and their reasons.
Remove an exact entry by repeating its target flags with `--remove`; for example,
`keep wait-on <card> <upstream> --commit <sha> --remove -m "no longer needed"`.
Other dependencies remain intact, and pending notices for the removed entry are cancelled.
Already submitted messages cannot be recalled.

The daemon appends satisfied dependency results to the dependent card, returns a fully
unblocked waiting card to active when no scheduled check or need remains, and sends a
fenced `[keep] unblocked` notice to its latest eligible linked session. Busy or missing
sessions are retried without delivering from the CLI.

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

## Session restart

Keep can resume a conversation in the same pane ID, preserving pins and history.
Conservative restarts require a verified idle prompt, no draft or unresolved
background work, and graceful process exit. Queued restarts wait until the pane
has no viewers, can be cancelled, and survive daemon restart. Fleet reviewers
require a separate coordinated restart. Explicit force-restart recovery has its
own durable transaction and recovery checks; it is not ordinary idle cleanup.
See the [session reliability contract](session-reliability.md) for restart proof
and the [force-restart guide](force-restart.md) for explicit recovery commands.

Resume uses the agent's saved conversation/settings; an explicit permission bypass
is carried over only when the old process used it. Other one-off CLI overrides
are not replayed. Existing sessions may need a controlled restart/resume to load
new hooks; verify hook uptake separately from isolated tests.

## Auto-continue

For interactive Claude and Codex sessions, the Stop hook blocks once when a card explicitly
linked to that session is active and has a next plan step. Headless runs
are never continued. It will not block while an `AskUserQuestion` or `ExitPlanMode`
tool is unresolved, while Claude is in plan permission mode, or when the last non-empty
assistant text asks the owner a question. It will not repeat for the same card, position,
and step text; advancing the plan enables the next reminder. A session is capped at 25
continuations. The reminder fences the card's step text as data and clips it to 200
characters rather than treating card content as instructions.
`KEEP_AUTO_CONTINUE` defaults to `1`; set it to `0` to disable the feature globally, or
add `autocontinue: off` to a card's frontmatter to opt that card out. Codex uses
`keep hook codex stop` on Stop and `keep hook codex start` on SessionStart.
Only a validated interactive root transcript may continue; child threads, pending
tools, and unanswered synchronous or asynchronous questions are protected.
The question PreToolUse matcher is `^(?:.*\.)?request_user_input(?:_async)?$`.

Automatic cleanup checks every five minutes. An agent session becomes eligible 15
minutes after the later of its card's transition to `done` and its last transcript,
pane input, or pane output activity. Every card linked to the session must be done.
Background ledgers, Codex companion jobs, process
children, pinned panes, attached viewers, drafts, and unknown activity protect the
session. Output remains unread until a visible viewer receives the pane history;
unread output protects the session even after the idle window passes.

Eligible sessions use the console's graceful Close path. Only a successfully
submitted `/exit` may progress to the existing timeout-based TERM/KILL fallback;
any refusal, changed input, or safety-check race cancels force escalation. The card
keeps its session link and gets a `closed (daemon): idle N min after done` log entry,
so `keep open <card>` resumes the same Claude or Codex thread.

Managed zsh panes, including shells left after an agent exits, retain their separate
eight-hour cleanup. Shell cleanup requires a verified empty prompt and no child
processes, and rechecks identity and activity before sending EOF. Exit attempts and
refusals are recorded in `.keep/session-cleanup.json`; failures retry at most once
per hour. Set `KEEP_AUTO_CLOSE_DONE_MIN` to another idle window in minutes. Set
`KEEP_AUTO_CLOSE=0` to disable both agent and shell automatic cleanup.

Automatic Codex cleanup can retire parents with completed remote children only
when the full, identity-checked descendant history proves completion and remains
unchanged before exit. Missing/legacy child evidence, yielded commands and local
child processes remain protected. The existing age, pin, viewer, draft and task
guards still apply; explicit Close retains its separate graceful-then-force policy.

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

A `device:<serial>` scope names shared hardware, such as a test phone driven from cards
in several repositories. It is the one scope that crosses projects: other projects'
device holds appear in every `keep who`, Claude session-start context, and reviewer
bundle, and `keep who <project> --scope device:<serial>` or `keep wait --no-hold
<project> --scope device:<serial>` matches them from any project. An unscoped
`keep wait --no-hold` still waits only on its own project's holds. Serials are
lowercased, so `--scope device:ABC123` and `--scope device:abc123` are the same hold.

## Alerts and the morning brief

`keep alert` adds a judged push layer in front of Keep's cards. `attention` is for
something the owner should see soon; `urgent` is for something that warrants an immediate
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
open needs, overdue checks, deferred alerts, recent
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
normal duplicate checks. `--dry` prints the evidence and prompt without
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
  "project": "~/work/example",
  "steps": {
    "image": {
      "title": "Build the image",
      "paths": ["packer/**", "host-agent/**"],
      "from": "landed",
      "worktree": "~/work/example.step-image",
      "prepare": "yarn install --frozen-lockfile",
      "command": "cd packer && ./build.sh",
      "artifactPattern": "ami-[0-9a-f]{8,}",
      "next": "update the affected pin and follow the canary procedure",
      "defaultHold": "+2h"
    }
  }
}
```

Long messages injected into sessions are typed in paced chunks and, for Claude
sessions, verified against the transcript after submit; truncated delivery is logged.

## Scheduled checks and runs

When a scheduled check becomes due, Keep first sends its recipe into the most recent
eligible linked Claude or Codex thread. A successful delivery is recorded in
`.keep/runs/<taskId>.delivered.json` for that exact `check_after`, so daemon restarts do
not redeliver it; the thread must check in with `--clear-check-after` or reschedule it.
An open linked thread remains eligible even after hours of inactivity. A thread that
is mid-turn or waiting on the owner defers the check for 120 scheduler ticks (about two hours) by default
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
keep-reviewer <model>    # override with a model available to your Claude installation
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
and can use `--cards a,b,c` to leave linked reviewer check-ins on the evidence cards.
The message should name the observed pattern, cite the cards, sessions, or commits that
demonstrate it, and propose the workflow or Keep change.

The model argument is passed to `claude --model` verbatim. Model aliases resolve
according to your Claude installation and account access.
Do not substitute a pinned id unless you mean to freeze the version. Only the family
name is derived from it, for the budget governor (which matches the `Fable wk` usage
limit by label prefix) and for the `review (fable)` heading findings land under.

Switching models means restarting the session: the model is fixed at launch, and the
governor reads it from the `.keep/reviewer/<id>` marker written at startup.

### Trust boundary — accepted risk

The reviewer runs as an ordinary agent session with the permissions supplied at
launch. Review bundles include untrusted transcript content. The bundled procedure
is guidance, not an operating-system sandbox; choose permissions appropriate for
your environment. Keep's deterministic guards and audit logs supplement those
permissions. Do not treat model instructions as access control.

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

## Per-card model usage

`keep usage <card> [--json]` shows local Claude and Codex token usage by model.
The card detail and console session header show the same expandable breakdown.
`keep serve` collects every 30 seconds in a separate process; the first collection
sets a durable start time. There is no historical backfill. Old transcript records
are read only to establish counter baselines and suppress copied responses.

Input, cache reads, cache writes, and output are disjoint buckets. Reasoning tokens
are available in JSON and already included in output. These are reported tokens,
not subscription charges or dollar estimates. `calls` counts distinct Claude
responses and positive Codex usage deltas; a Codex delta can cover multiple calls
if the transcript omitted intermediate usage events.

A session claim records an accounting ownership transition independently of its
movable resume link. Usage belongs to the card linked when the first usage record
for that response was timestamped; later chunks update that response on the same
card. Child sessions inherit the parent's card at spawn and retain it when the
parent changes cards. Claude subagent paths, Codex parent metadata, and Keep's
explicit Claude-to-Codex parent records provide those relationships. Unlinked or
unresolved sessions remain unassigned instead of being guessed from a project.

The local `.keep/card-usage/` directory contains the ownership timeline, a durable
ledger of deduplicated usage records and byte checkpoints, and a dashboard summary.
Keep's existing cross-process lock serializes collection and ownership changes;
atomic replacement commits counts and checkpoints together. Totals survive
restarts, card closure, and source transcript removal. Preserve this directory to
preserve accounting; it is not synced through Git. Missing/corrupt evidence is
reported as incomplete or as a `card-usage` health error, never silently reset.
Only transcripts available on this machine can be measured.

## Reviewer evidence quality, repeated probes, and outcomes

Treat a bundle as a delta, not a complete authorization or test history. Label each
finding `observed`, `inferred`, or `needs-verification` using `basis` in landing JSON
(or `--basis` for review-note). An observed finding also requires `evidence` with
specific references and `checked` describing what you actually verified. Before
alleging missing authorization, tests, or unsafe action, inspect the relevant earlier
human instruction and owning/parent session or cited test result. If you cannot,
state the uncertainty and the next verification step. Unverified findings cannot
trigger live nudges or speaker announcements. Absence from the delta is not proof.

A bundle may identify complete identical scheduled probes. Only after inspecting the
exact tool inputs and verifying that they are read-only and results are clean, add
`"probeSafe": true` to that card's ack (or `review-ack --probe-safe`). Generic browser
JavaScript needs inspection too. This approves only that exact fingerprint. After
two clean reviews, unchanged probes back off from one hour to two hours to a four-hour
cap; changed prompts, calls, results, errors, human activity, card or repository work
bypass that backoff. Skipped probes do not advance evidence cursors. Unknown transcript
formats stay reviewable. Use `keep review-replay <card> [--session <id>] [--since ISO]`
for a read-only historical estimate; it cannot reconstruct external Git/card changes.

Owners and working sessions record explicit outcomes with
`keep review-outcome <card> <key> <status> -m "reason" --evidence "check-in/commit reference"`.
Statuses are `fixed`, `confirmed-deferred`, `incorrect`, `superseded`, and `unresolved`.
The reviewer does not grade its own findings. Silence is unresolved, not agreement.
Use `keep review-outcome [card] --json` to read outcomes; stats report all-time counts.
Incorrect and superseded findings stay suppressed, including forced repetitions.
Fixed/deferred findings may re-enter when source or status changes. If new evidence
invalidates a correction, ask the owner/working session to reopen it explicitly.
During compaction preserve the correction, evidence reference and resulting lesson;
bundles also carry recent incorrect findings so a fresh session can recover them.

Before posting or acknowledging, Keep checks that the card still matches the evidence
snapshot. A newer owner check-in, status, plan, schedule, need, dependency or session
link invalidates it; `--force` does not bypass this. On a freshness refusal, rebuild
that card's bundle and reconsider the finding. Other cards in the batch may still land.

Bundles include at most four related-work leads: explicit dependencies/successors and
specific topic matches in the same project, including completed/archived cards and
recorded outcomes. Before claiming unfinished or unowned work, read relevant leads.
A match is not proof that every defect is fixed: an OOM fix does not settle teardown
re-entry or lost failure reasons. Check the current phase before recommending a
project change; CLI implementation and image deployment can belong to different repos.

For uncertain notes supply `question` (the verification question) and `unknown`
(the evidence still missing), using `--question`/`--unknown` in review-note. The public
report opens with that question and quotes the message as an unverified hypothesis.
Use the same wording in your final tick summary. Do not put a confident accusation
under a needs-verification label. Unverified notes cannot apply status changes;
observed notes still require evidence references and verification performed.

### Offline reviewer evaluation

`keep review-eval --run [--model fable] [--skill candidate.md] --json` evaluates
frozen, sanitized cases without live findings or registry changes. Save the JSON and
pass `--compare baseline.json` on later runs of the same corpus. `--prompt` previews
the label-free input; `--predictions result.json` scores saved output without a model
call. Results are informational and never gate pushes or restarts. See
[Reviewer evaluation](reviewer-evaluation.md) for metrics, corpus limitations and
custom suite format.

The stalled daemon sweep and `keep codex-jobs --reap` also inspect orphaned
interactive Codex and Claude processes. This check uses **PPID 1 and missing live
pane/session ownership**, never process age or transcript idle time. Known session
PIDs, explicit resume IDs, child processes, open conversation files, and running
companion work protect a process. Unknown host, process, or companion evidence
refuses cleanup. Only the current user's recognized interactive agent executables
qualify; shell wrappers, headless commands, and unknown arguments are excluded.
The reaper refreshes identity and safety evidence before SIGTERM. Use
`keep codex-jobs --reap --dry` to inspect planned actions without sending signals.
