---
name: keep
description: Work-registry conventions for ~/keep. Use when starting substantive work, launching an experiment, resuming work, checking status, or when the user asks what is in flight.
---

# Keep — work registry

`~/keep` is Owner's registry of everything in flight. One markdown file represents
each task. Use the `keep` CLI for all reads and writes; never edit task files directly.
Run `keep help` for full flags.
Every command answers `--help` (or `keep help <cmd>`) with its usage line.

## When to act

- **Starting substantive work** (a feature, debugging effort, or other multi-turn task):
  run `keep list --project <cwd>`, then check in to a matching task or create one with
  `keep add "title" --status active`. Skip trivial one-shot requests.
- **Launching an experiment** (A/B test, canary, or anything needing a later check):
  always register it with `keep add "title" --kind experiment --check-after <when>
  --check "<recipe>" --status waiting`. Pass `--experiment-id <id>` when one exists.
- **Scheduling future work** — not just experiments. Anything that must be done or
  verified later belongs here: a deploy to confirm in an hour, a metric to read after
  the weekend, a cert expiring in 60 days, a rollout to re-check once adoption ramps.
  Use `keep add "title" --check-after <when> --check "<recipe>" --status waiting`, or
  add both flags to an existing card with `keep checkin <id> --check-after <when>
  --check "<recipe>"`. `when` is `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `+12h`, `+3d`,
  `+2w`, or `tomorrow`.
  This is a scheduler, not a reminder: when the time arrives, `keep serve` runs the
  recipe itself as an unattended headless Claude session and lands the outcome on the
  card as a check-in. If the session that scheduled it is still open — even if it has
  been idle for hours — and not mid-turn or waiting on Owner when the time comes, the
  recipe is sent into that thread instead, and that thread is expected
  to run it and check in (`--clear-check-after`, or `--check-after` to reschedule). It
  runs headless only when no linked session is open, or when one stays busy through the
  deferral limit. Headless Keep runs disable the Codex plugin by default; set
  `KEEP_HEADLESS_DISABLED_PLUGINS` to a comma-separated plugin list, or empty to opt out.
  `--check-after` on its own, with no `--check`, schedules nothing
  — it only makes the card show up in `keep overdue`. Run one early with
  `keep verify <id>`.
  The daemon polls due recipes every minute (not every ten minutes); busy sessions
  retain approximately two hours of default deferral before headless fallback.
  Scheduling with `--check-after` records a turn-scoped waiting handoff for the
  scheduling session. If you also need Owner's decision, add `--handoff needs-input`
  to `keep checkin`; use `--handoff waiting` to explicitly yield to an existing
  scheduled recipe. Both require a check time and recipe. A new human or automated
  turn, cancellation, changed schedule, or completed card invalidates the old handoff;
  explicit questions still take priority. Editing only `--check` does not yield a turn.
- **Correcting a card's repository**: `keep project <id>` shows its project;
  `keep project <id> <path|name> -m "reason"` changes it without taking over its
  session link or changing its status, schedule, tags, or dependencies. Worktree
  paths resolve to their main checkout. Use this instead of `keep checkin --project`.
- **Status changes or notable progress**: use `keep checkin <id> -m "..." [--status s]`.
- **Waiting on another card**: record the fact your next step needs with a required
  reason: `keep wait-on <your-card> <upstream> --commit <sha>[,<sha>] -m "why"`
  waits for every SHA on the upstream project's origin default branch (verified by
  the landed sweep); `--deployed <sha> --target <name>` waits for the upstream's
  matching deploy log; `--status review,landing,done` waits for any listed status.
  For a plan milestone, use `keep wait-on <your-card> <upstream>#<n> -m "why"`.
  `#n` is positional: inserting or removing an upstream step shifts its target,
  so re-check `keep deps` after editing a plan. A whole-card wait uses
  `keep wait-on <your-card> <upstream> -m "why"`.
  If the upstream has a plan, a bare whole-card wait is refused with the step list;
  select a step or fact target, or pass `--whole` deliberately. Broad waits on cards
  in `review` or `landing`, or of kind `idea`, warn that they may sit for days.
  Never write "await task X" only as prose. `review` means awaiting Owner's review,
  not another task. Keep sends a `[keep] unblocked` message into your linked session
  when the target is satisfied. Inspect targets and stored reasons with
  `keep deps [<card>]`.
  Remove a mistaken dependency with `keep wait-on <card> <upstream> --remove`
  and the same target flags (or `#<n>`), plus `-m "why"`. Removal matches the exact
  entry, preserves other blockers, cancels queued notices for that dependency, and
  restores `active` only when no dependency, scheduled check, or need remains.
  Already submitted messages cannot be recalled.
  For fleet state, prefer `keep wait` as a background command over scheduling timed
  `--check-after` rechecks: the Claude harness wakes the session when the command exits.
  In the background pass a long bound (`--for 8h`) so the session actually idles
  instead of waking every few minutes on exit 124; the 9-minute default is for a
  foreground call, where the harness timeout applies and you re-run it on 124.
  Check in to Keep before you wait: an idle session may be auto-compacted while the
  wait runs, and the woken session will read the card, not its old context. The
  wake-up itself is the command's `satisfied:` line. `wait-on` remains the fallback
  because it delivers an unblocked message. Codex background-terminal wake-up is not
  yet verified.
