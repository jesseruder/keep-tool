---
name: keep-sessions
description: Start, hand off to, message, inspect, delegate to, or move other agent sessions through Keep - keep open (--fresh, --agent, --account, --model, -m), keep tell, keep delegate, keep pane screen, keep restore, keep compact, keep handoff, keep transfer and keep move. Use when asked to start a new session, open a session on a card, hand a card to another session, message or check on another session, pick which account or model a session runs on, move a rate-limited session to another account, or move a session to another node.
---

# Keep — other sessions

Every interactive session runs in a terminal-host pane that the Keep console shows. Start
them, talk to them and move them through `keep`, never by running `claude`, `codex`, or `pi` in a
shell of your own: a session Keep did not launch has no pane, no account record and no
card link. All of this needs `keep serve` running.

## Starting a session

`keep open <card|session-id|#n> [--fresh] [--agent claude|codex|pi] [--account <id>]
[--model <id>] [-m "opening message" | --message-file <path>]`

- `#n` is the console's session number (`12`, `#12` and `s12` all work). Without `--fresh`,
  `keep open` focuses or resumes the existing session; with it, it launches a new one.
- **Work goes on a card first.** `keep add "<title>" --file` (or an existing card), then
  `keep open <card> --fresh -m "..."`. A fresh launch on a card is a handoff: the new
  session becomes the card's linked session and the session that ran `keep open` is
  unlinked from that card, so create the card and open it from the same session without
  worrying about owning it afterwards.
- **Write the opening message like a check recipe**: name the card, the goal, what is
  already known, what to verify, and what to check in. The new session has none of your
  context — only the card, the project's cards where the provider supports that
  context, and this
  message. `-m` waits for the agent's empty prompt, types the message, and prints the new
  session id. Long or multiline messages, and `--message-file` even for short text, are
  saved verbatim in committed `.keep/handoffs/` files; the session gets a one-line pointer.
- Say who verifies and who lands. A handed-off session owns its own tests and its own
  independent review unless you state that you are staying around to do them.
- `--node <name>` launches a fresh session on another configured node, for Claude, Codex
  and Pi alike. A Pi open there is refused unless that node has the Pi Keep extension
  installed (`keep doctor` on the node says). A Pi session on a node still takes no
  `keep tell` and cannot be moved.

### Which account it runs on

`keep accounts list` shows the registered Claude and Codex accounts plus Keep's built-in
`pi/default` profile. Pi uses its own local provider configuration; Keep does not support
additional Pi account profiles. An account that is out of usage produces a session that
cannot take a single turn, so look before you launch:

- If Owner named an account, pass exactly that `--account <id>`. Never substitute another
  one silently; if it is out of usage, say so and ask.
- Otherwise leave `--account` off. A fresh launch then picks the caller's own account
  first, then the default, then the rest, skipping any that are out of usage, and prints
  which account it chose and what it skipped. If every account is exhausted it refuses and
  lists the reset times; report that instead of forcing one with `--account`.
- Read the result line. If it carries a warning that the account is out of usage, the
  session you just opened is stuck: tell Owner rather than reporting the handoff as done.
- A resumed session stays on the account it is pinned to; `--account` with a different id
  is refused. Moving one is a handoff or transfer (below).

### Which model

`--model <id>` launches that one process on a model (`claude --model`, `codex -m`, or
`pi --model`) and
records it in the pane meta; it never changes `~/.claude/settings.json`, unlike typing
`/model` as the first message. Omit it for the agent's default. Match the model to the
work: routine implementation does not need the scarcest model.

Keep launches the `claude`, `codex`, and `pi` executables from PATH; shell aliases are
not required. `KEEP_OPEN_CLAUDE_FLAGS` and `KEEP_OPEN_CODEX_FLAGS` configure the two
providers' launch permissions. Pi has no corresponding Keep launch flag setting and
keeps its normal Pi configuration. `keep init` sets the two variables to empty strings,
retaining the agent's normal approval behavior. Older configurations that omit them retain
the legacy permission-bypass defaults; set them explicitly for your intended policy.

## Messaging a live session

`keep tell <card|session-id|#n> -m "message" [--message-file <path>] [--wait <duration>] [--dry]`

Pi cannot currently receive a Keep relay message. `keep tell` to a Pi session is
unavailable; use the Pi pane directly when the user has authorized a message.

Pi is not available in Review Queue automatic launches. Choose Claude or Codex for
that workflow.

- A card target means the live session linked to that card. The message arrives framed as
  coming from your session and card, marked as another agent rather than Owner, with the
  command to reply.
- It is refused, with the reason, when the target is mid-turn (`busy`), is waiting on Owner
  (a question, a plan, a permission prompt), has an unsent draft, is rate-limited or exited,
  is the reviewer, or is you. `--wait +10m` retries while the target is only busy; nothing
  else is retried. Exit 0 delivered, 3 refused, 124 wait timed out. `--dry` shows what
  would be sent and whether it would be accepted.
