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