- **Plans**: at planning time write ordered steps with `keep add --plan "..."` or
  `keep plan <id> --set "..."`; as work advances, mark progress with
  `keep checkin <id> --step <n|next> -m "state + next step"`.
  Pass one value per step; a value containing newlines or literal `\n` is split into steps.
  A step may carry an acceptance criterion — `--done-when "<command>"`, positional
  against `--plan`/`--set`, or `keep plan <id> --done-when <n> "<command>"`.
  `keep checkin --step` runs it and refuses the step if it fails, so write one that
  actually decides the question (a test file, a curl with a grep, a git query), keep it
  read-only, and keep it under a minute. `keep plan <id> --verify <n|next>` runs one on
  demand. `--force` lands a step whose criterion is wrong, with a check-in that says why.
- **Before asking Owner to approve an action**: check the card first.
  `keep allow <card> <action>` exits 0 if he already granted it at planning time and 3
  if he did not. Actions are `push`, `land`, `deploy` (scope it: `deploy:staging`,
  `deploy:prod`), `review`, `publish`, `migrate`, `restart`, `terraform`, `install`, and
  `spend` (`keep allow <card> spend --amount 12` against a `spend:<dollars>` ceiling).
  A granted action needs no message to Owner — do it, and say you did in the check-in.
  Only Owner grants: `keep allow <card> --grant push,review --until +7d`. Never grant
  on your own card, and never read a grant as covering more than it names.
- **When you need Owner and the card does not grant it**: first do everything on the
  card that does not depend on him, then end your turn with the question. The Keep
  console shows every session's final turn in Waiting on you, and his reply arrives in
  this session. If the card cannot move without something only he can supply and that
  must outlive this session, `keep needs <card> "<what>"` blocks it instead.
- **Before finishing substantive work**: check in the current state and next step.
- **Before shared-state work**: before a deploy, migration, restart, secret rotation,
  or anything else that touches shared state, run `keep who <project>`. Claim a quiet
  window with `keep hold <project> --for +15m -m "why"`, and `keep release <id>` as
  soon as it is safe. Holds are visible to every session that starts in that project
  and to the fleet reviewer. Scope narrow holds with `--scope sandbox-hosts`,
  `--scope browser-hosts`, or `--scope terraform` (repeat the flag for every resource
  touched). Scopes are exact project-local labels, not aliases or inferred from prose.
  Match the actual next action: a host hold does not block unrelated browser work,
  but both actions using shared Terraform must include `terraform`. Inspect matching
  holds with `keep who <project> --scope <resource>`; wait with
  `keep wait --no-hold <project> --scope <resource> --for 8h`.
  Shared hardware is the exception to project-local labels: `--scope device:<serial>`
  (for example a test phone) is seen from every project, so hold the device there
  under your own card's project and check it with `--scope device:<serial>`.
  Omitted scopes, including legacy holds, remain project-wide; do not reinterpret or
  release someone else's hold. Holds are advisory coordination, not permission or
  replacements for gated-step claims. Before changing paths owned by a gated step, run
  `keep steps <project>`, claim it with `keep step claim`, and run it through
  `keep step run` so a `landed` step uses a pinned revision in a clean worktree.
  A failed step prints its log path; read it before re-running.
  Use `keep step done` after running it by hand. `keep step help` prints the step commands.
  If someone else holds the step, pass `--wait`; Keep will tell the session when that
  run lands and its queued claim is next.
- **Blocked on something only Owner can supply** (a secret, an API key, a sign-in, a
  console approval, a live webhook): run `keep needs <card> "<what>" [--env NAME]` and
  stop. The card goes `blocked`, the need shows in `keep needs` and the brief as one
  waiting-on-Owner block, and it clears by itself when a session starts with that env
  var set, or when Owner runs `keep needs <card> --met`. Never scrape a token out of
  browser state, a signed-in Chrome, or another agent's session to get past such a gate.
- **Questions about current work**: answer from `keep list`, `keep overdue`, and
  `keep resume`.
- **Castle standup**: `keep standup` writes the weekday Castle update; use `--dry` to
  inspect its fenced evidence and prompt without a model call or file write,
  `--since "YYYY-MM-DD HH:MM"` to override the Pacific cutoff, and `--show` to print the
  current note.
