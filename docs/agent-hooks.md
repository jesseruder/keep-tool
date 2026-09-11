# Agent integration

`keep setup hooks` merges the following Claude hooks into the existing user
settings and installs the `keep` and `fleet-review` skills for Claude and Codex.
Hook commands point to the application checkout and explicitly select its local
configuration. Existing unrelated hooks are retained; existing skill directories
are never replaced automatically.

| Event | Adapter |
| --- | --- |
| SessionStart | `keep hook session-start` |
| SessionEnd | `keep hook session-end` |
| Stop | `keep hook stop` |
| Notification | `keep hook notification` |
| PreToolUse (Bash) | `keep hook pre-bash` |
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
