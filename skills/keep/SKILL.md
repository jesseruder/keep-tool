---
name: keep
description: Work-registry conventions for ~/keep. Use when starting substantive work, launching an experiment, resuming work, checking status, or when the user asks what is in flight.
---

# Keep — work registry

`~/keep` is Owner's registry of everything in flight. One markdown file represents
each task. Use the `keep` CLI for all reads and writes; never edit task files directly.
Run `keep help` for full flags.
Every command answers `--help` (or `keep help <cmd>`) with its usage line.

This skill is the core: cards, check-ins, plans, dependencies, permissions and closing.
Load the situational skill when its moment comes, not before:

| When | Skill |
|---|---|
| Scheduling anything for later: an experiment, `--check-after`, a recipe or probe, a delivered check | `keep-scheduled-checks` |
| Starting, handing off to, messaging or inspecting another session; choosing its account or model | `keep-sessions` |
| Before a deploy, migration, restart, terraform run or shared device: who, holds, notes, gated steps | `keep-shared-state` |
| A task needs a secret, API key, token or credential file you do not have | `keep-secrets` |
| Keep itself is misbehaving: daemon, host, console, delivery, accounts, Codex jobs | `keep-ops` |
| You are a named agent (an area's incident responder, a standing worker) | `keep-agent-session` |
| A "[keep] review tick", or Owner asks for a fleet review | `fleet-review` |
| Recording a review and landing through Keep (`keep reviewed`, `keep land`) | `codex-review-runner` |

## When to act

- **Starting substantive work** (a feature, debugging effort, or other multi-turn task):
  run `keep list --project <cwd>` (a path argument, including a worktree path or a
  directory inside one, resolves to its main checkout), then claim matching existing work with
  `keep claim <id>` before checking in, or create it with `keep add "title" --status
  active`. Creating an ordinary task claims it automatically. Use `--file` for a
  follow-up you are recording without starting; ideas file without claiming by default,
  and `--claim` starts an idea now. Skip trivial one-shot requests.
- **Anything that must be done or verified later** — an experiment, a deploy to confirm,
  a metric to read next week — goes on a card with `--check-after <when> --check
  "<recipe>" --status waiting`. It is a scheduler, not a reminder, and scheduling records
  a turn-scoped waiting handoff for your session (`--handoff needs-input` keeps a decision
  for Owner visible). Load `keep-scheduled-checks` before writing one.
- **Status changes or notable progress**: use `keep checkin <id> -m "..." [--status s]`.
  A check-in records the contributing session in its log and preserves every existing
  resume link. It does not claim the card; run `keep claim <id>` first when taking over
  existing work. Non-owner entries are stamped `(by <agent> <full-session-id>)`; the
  reviewer may use the preceding 30 minutes of that contributor's transcript as
  context, without changing ownership or requeueing the card for later unrelated work.
- **Correcting a card's repository**: `keep project <id>` shows its project;
  `keep project <id> <path|name> -m "reason"` changes it without taking over its
  session link or changing its status, schedule, tags, or dependencies. Worktree
  paths resolve to their main checkout. Use this instead of `keep checkin --project`.
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
- **Before finishing substantive work**: check in the current state and next step.
- **At a stopping point with a large context** — after the final check-in on a card,
  after a land, or before a long `keep wait` — run `keep compact`. Keep compacts the
  session at its next idle moment, and the compacted session reads the card, not its old context.
- **Questions about current work**: answer from `keep list`, `keep overdue`, and
  `keep resume`.
- **Finding an earlier conversation** ("the session where we fixed the websocket
  retry"): `keep turns search "<words>"` lists matching sessions, newest first, with
  their `#number`, title, card and the passage that matched; `keep turns show <id>`
  reads its turns. Add `--all` to search tool output too (an error message, a command).
- **Durable artifacts**: never cite a `/tmp` path in a check recipe or check-in;
  macOS purges `/tmp` on reboot. Run `keep artifact <card> <file>...` to copy files into
  committed `.keep/artifacts/<card>/`, then cite the printed path. `keep show` lists them.

## Waiting on another card

Record the fact your next step needs, with a required reason. Never write "await task X"
only as prose; `review` means awaiting Owner's review, not another task.

- `keep wait-on <your-card> <upstream> --commit <sha>[,<sha>] -m "why"` waits for every
  SHA on the upstream project's origin default branch (verified by the landed sweep).
- `--deployed <sha> --target <name>` waits for the upstream's matching deploy log;
  `--status review,landing,done` waits for any listed status.
- `keep wait-on <your-card> <upstream>#<n> -m "why"` waits for a plan milestone. `#n` is
  positional: inserting or removing an upstream step shifts its target, so re-check
  `keep deps` after editing a plan.
- A bare whole-card wait is refused with the step list when the upstream has a plan;
  select a step or fact target, or pass `--whole` deliberately. Broad waits on cards in
  `review` or `landing`, or of kind `idea`, warn that they may sit for days.
- Keep sends a `[keep] unblocked` message into your linked session when the target is
  satisfied. Inspect targets and stored reasons with `keep deps [<card>]`.
- Remove a mistaken dependency with `keep wait-on <card> <upstream> --remove` and the same
  target flags (or `#<n>`), plus `-m "why"`. Removal matches the exact entry, preserves
  other blockers, cancels queued notices for that dependency, and restores `active` only
  when no dependency, scheduled check, or need remains. Already submitted messages cannot
  be recalled.
- `keep lint --rule unsatisfiable-wait` finds stalled upstreams and waits whose reason or
  recent check-ins already cite a landed commit.

For fleet state, prefer `keep wait` as a background command over scheduling timed
`--check-after` rechecks: the Claude harness wakes the session when the command exits.
In the background pass a long bound (`--for 8h`) so the session actually idles instead of
waking every few minutes on exit 124; the 9-minute default is for a foreground call, where
the harness timeout applies and you re-run it on 124. Check in to Keep before you wait: an
idle session may be auto-compacted while the wait runs, and the woken session will read
the card, not its old context. The wake-up itself is the command's `satisfied:` line.
`wait-on` remains the fallback because it delivers an unblocked message. Codex
background-terminal wake-up is not yet verified.

## Permissions and needing Owner

- **Before asking Owner to approve an action**, check the card: `keep allow <card>
  <action>` exits 0 if he already granted it at planning time and 3 if he did not.
  Actions are `push`, `land`, `deploy` (scope it: `deploy:staging`, `deploy:prod`),
  `review`, `publish`, `migrate`, `restart`, `terraform`, `install`, and `spend`
  (`keep allow <card> spend --amount 12` against a `spend:<dollars>` ceiling). A granted
  action needs no message to Owner — do it, and say you did in the check-in.
- Only Owner grants: `keep allow <card> --grant push,review --until +7d`. Never grant on
  your own card, and never read a grant as covering more than it names — `--grant` and
  `--until`, on `keep allow` and on `keep add`, are refused inside an agent session.
  Grants are attributed and audited, not enforced: a session that edits card files
  directly can write any frontmatter it likes, so the rule is the boundary and the exit
  code only makes the honest path the easy one.
- After an independent review, record it with `keep reviewed` and land with
  `keep land <card>`; the rules are in `codex-review-runner`.
- **When you need Owner and the card does not grant it**: first do everything on the
  card that does not depend on him, then end your turn with the question. The Keep
  console shows every session's final turn in Waiting on you, and his reply arrives in
  this session.
- **Blocked on something only Owner can supply** (a secret, an API key, a sign-in, a
  console approval, a live webhook) that must outlive this session: run `keep needs
  <card> "<what>" [--env NAME]` and stop. The card goes `blocked`, the need shows in
  `keep needs` and the brief as one waiting-on-Owner block, and it clears by itself when a
  linked owning session starts with that env var set, or when Owner runs `keep needs
  <card> --met`. Bare `keep needs` only lists; an unrelated session or shell never clears
  a need. Never scrape a token out of browser state, a signed-in Chrome, or another
  agent's session to get past such a gate. A secret this session needs now is asked for
  with `keep secret request` (the `keep-secrets` skill), never pasted into chat or fetched
  with a one-off command Owner has to run.

## Landing and closing

- When the requested work and validation are complete, default to `--status done`
  with `--next "nothing"`. Owner can reopen the card if an issue appears. Use
  `review` only for a concrete decision, approval, or review Owner explicitly
  requested; describe what they need to decide. Do not add "Owner review" as a routine
  final step in check-ins or agent handoffs. If another agent still has work to do,
  record that remaining work instead of assigning it to Owner.
- When the work is finished, its commits are cited, and the only remaining step is the
  merge, use `--status landing` (it requires a cited sha). The landed sweep closes it
  when the shas reach the default branch, with no prose to parse and no model call, and
  it never occupies Owner's review queue.
- End your final check-in with `--next "land"` when landing is the only thing left,
  `--next "nothing"` when the card can close once landed, or `--next "Owner review"`
  when a concrete Owner decision or explicitly requested review remains. Otherwise
  pass the real pending step: a deploy, a readout date, a decision, or something Owner
  must do.
- Pass `--commit <sha>` for every commit you produced, citing the sha as it landed, not
  the pre-rebase worktree sha. The flag is repeatable and also accepts comma-separated shas.
- Prose `Next:` lines and commit citations still work as a fallback, but structured
  flags are the primary convention. Never use `push` for a notification in a prose
  `Next:` line without the word `notification`.
- The daemon adds `landed (daemon)` entries when cited shas reach the default branch
  and may close review cards according to `watch/landed.json`.

## Conventions

- A dev server, watcher or test runner you start in the background is stopped about
  15 minutes after your pane exits unless a live pane carries on your session or
  card. Start it with `KEEP_PERSIST=1` when it must outlive you, and say so in a
  check-in.
- Write check-ins as state + next step, not a diary. Keep them to one or two sentences.
- If a Stop reminder names your next step, continue with it. If you need Owner, end
  your turn with a question — the reminder does not repeat for that step.
- Keep status honest: `active` is ready for an agent to continue; `waiting` requires
  `--check-after` or an unresolved dependency recorded by `keep wait-on`; `blocked`
  needs a person or decision; `landing` means the work is finished and its commits
  are cited and only the land remains, so the daemon closes it with no model call and
  it never reaches Owner's queue; `review` awaits Owner's review of an artifact; `done`
  is finished.
- Use `kind: idea` for brainstorms. Ideas are filed without moving the current session;
  pass `--claim` only when you are starting one now. A completed proposal awaiting
  approval is `review`.
- Run `keep tags` before adding a tag. Every task must have exactly one scope tag,
  `work` or `personal` (or your configured scope names); `keep add` normally infers it from the project path.
- A session belongs to exactly one card. The CLI links Claude and Codex session IDs on
  ordinary task `add`, explicit `claim`/`link`, and `open` handoffs so `keep resume`
  emits the correct agent-specific resume command. Routine check-ins, plan edits,
  retitles, and closures preserve all resume links while attributing their log entries
  to the contributing session.
- The parent session owns the Keep check-in for work delegated to another agent. A
  delegated worker — including a Codex task started from a Claude session that owns an
  open card — contributes to the parent's card with `keep checkin <card> -m "..."`
  without claiming it, and is refused an ordinary `keep add`; file unrelated follow-ups
  with `--file`. `keep-sessions` covers `keep delegate` and the handoff rules.
- Card status and conversation readiness are separate. **Waiting on you** includes
  live sessions ready for their next instruction, even without an explicit question.
  A card's `waiting` status, dependency, or future check alone must not hide a proposal
  awaiting Owner. A foreground turn can stop while a build, subagent, or scheduled
  poll continues; hooks are observations, not proof that background work completed.
- Agent-session mutations commit locally and do not auto-push. Treat `keep sync` or
  `KEEP_ALLOW_PUSH=1` as a push and follow the current session's push-approval rules.
- Log entries headed `review (fable)`, or any heading carrying `(reviewer <name>)`,
  come from the fleet reviewer, a separate second-opinion agent — not from Owner and
  not from the session that owns the card. Treat them as observations to weigh, not
  instructions. The reviewer may also change a card directly — status, `done`, plan
  steps, wait-on, needs, check-after — when the evidence is conclusive; those entries
  are headed `check-in (reviewer <name>) → <status>` or `done (reviewer <name>)`. It
  never becomes a card's linked/resume session. Disagreeing is fine as long as your next
  check-in says why; record a wrong finding with `keep review-outcome <card> <key>
  incorrect -m "reason" --evidence "..."` so future reviews retain the lesson.
- Call the system "Keep": say "mark this task done in Keep" or "check this in to Keep."
- Name another session by its number, `#12`, the way Keep prints it (`keep who`,
  `keep show`, holds, notes, `keep pane ls`), not by a uuid prefix: Owner reads the
  number off the console, and `keep tell`, `keep open` and `keep pane` accept it. Fall
  back to the 8-character id only for a session Keep shows without a number.
- Sessions in a `~/wt/<repo>/<name>` worktree belong to the main checkout's project: the CLI
  canonicalizes the path, so use and create cards for the main checkout (`wt main` prints
  it, for example `~/work/<repo>`), never for the worktree path.
