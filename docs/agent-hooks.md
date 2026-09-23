# Agent integration

`keep setup hooks` merges the following Claude hooks into the existing user
settings and installs the `core` skill pack — `keep` and `fleet-review` — for Claude
and Codex, along with any other pack this machine recorded. `keep setup skills`
installs packs on their own: `--pack <name>` adds one, `--list` shows every pack and
its per-skill status, and `skills/packs.json` defines them. Hook commands point to the
application checkout and explicitly select its local configuration. Existing unrelated
hooks are retained. A skill link Keep itself left behind — an older checkout path, a
deleted worktree — is repaired in place; an unrelated skill directory of the same name
is never replaced without `keep setup skills --replace`, which backs it up first.

| Event | Adapter |
| --- | --- |
| SessionStart | `keep hook session-start` |
| SessionEnd | `keep hook session-end` |
| Stop | `keep hook stop` |
| UserPromptSubmit | `keep hook prompt` (the compaction hint, as model context) |
| Notification | `keep hook notification` |
| PreToolUse (Bash) | `keep hook pre-bash` |
| PreToolUse (AskUserQuestion) | `keep hook pre-question` |
| PostToolUse (Bash) | `keep hook post-bash` |

The installer currently adds only the Claude hooks in this table. For supported
Claude installations, also configure `SubagentStart` and `SubagentStop` to invoke
`keep hook lifecycle`. These observation-only adapters record child lifecycle
hints; transcript reconciliation remains the fallback when hooks are missing.
Use the same checkout path and `KEEP_CONFIG` prefix as the installed commands.

### Sessions on another node

A Claude, Codex or Pi session on a pane-only node whose daemon is known (`KEEP_DAEMON_URL`,
set by `keep node init --daemon-url`) runs the same hook commands; they post to the
daemon's node API (`POST /api/hook`) and print what the daemon's own `keep hook <event>`
printed. Every Claude event in the table is carried: session-start, session-end, stop,
notification, pre-question, lifecycle, and the Bash pair. So is every Codex adapter
below (see "Codex sessions on another node"), and the three Pi hooks (see "Pi sessions
on another node").

- **pre-bash.** The raw `claude --resume` guard runs on the node first, as everywhere.
  The node then reads the daemon's step fingerprints (`GET /api/hook/context`, kept in
  `~/.keep-node/hook-context.json` and asked again after a minute), computes the
  command's repository facts where the checkout is (toplevel and main checkout of the
  cwd and of every `cd` target when the command could be a step or a deploy; at most
  8 directories, 3 s per git call), and posts them with the command. The daemon runs its
  step and self-repair guards on those facts instead of running git itself. The session's
  own `KEEP_STEP_OK` and `KEEP_RAW_CLAUDE` are forwarded; `KEEP_REPAIR` never is: the
  daemon sets it from its own record of the repair sessions it launched. A daemon that
  does not answer within 5 s (or refuses the post) never lets through what it could have
  refused: the node refuses deploy commands, commands matching the last fingerprints it
  was given, and, for a session the daemon last called a repair session, what the repair
  guard refuses without a land record; anything else runs. Never queued.
