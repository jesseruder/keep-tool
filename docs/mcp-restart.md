# Session-owned MCP helpers

Restart still requires a verified idle prompt, no outstanding tool calls or jobs,
and unchanged session identity. A process under the agent is not automatically safe:
it may be real background work rather than a helper, so anything unaccounted for
blocks the restart. Two things account for one: the session's own configuration
declares it, or the operator has audited it.

## Declared servers

A Claude child process is admitted without policy when it is a stdio server the
session's own configuration declares: the `--mcp-config` file on the agent's argv,
`<cwd>/.mcp.json`, or the `.claude.json` of the account the live agent belongs to
(top-level `mcpServers` for user scope and `projects[<cwd>].mcpServers` for local
scope). That account is passed in by the caller and no other is consulted: a server
the default account declares is not this session's, and a session with no resolved
account draws on the first two sources only. During an account handoff it is the
source account, not the target the session is about to resume under — the process
being accounted for is the one the source started. Those declarations are
restart-safe by construction — resuming the session launches every declared server
again from the same file, so a running instance is replaceable and admitting it grants
nothing the session did not already start for itself. Only `command` and `args` are
read; `env` is never inspected, compared, or logged, and no declared command is ever
executed.

A live row matches a declaration by its exact command line, by an absolute launcher
whose basename is the bare declared command (`npm` → `/opt/node/bin/npm`), or by an
interpreter expansion `<interpreter> <declared argv>`. The interpreter is never free:
the launcher must be an absolute path whose own first line is either a single absolute
interpreter, which the live one must resolve to by realpath (`python` and `python3` in
one virtualenv are the same binary; the same basename elsewhere is not), or
`#!/usr/bin/env NAME` with one bare name, which admits a command of that name, bare or
absolute (`node /opt/node/bin/npm exec …`). The env path must be the real
`/usr/bin/env`; a program someone named `env` elsewhere expands nothing. A launcher with no readable shebang of
either shape has no interpreter-expanded form at all, so `/bin/sh /path/server` is
refused.

What a match asserts is that the row, joined with single spaces, is the declared
invocation. It cannot assert where the live process put its argument boundaries: `ps`
joins argv with spaces, so one element containing a space reads exactly like two.
Declarations whose own command or arguments carry whitespace are dropped, which
settles the declared side only. A bare declared command matches that basename at any
absolute path, since PATH is what chose it.

A matched server is captured together with its whole descendant subtree as one helper
unit, since a launcher such as `npm exec` runs the real server as a child; every
process in the unit must have a start time, and all of them must be gone before
resume. The unit is a snapshot: a descendant the launcher spawns after it is taken is
not waited for. That one is orphaned when the agent exits, and the resumed session
launches its declared servers again. Waiting for it would mean matching process
groups, and the `ps` rows carry no pgid — adding one changes the single `ps`
invocation and positional parser every identity proof in the daemon reads, which is a
worse risk than the residual. Codex keeps its audited runtime-tree path below and has
no declared rule.

Helpers that appear in no declaration still need policy. `.keep/mcp-restart.json` is
an explicit, local audit policy:

```json
{"version":1,"servers":[{"agent":"claude","server":"example",
"configFile":"/absolute/config.json","restartSafe":true,
"audit":"Reviewed implementation: no work survives a completed tool call",
"definitionSha256":"SHA256 of JSON.stringify(config.mcpServers.example)",
"files":{"/absolute/launcher":"sha256","/absolute/implementation":"sha256"}}]}
```

Only top-level JSON `mcpServers` stdio definitions are supported initially. The
configuration fingerprint includes the definition's environment without copying
secrets into policy or logs. Pin the launcher and all audited implementation files;
reaudit after implementation or dependency updates. Policy is a trusted operator
assertion, not an automatic proof of server semantics or a sandbox against local edits.

Pinned matching requires the exact absolute command/arguments, or its single absolute
shebang interpreter expansion. Arguments containing whitespace or ambiguous
characters, launch wrappers, unknown helpers, and pinned helpers with children of
their own stay blocked.
The process must be a direct child of the verified agent; PID/start time and command
are captured and checked again before exit. No helper is killed by this feature.
After graceful exit, the old helper identities must disappear before resume; an
orphan stops the restart and is reported rather than force-killed.

Additional servers require policy/configuration and an audit, not per-server code.
This does not cover arbitrary config precedence, remote MCP servers, shell launch
chains, or autonomous servers with persistent jobs.

A declaration is an accounting rule, never a licence to kill: nothing is signalled.
A process that matches a declaration but does not exit when the agent does still stops
the restart, reported as a surviving helper.

## Codex runtime trees

Codex launchers and CUA can have nested helpers. `.keep/runtime-restart.json`
supports bounded, explicitly audited trees (Codex only):

```json
{"version":1,"trees":[{"agent":"codex","restartSafe":true,
"audit":"Audit evidence and version; no detached work after a completed call",
"parentArgv":["/absolute/codex","resume","$SESSION_ID"],
"tree":{"argv":["/absolute/node","/absolute/launch.mjs"],
"children":[{"argv":["/absolute/node_repl"]}]},
"files":{"/absolute/codex":"sha256","/absolute/node":"sha256",
"/absolute/launch.mjs":"sha256","/absolute/node_repl":"sha256"}}]}
```

The parent and every descendant must match exact argument arrays and parent-child
edges. `$SESSION_ID` is the only substitution; there are no path-prefix or wildcard
rules. Pin every executable and absolute script argument, plus all audited source
files. Every observed child must match an allowed child rule; absent children are
fine. Unknown kernel/worker processes remain blocked until separately audited.
Trees are bounded to 64 processes and depth 6. All captured descendants participate
in pre-exit identity checks and post-exit orphan detection, even after reparenting.

The existing leaf code-mode-host exception remains. Runtime trees never override
transcript job, input, viewer, or process identity guards. No runtime policy is
auto-generated from a live process listing. In particular, a removed old plugin
launcher cannot be audited from the name of its replacement; retain the guard until
the old version's provenance and lifecycle can be verified or the user explicitly
retires that session. An active REPL can have work outside the transcript, so a
server's restart-safe designation requires a real lifecycle audit.