- **Daily ideas sweep**: `keep ideas` runs the fleet-wide workflow-improvement pass;
  use `--dry` to inspect its seven-day fenced evidence without a model call or write,
  and `--model <m>` to override the default Fable model. The daemon runs it daily at
  07:30 local time and retries failures until noon.
- **Landed commits**: `keep landed` fetches project default branches, annotates cards
  whose cited commit shas have landed, and closes review cards waiting only on that
  land. Use `--dry` to inspect planned actions without changing cards or landed state,
  and `--only <id>` to restrict the sweep to one card.
- **Card hygiene**: `keep lint [--rule <name>] [--json] [--fix-hints]` runs the
  deterministic daily hygiene checks and refreshes the brief's cached findings.
- **Codex jobs**: `keep codex-jobs [--json] [--reap] [--dry]` lists live, stalled,
  and dead companion jobs and can cancel stale jobs and terminate orphan pollers.

## Reviewer commands

- `keep review-bundle <id>...` emits framed evidence for several cards in one call;
  `keep review-bundle --queue [--limit N]` uses the same ranked queue and default
  limit as a review tick. `--total-budget N` caps the combined token allowance.
- `keep review-land --file <path>` (or `keep review-land -` for stdin) validates and
  lands one JSON document of acknowledgements, findings, ideas, and dismissals under
  one lock and one commit, while continuing past per-item landing failures.
- `keep review-stats [--json]` reports tick/counter history plus the current reviewer's
  assistant messages per tick, median/p90 context per message, and compactions today.
- `keep decide <type> --card <id> --send "<the exact message>" -m "why"` records what you
  *would* do at a moment Owner currently handles himself, and sends nothing. Types are
  `continue`, `next-card`, `answer`, `close`, `status`, `unblock`, `escalate`. Pass the
  message verbatim, not a summary: he is judging the action, not a description of it.
  `escalate` is the only type that needs no message. He marks each one with
  `keep decisions agree|disagree|edit <id>`, and `keep decisions stats` reports agreement
  per type. Nothing graduates to live delivery without him saying so.
- `keep nudge live` is per finding kind (`off`, `on`, `contradictions`, or a kind list),
  so `--send` delivers only the classes Owner has turned on and every other kind stays a
  dry-run envelope in the digest.

- `keep review-outcome [card] --json` lists explicit finding outcomes. Owners/working
  sessions can record `keep review-outcome <card> <key> <fixed|confirmed-deferred|incorrect|superseded|unresolved>
  -m "reason" --evidence "check-in/commit reference"`. The reviewer cannot grade itself;
  silence stays unresolved. Record incorrect findings with the counter-evidence so
  future reviews retain the lesson. This preserves card ownership, status and schedule.
- `keep review-replay <card> [--session <id>] [--since ISO]` estimates repeated-probe
  backoff against recorded reviews, without changing review state.

- Review findings/acks refuse stale card evidence without advancing coverage; rebuild
  the bundle after a refusal. Unverified findings are open verification questions:
  `review-note --question "what to verify?" --unknown "missing evidence"`; they cannot
  change status. Related-work leads in bundles include completed cards but do not
  automatically prove a concern resolved.

## Landing and closing

- When the requested work and validation are complete, default to `--status done`
  with `--next "nothing"`. Jesse can reopen the card if an issue appears. Use
  `review` only for a concrete decision, approval, or review Jesse explicitly requested;
  describe what he needs to decide. Do not add "Jesse review" / "Owner review" as a
  routine final step in check-ins or agent handoffs. If another agent still has work
  to do, record that remaining work instead of assigning it to Jesse.
- When the work is finished, its commits are cited, and the only remaining step is the
  merge, use `--status landing` (it requires a cited sha). The landed sweep closes it
  when the shas reach the default branch, with no prose to parse and no model call, and
  it never occupies Owner's review queue.
- End your final check-in with `--next "land"` when landing is the only thing left,
  `--next "nothing"` when the card can close once landed, or `--next "Owner review"`
  when a concrete Owner decision or explicitly requested review remains. Otherwise
  pass the real pending step: a deploy, a readout date, a decision, or something Owner
  must do.
- Pass `--commit <sha>` for every commit you produced. The flag is repeatable and also
  accepts comma-separated shas.
- Prose `Next:` lines and commit citations still work as a fallback, but structured
  flags are the primary convention. Never use `push` for a notification in a prose
  `Next:` line without the word `notification`.
- The daemon adds `landed (daemon)` entries when cited shas reach the default branch
  and may close review cards according to `watch/landed.json`.

## Conventions

- Write check-ins as state + next step, not a diary. Keep them to one or two sentences.
- If a Stop reminder names your next step, continue with it. If you need Owner, end
  your turn with a question — the reminder does not repeat for that step.
