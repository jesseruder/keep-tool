# Session-owned MCP helpers

Restart still requires a verified idle prompt, no outstanding tool calls or jobs,
and unchanged session identity. A process under the agent is not automatically safe:
it may be real background work rather than a helper, so anything unaccounted for
blocks the restart. Two things account for one: the session's own configuration
declares it, or the operator has audited it.

## Declared servers

A Claude child process is admitted without policy when it is a stdio server the
session's own configuration declares: the `--mcp-config` file on the agent's argv,
`<cwd>/.mcp.json`, or the account's `.claude.json` (top-level `mcpServers` for user
scope and `projects[<cwd>].mcpServers` for local scope). Those declarations are
restart-safe by construction — resuming the session launches every declared server
again from the same file, so a running instance is replaceable and admitting it grants
nothing the session did not already start for itself. Only `command` and `args` are
read; `env` is never inspected, compared, or logged, and no declared command is ever
executed.

A live row matches a declaration by its exact command line, by an absolute launcher
whose basename is the bare declared command (`npm` → `/opt/node/bin/npm`), or by an
interpreter expansion `<interpreter> <declared argv>`. When the launcher's own first
line names a single absolute interpreter, the live interpreter must resolve to that
same file — `python` and `python3` in one virtualenv match, the same basename
elsewhere does not. Arguments containing whitespace stay ambiguous and unmatched. A
matched server is captured together with its whole descendant subtree as one helper
unit, since a launcher such as `npm exec` runs the real server as a child; every
process in the unit must have a start time, and all of them must be gone before
resume. Codex keeps its audited runtime-tree path below and has no declared rule.

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
