# Session-owned MCP helpers

Restart still requires a verified idle prompt, no outstanding tool calls or jobs,
and unchanged session identity. A configured MCP server is not automatically safe:
some servers retain work after returning a tool result.

`.keep/mcp-restart.json` is an explicit, local audit policy:

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

Matching requires the exact absolute command/arguments, or its single absolute
shebang interpreter expansion. Arguments containing whitespace or ambiguous
characters, launch wrappers, unknown helpers, and helpers with children stay blocked.
The process must be a direct child of the verified agent; PID/start time and command
are captured and checked again before exit. No helper is killed by this feature.
After graceful exit, the old helper identities must disappear before resume; an
orphan stops the restart and is reported rather than force-killed.

Additional servers require policy/configuration and an audit, not per-server code.
This does not cover arbitrary config precedence, remote MCP servers, shell launch
chains, or autonomous servers with persistent jobs.

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