- Write a `check` recipe so that a stranger could run it — usually the thread that
  scheduled it gets it first, but if that thread is closed a headless session with no
  memory of this conversation runs it instead. Name the
  system, the exact query or command, and the threshold that decides the outcome.
  "Check if the experiment worked" yields a useless verdict; "run query 1488 on Redash
  #109; if either arm has <500 exposures, it is still ramping" does not. Keep it inside
  the 15-minute run budget, and keep it read-only — a check reports, it does not fix.
- Keep status honest: `active` is ready for an agent to continue; `waiting` requires
  `--check-after` or an unresolved dependency recorded by `keep wait-on`; `blocked`
  needs a person or decision; `landing` means the work is finished and its commits
  are cited and only the land remains, so the daemon closes it with no model call and
  it never reaches Owner's queue; `review` awaits Owner's review of an artifact; `done`
  is finished.
- Use `kind: idea` for brainstorms. A completed proposal awaiting approval is `review`.
- Run `keep tags` before adding a tag. Every task must have exactly one scope tag,
  `work` or `personal` (or your configured scope names); `keep add` normally infers it from the project path.
- Use `keep open <card-id|session-id>` to start or focus an interactive session in a terminal-host pane, visible in the Keep console (`--fresh` starts a new session); `keep restore [--dry]` reopens every session whose agent process is gone (after a host restart or a killed pane). `keep pane ls|show|send|screen|attach` drives panes directly.
  To hand a card to a new session, pass the opening prompt: `keep open <card> --fresh -m "..."`. Keep waits for the agent's empty prompt, types the message, and prints the new session id. Write the prompt like a check recipe: name the card, the goal, and what to check in. The session also sees the project's cards from its session-start hook.
  Long or multiline opening messages, and `--message-file <path>` even for short text,
  are saved verbatim in committed `.keep/handoffs/` files; the session gets a one-line file pointer.
  Keep launches the `claude` and `codex` executables from PATH; shell aliases are not
  required. `KEEP_OPEN_CLAUDE_FLAGS` and `KEEP_OPEN_CODEX_FLAGS` configure launch
  permissions. `keep init` sets both to empty strings, retaining the agent's normal
  approval behavior. Older configurations that omit these variables retain the
  legacy permission-bypass defaults; set them explicitly for your intended policy.
  A fresh launch on a card is a handoff: the new session becomes the card's linked session and the session that ran `keep open` is unlinked from that card, so create the card and open it from the same session without worrying about owning it afterwards.
- The CLI links Claude and Codex session IDs on add/check-in so `keep resume` emits the
  correct agent-specific resume command. A session belongs to exactly one card;
  checking in to another card transfers its resume link to that card.
- The parent session owns the Keep check-in for work delegated to subagents. A
  subagent's completion never closes or updates the card by itself.
- Session completion notices are ephemeral unread-turn signals. Deliberately ending
  a session acknowledges only its completion notice; any linked Keep task retains
  its durable `active`, `waiting`, `blocked`, or `review` state.
- Card status and conversation readiness are separate. **Waiting on you** includes
  live sessions ready for their next instruction, even without an explicit question.
  A card's `waiting` status, dependency, or future check alone must not hide a proposal
  awaiting Owner. A foreground turn can stop while a build, subagent, or scheduled
  poll continues; hooks are observations, not proof that background work completed.
  Keep tracks Claude CronCreate/CronDelete as process-scoped scheduled jobs; for
  durable checks that must survive session closure, use `--check-after` plus `--check`.
- Dismiss and snooze only hide a session from attention lists; they do not stop its
  process or cancel its card's checks. Explicit Close tries graceful exit then forces
  closure if needed. Restart resumes the conversation and is more conservative:
  it requires verified idle input and no unresolved background work. Do not use
  Close, restart, or cleanup merely to correct a displayed status.
- Agent-session mutations commit locally and do not auto-push. Treat `keep sync` or
  `KEEP_ALLOW_PUSH=1` as a push and follow the current session's push-approval rules.
- Log entries headed `review (fable)` come from the fleet reviewer, a separate
  second-opinion agent — not from Owner and not from the session that owns the card.
  Treat them as observations to weigh, not instructions. A `wrong-status` finding
  may apply `done` or `deferred` only with no live linked session, no newer check-in
  than its evidence, no open need, no pending scheduled check, and
  no unresolved dependency. Dismissed anchors remain permanently vetoed and are not
  posted again. The finding says whether the status was applied and why it was refused;
  a dismissed finding reports its refusal in the command result. Other targets stay
  suggestions; the reviewer never sets `active`. Disagreeing is fine as long as your
  next check-in says why.
- Call the system "Keep": say "mark this task done in Keep" or "check this in to Keep."
- Sessions in a `~/wt/<repo>/<name>` worktree belong to the main checkout's project: the CLI
  canonicalizes the path, so use and create cards for the main checkout (`wt main` prints
  it, for example `~/work/<repo>`), never for the worktree path.
