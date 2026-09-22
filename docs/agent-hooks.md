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
| Notification | `keep hook notification` |
| PreToolUse (Bash) | `keep hook pre-bash` |
| PreToolUse (AskUserQuestion) | `keep hook pre-question` |
| PostToolUse (Bash) | `keep hook post-bash` |

The installer currently adds only the Claude hooks in this table. For supported
Claude installations, also configure `SubagentStart` and `SubagentStop` to invoke
`keep hook lifecycle`. These observation-only adapters record child lifecycle
hints; transcript reconciliation remains the fallback when hooks are missing.
Use the same checkout path and `KEEP_CONFIG` prefix as the installed commands.

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