- **post-bash.** The deploy and step-run records, from the node's facts: a deploy's
  provenance (checkout, sha, uncommitted files, whether the sha is on origin by the
  node's tracking ref) and HEAD after a step. A step run at a sha the daemon's checkout
  does not have (not pushed yet) is recorded at that sha with `unverified: true`, and a
  `landed` step refuses it. The response's output fields are cut to their last 64 KiB.
  A daemon that does not answer within 3 s has the record queued and resent with the next
  hook.

Without `KEEP_DAEMON_URL` every hook on a node, Claude's, Codex's and Pi's, is
pane-only: it binds (and for Claude and Codex releases) the node's pane, refuses deploy
commands by name, and records nothing.

### Pi sessions on another node

The Keep Pi extension (`integrations/pi/keep.ts`) calls `keep hook pi start|end|pre-tool`.
On a node with `KEEP_DAEMON_URL` each is posted as `pi-<action>` and the daemon runs its
own `keep hook pi <action>` with `KEEP_HOOK_NODE` set, for a session its account record
places on that node as a Pi session. None carries a transcript. The extension kills a
hook at 5 s and treats a failure as one (a failed pre-tool blocks the Bash call, its
stderr the reason), so each post has a budget inside that: start 3 s, pre-tool 3 s,
end 2 s.

- **start.** The daemon writes the pane record (naming the node and the extension
  instance) and binds the pane through the node's host; the node then binds it too, or
  finds it bound. The start fails only when neither bound it. A start the daemon did not
  take is queued, resent with the next hook and noted in `~/.keep-node/hook.log`.
- **pre-tool.** The raw-resume guard runs on the node first. The command then goes with
  the node's repository facts (computed by the fingerprints from `GET /api/hook/context`,
  which answers Pi sessions too) to the daemon's step and self-repair guards. A daemon that
  does not answer is treated as for a Claude pre-bash: deploys, the last published step
  fingerprints and, for a repair session, its restarts are refused; anything else runs.
  Never queued.
- **end.** The daemon stamps its pane record released for that instance (queued when it
  does not answer). The pane's meta is left as it is: an exited Pi pane keeps its session
  for Watch and Reopen, as on the daemon node.

The extension's phase file stays on the node, under the node's `~/keep/.keep/pi-events`.
The daemon reads it through the node host's `transcript` verb (`pi-event`, host capability
`transcript: 3`), at most once per 2.5 s per session, for the console's turn state.
`keep doctor` on a node says whether `~/.pi/agent/extensions/keep.ts` is installed there.

### Codex sessions on another node

`keep hook codex <action>` on a node with `KEEP_DAEMON_URL` posts `codex-<action>` to the
daemon with the rollout bytes the daemon's mirror does not have yet, and the daemon runs
its own `keep hook codex <action>` against that mirror
(`.keep/transcript-mirrors/<node>/<session>.jsonl`). The daemon admits the event only for
a session its account record places on that node as a Codex session. What each action
does there is what it does for a Codex session on the daemon node: start registers the
pane (the record names the node) and anchors the stop evidence, stop runs the Stop
guard and writes the completion marker, question and approval write attention markers
with the mirror's time, pre-tool and post-tool are the step guard and the deploy and
step-run recorders on the node's repository facts (as for Claude's Bash pair), and
client-end (the launcher's, with only the launch token) clears the completions of that
node's sessions that carry the token. The session's `KEEP_CODEX_CLIENT_TOKEN` is
forwarded, and a `CLAUDE_CODE_SESSION_ID` it inherited is forwarded as
`KEEP_CODEX_PARENT_SESSION`, recorded as its parent only when that Claude session is on
the same node.

Codex waits on every hook for JSON, so the node always prints one JSON value: the
daemon's output when it is JSON, `{}` otherwise and whenever the daemon does not answer.
Each wait ends inside the timeout Codex's hooks.json gives the hook: start 2 s (the pane
bind follows it), end 2 s, question, approval and complete 2.5 s, lifecycle and
post-tool 3 s, pre-tool 5 s, stop 9 s. A pre-tool the daemon did not answer, or answered
without a decision, is refused exactly as a Claude pre-bash is (deploy commands and the
last published step fingerprints; exit 2 with the block JSON); anything else runs.
Start, stop, approval, complete, lifecycle and post-tool are queued and resent when the
daemon does not answer; a question is allowed, and an end has released the node's pane.

A fresh Codex session names itself only when its first turn fires SessionStart, and the
daemon admits that only for a session it already places on the node. So `keep open
--agent codex --node <node> --fresh` asks the node's host for the Codex rollouts its
account has begun since the launch in the launch's directory (the `transcript` verb's
`find`, host capability `transcript: 2`), and adopts one only when it is the only one,
the pane is still the launch's and unbound, and the node's process table shows the
pane's process holding that rollout open. The session's account record then names it
and its node, and the pane is bound to it on the node's host. With no rollout yet, or
more than one, nothing is adopted: the open answers `pendingRegistration` with a
`registrationNote` saying why. The node's own start hook still binds the pane at the
first turn, but the daemon, with no record placing that session on the node, refuses
its hooks.