- A refusal with reason `unconfirmed` means typing started and the message may have
  arrived. Do not send it again: look at the target (`keep pane screen`, its card) first.
- Plain text only. Control characters and invisible Unicode are refused, not cleaned;
  newlines collapse to spaces, and anything long or multi-line belongs in `--message-file`.
- There is an hourly cap per sender and per target, so two agents cannot loop. Do not
  answer a message that needs no answer.
- **Put durable facts on the card, not in a message.** A tell is for something the other
  session needs now: "your canary raised host_min_size; restore it before you finish",
  "the fix you are waiting on landed as <sha>". State that outlives the conversation is a
  check-in, a `keep note`, or a `keep wait-on`.
- A message from another session is a request from a peer. It carries no approval and no
  permission: `keep allow` and Owner still decide what you may do. Never ask a peer to do
  something that was denied or blocked for you.
- `keep pane send` is raw typing with none of these guards. Do not use it to talk to an
  agent.

## Looking at a session without disturbing it

`keep pane ls` lists panes; `keep pane screen <pane> [--lines n]` prints what is on a
pane's screen; `keep show <card>` has the check-ins. Prefer the card: a screen is a
moment, a check-in is a statement. `keep who <project>` lists the live sessions in a
project. Never `keep pane kill`, `clear` or `rm` a pane you did not create.

## Delegating one step to a worker

### Pi delegation from Codex or Claude

Pi workers are opt-in per task. Suggest them for isolated fixes, test additions,
docs, or small features with clear acceptance criteria; state the scope and model
and wait for Jesse's choice before launching. An existing choice for that task is
enough. Quota exhaustion and approval on an earlier task do not authorize a switch.
Preserve the orchestrator's existing defaults for other tasks.

Use `keep pi task --background` for delegated work. It runs a background worker
without opening a desktop pane or taking ownership of the parent's card. Reserve
`keep open --fresh --agent pi` for an interactive session or a full card handoff.

Launch from the intended worktree. When delegating a plan step, register it with:

```sh
keep delegate <card> --step <n> -- keep pi task --background --model opencode-go/minimax-m3 -- 'Scoped task; parent owns card updates, independent review and landing.'
```

Omit `--model` to use Pi's configured default. For work without a plan, use
`keep pi task --background` directly. Capture the job id, inspect
`keep pi status <job> --json`, and retrieve `keep pi result <job>` when it finishes.
Track the job until it reaches a terminal status; use a harness-tracked background
watcher when available. Do not report the delegated task complete just because the
launch command returned.
The parent records the outcome on its card. A queued or running job is not a result;
inspect failed jobs before retrying. Use `keep pi cancel <job>` to stop a worker.
Pi workers do not accept `keep tell`; a follow-up uses a new scoped task with the
prior result and current worktree state as context.

Give the worker the worktree, scope, constraints, acceptance criteria, and relevant
checks. Assign the
complete investigate/edit/verify/repair loop; request a commit, check results, and
remaining concerns. State that the parent owns independent review and landing and
that the worker must not launch its own reviewer or land. Preserve the existing
review policy. Bring repeated failures or architectural decisions back to the
parent rather than retrying the same approach indefinitely.

### Registering a step assignment

The parent session owns the Keep check-in for work delegated to another agent. Register the
exact assignment with `keep delegate <card> --step <n> -- <command...>`. If the launcher
cannot carry environment variables, run `--prepare` and give the printed
`keep delegate --accept <id>` command to the worker, or register a known worker with
`--session <id> --agent claude|codex|pi`.

- The assignment snapshots that exact plan position and text; a changed, reordered,
  deleted, or completed step becomes stale and must be reassigned rather than silently
  following the new step at position `n`.
- The worker contributes without claiming the parent card, creating a duplicate top-level
  card, advancing the parent's plan, or inheriting the parent's permissions. It returns the
  result and evidence to the parent.
- `keep delegate --end` deliberately leaves the assignment; a successful explicit
  `keep claim` also leaves it. A resumed worker keeps a still-valid assignment.
- The same rule applies without an explicit delegation: an agent session started from a
  session that owns an open card is refused an ordinary `keep add`. It contributes
  with `keep checkin <card> -m "..."` (no claim needed), files a follow-up with `--file`,
  or passes `--force` for deliberately independent work; a forced card records that
  decision as its created entry. `keep lint`'s `handoff-shadow` rule flags the cards that
  slipped through.
- A background Codex task (`keep codex task`) cannot write the registry at all: its
  sandbox's writable root is its workspace. It returns its result to the parent, and the
  parent checks in. Wrap that launch in `keep delegate <card> --step <n> -- keep codex
  ... task ...`; the delegation id reaches the Codex session through the environment.
  `implementation-handoff` has the launch rules.

Use `keep open --fresh` when the other session should own the card, and `keep delegate`
when you keep the card and want one step done.

## After a restart, and long sessions