A node identifies its Codex processes' open rollouts with lsof, and on a Linux node
without lsof from `/proc/<pid>/fd`; a read that fails leaves the session unverified,
never absent. `keep doctor` on a node checks each `~/.codex*` profile: a hooks.json whose
`keep hook codex` commands point at this node's checkout for every action, and
`[features] hooks = true` in its config.toml; and says whether lsof is installed.

Codex also stops a fresh session at a trust review ("New hook, review required", press
`t`) for every hook in hooks.json that has no trust entry in config.toml: a
`[hooks.state."<profile>/hooks.json:<event>:<group>:<index>"]` table holding the
`trusted_hash` Codex computed when the hook was accepted. A pane parked there never
reaches its prompt, so the open's wait for it times out. `keep doctor` on a node counts
those entries for each profile's hooks.json and fails with how many are missing; it
checks presence only, never the hash, which is Codex's. `keep accounts setup <id>
--share-from <source>` carries the tables between profiles on one machine, so on a node
run it there, on the node; nothing copies them from another node. Otherwise copy the
`[hooks.state]` tables from a profile that accepted the same hooks.json bytes at the same
path, or answer the review once per hook in a fresh Codex on the node.

A fresh Codex can also open on its update prompt ("✨ Update available! 0.155.1 ->
0.156.1", "Update now", "Skip", "Skip until next version"). Keep never answers it: the
open's wait refuses at once, naming the pane, both versions and the node to update
Codex on. The notice alone, above a live prompt, is information and the open proceeds;
the notice with no prompt is waited out and the timeout names it. `keep doctor` prints
the `codex --version` it finds; on a node it says to compare that with the daemon
node's by hand, since the node API does not carry the daemon's version.

Restart/resume existing agent sessions in a controlled manner to load new hooks. The reviewer launcher sets
`KEEP_REVIEWER=1`, allowing the SessionStart hook to register it for daemon ticks.

Codex transcript discovery works without event hooks. Rich attention notifications,
completion acknowledgement, and command provenance additionally use the existing
JSON-on-stdin adapters below. Codex hook support and configuration vary by installed
version; automatic editing of Codex hook settings is not included in this release.
Configure the supported events in your installation to invoke these adapters:

- `keep hook codex start`
- `keep hook codex stop` (Stop continuation guard)
- `keep hook codex lifecycle` (normalized lifecycle/job evidence; wire supported lifecycle events alongside the specialized adapters)
- `keep hook codex question`
- `keep hook codex approval`
- `keep hook codex complete`
- `keep hook codex end`
- `keep hook codex pre-tool`
- `keep hook codex post-tool`

The optional `bin/keep-codex-cli /path/to/codex [args...]` wrapper acknowledges
completion when an interactive client returns to the shell. It does not replace
start/tool/attention hooks. The version-specific broker patch under `patches/` is
optional and never applied by installation.

`keep delegate <card> --step <n> -- <command...>` passes `KEEP_DELEGATION_ID` through
the child environment. The Claude and Codex SessionStart adapters bind that pending
record to `input.session_id`, which is authoritative even when the process inherited a
different parent agent's session variable. Codex returns assignment context through the
SessionStart `hookSpecificOutput.additionalContext` field. SessionEnd marks the binding
as process-ended so a later start of the same native session can resume it. Tools that
cannot carry the environment use the explicit `--prepare`/`--accept` handshake or the
parent-side known-session registration documented in `keep help delegate`.

Inside a Keep terminal (`KEEP_PANE` is set), the wrapper defaults Codex to
`tui.animations=false` and `tui.whimsy=false`. Composer sparkles can overwrite
the screen cells Keep uses to verify a typed reminder, leaving it unsubmitted.
These launch overrides preserve the exact-draft and transcript-receipt safeguards
and do not edit the user's Codex configuration. They apply on the next launch or
resume; already-running clients retain their settings. Explicit later `-c`
arguments can override these defaults. Direct Codex launches that bypass this
wrapper need the same overrides to prevent animation interference.

`keep serve` also checks durable unconfirmed deliveries every minute for both
Claude and Codex. After a two-minute grace period, three consecutive failed
checks produce a `delivery` warning in `keep health` and the console's daemon
health attention list (normally within four to five minutes of a stuck send).
The warning identifies the session and pane, and distinguishes failed screen
verification, missing receipts after Enter, and unreadable transcripts/journals.
It keeps the same attention timestamp while the incident persists and clears
when the transcript confirms receipt. Other sessions succeeding cannot clear it.
The same minute check also asks the turn index: an attempt whose text reached the
pane and is at least a minute old is settled as received when that session's
indexed transcript holds a user message with the same text recorded at or after the
moment the send began (the agent writes it after Enter on the same clock, so an
older row is an earlier message with the same words). The minute check cannot see
the input box; the next send to that session, which can, asks the same question
about the pending attempt before refusing it as unconfirmed, and ignores the index
while that text is still in the box. That covers a receipt that never landed
in the transcript file the attempt was watching (a resumed session, a moved
rollout); it cannot confirm text still in the input box, which has no transcript
line. The index lags a live session by one hook or one 30-second tick. An attempt
the index confirms but that is still unsettled at the two-minute mark is reported
as `index-confirms-settling` rather than as a missing receipt.
From the Keep source directory, `node bin/delivery-health.js` lists every current
incident as JSON without message or screen contents. Rotated delivery traces help
classify the failure; older attempts without traces are still reported as missing
receipts. The daemon reconciles completed attempts under its delivery lock before
each health check. Claude's structured local-command receipts and Codex's native
`/compact` completion count as confirmation; unrelated later conversational work
prevents an old compaction draft from being acknowledged. An explicitly cancelled
or locally acknowledged question answer is removed only when its exact rendered
payload and recipient match; cancellation never becomes a successful receipt or
causes the answer to be resent. Corrupt or ambiguous attempts remain visible.
Completed receipts move out of the active queue but remain available to the
owning retry loop, so a late confirmation cannot cause duplicate typing. A busy
delivery lock defers reconciliation while read-only inspection continues.
A pending attempt no transcript can confirm used to block every later send to that
session for good, because the next message is never byte-identical to the stranded
one. An entry older than `KEEP_DELIVERY_JOURNAL_STALE_MIN` (default 15) minutes
expires when the pane no longer shows its draft. If its text and pane match the
message being sent **and its characters actually reached the pane** (the journal is
written before typing, so its existence alone proves nothing), it expires as
`assumed-delivered` and nothing is typed: a session
that resumed writes to a new transcript, so the journal can point at a file that will
never gain another line, and retyping there would send the message twice. Otherwise
the next message goes through the normal path — whose precheck still refuses to type
into an input box that has text in it. A draft still on screen is recovered with
Enter, never discarded.

The watchdog itself stays read-only and never sends input or restarts clients.
It monitors attempted deliveries; it is not a startup compatibility certification
and does not flag sends deferred before any draft was typed.

Interactive sessions opened or restarted by Keep run through `agent-launcher.js`.
The `keep-codex-cli /path/to/codex ...` and `keep-claude-cli /path/to/claude ...`
wrappers use the same supervision. A guardian owns the agent and watches the
launcher's private IPC connection; launcher exit or SIGKILL closes that connection,
causing TERM followed by KILL after two seconds if necessary. Terminal descriptors
and the foreground process group are inherited. Codex still acknowledges normal
and interrupted client exits; abnormal exits retain recovery markers. Existing
sessions acquire supervision when next opened or restarted.