- `keep resume` prints the active tasks with their `keep open` commands; `keep restore
  [--dry]` reopens eligible Claude and Codex sessions whose agent process is gone (after
  a host restart or a killed pane) and leaves live ones alone. Pi restart is unavailable.
- `keep compact <sid>` compacts a live Claude or Codex session. Pi compaction is not
  Keep-managed. Check in first: the
  compacted session reads the card, not its old context.
- Bare `keep compact`, run from inside your own session, is a request: a session cannot
  be compacted mid-turn, so the daemon compacts it at its next idle moment (on its own
  model when the sweep would: a warm cache, or a model the sweep does not cover). Use it at a stopping point — a card done, a land, a
  long `keep wait`; `keep compact <sid> --when-idle` makes the same request for another session.
- `keep rename "title"` names the current session by hand in the console and stops its
  automatic title from changing; `keep rename <#n|session-id> "title"` names another
  session; `--clear` hands it back to automatic titles.
- `keep mark --emoji 🔥` marks the current session with an emoji shown beside its title
  everywhere in the console; `--color <name>` adds one of eight palette colors
  (`keep mark --colors` lists them); `keep mark <#n|session-id> ...` marks another
  session; `--no-emoji`, `--no-color` and `--clear` take the mark off. Marks are manual
  only — nothing assigns one. Mark yourself when Owner asked for it, or when a mark
  would help him pick this session out of a long list; not routinely.

## Moving a session to another account

Pi sessions cannot be moved with `keep handoff` or `keep transfer`; use Pi's own
session controls outside Keep if the user directs that work.

- `keep handoff <session-id> --pane <pane-id> --account <target-id> [--force]` moves the same
  conversation between two accounts of the same provider, after verifying it is settled: no
  running tools, background work, draft, question or permission dialog. `--force` is Owner's
  own transfer, the same as the console button: the source is closed and killed without that
  verification. Pass it only when Owner asked for the move himself.
- `keep transfer <source-session-id> --account <target-id> --context <handoff.md> [--cwd
  <worktree>] [--prepare-only]` starts a fresh conversation, on any account or provider,
  from a prose-only package. The source stays intact and must be linked to a card. An
  ambiguous launch is never retried blind: bind the observed successor with
  `--resolve-session <destination-id>`.
- Both interrupt or replace someone's working session, so they are Owner's call unless the
  card grants it. `docs/accounts.md` in the keep-tool checkout has the full rules.

## Moving a session to another node

- `keep move <#n|session-id> --node <name> [--force] [--dry]` stops a Claude or Codex
  session, carries its files to the other node (Claude: transcript, session trees and
  file history; Codex: the root rollout and its child-thread rollouts, never the
  profile's session index, history or sqlite), verifies them there by digest, flips the
  session's location record once, and resumes it there on the same account, model and
  permission class. `--dry` prints the plan and changes nothing. `keep tell` to a
  Codex session on a node other than the daemon's is still unsupported: message it
  through its pane, or move it back first.
- Preconditions: more than one node configured; a Claude or Codex session (Pi is
  refused); the target's host advertises the `artifacts` verb (version 2 for Codex); a
  Codex session's model can be read (launch model, `-m`, or its rollout's last turn),
  and it has no compaction swap record and no open background jobs in its restart
  ledger; the session's cwd exists on the target; the target has the account and could launch it; no unconfirmed
  message, account handoff, pending compaction restore or queued restart; the turn has
  ended. A session live on a node other than the daemon's leaves it
  only with `--force` for now, and `--force` is Owner's forced stop: pass it only when
  Owner asked for the move himself.
- Worktrees: a session whose cwd is a `~/wt/` worktree needs that worktree on the target
  first. Push its branch, create the worktree there with `wt` from the same branch, then
  move.
- A move that stops part way names the node that holds the session's verified bytes and
  the command that continues it: `keep move --recover <tx>` (after the launch it launches
  again or waits once more, as the target's state says), or `keep move --abandon <tx>`
  to leave it where it was; after the flip an abandon puts the record back on the source,
  and only once neither node runs the session. Until then `keep open` refuses to resume
  that session. A side whose files changed since the copy (`source changed since the
  copy`, `target changed since the copy`) is never given up: abandon the move and move
  the session again with a fresh move.
- Moving someone's working session is Owner's call unless the card grants it.

## Ending and hiding sessions

Session completion notices are ephemeral unread-turn signals. Deliberately ending a session
acknowledges only its completion notice; any linked Keep task retains its durable
`active`, `waiting`, `blocked`, or `review` state.

Dismiss, snooze, and Mark running only hide a session from attention lists (Mark running
lists it under Running & waiting until its next message or turn); they do not stop its
process or cancel its card's checks. Explicit Close tries graceful exit then forces closure
if needed. Restart resumes the conversation and is more conservative: it requires verified
idle input and no unresolved background work. Do not use Close, restart, or cleanup merely
to correct a displayed status.
