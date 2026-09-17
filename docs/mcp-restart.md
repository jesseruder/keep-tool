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

A fourth form exists for one declared command only, because one declared command is
never visible as itself. A server declared `{"command": "npx", "args":
["@playwright/mcp@latest", "--headless"]}` runs as the row `npm exec
@playwright/mcp@latest --headless`: the `npx` bin splices `exec` into argv and npm
then overwrites `process.title` with `npm` joined to the positional arguments. Without
this form the helper audit refused every session with an npx-declared server, and the
session could not be restarted at all. So a declaration whose command basename is
`npx` also matches the tokens `npm`, `exec`, then its own arguments with leading npx
options stripped — `-y`, `--yes`, `-q`, `--quiet`, `--no-install`, `--prefer-online`,
`--prefer-offline` and one `--`, all of which change only how the package is fetched.
Any other leading dash token (`-p`/`--package`, `-c`/`--call`) changes what actually
runs, so it refuses instead, as does an empty remainder. The first token must be the
bare word `npm`, because that is literally what npm wrote into its title; a real
`/usr/local/bin/npm exec …` argv is a launcher row and is matched, or not, by the
rules above.

The title is a pointer and never the evidence. `npm exec --package=/tmp/impostor --
mcp-server-fetch --port 3000` wears exactly the title of a declared `npx -y
mcp-server-fetch --port 3000`, and any node process can assign that string to
`process.title` outright, so a match on the title alone would admit an impostor and
its whole subtree. What is checked is the program underneath it. npx unpacks a
registry spec into `<npm cache root>/_npx/<digest>/`, where the cache root is
`npm_config_cache` or `~/.npm` and the digest is the first 16 hex of a SHA-512 over
the sorted package specs as written; the row is therefore admitted only when it has
exactly one child, and that child matches — by the same launcher and interpreter rules
as any other declaration — a synthetic declaration whose command is
`<npxCache>/<digest>/node_modules/.bin/<bin>` and whose arguments are the declared
ones after the spec. `<bin>` is the one bin npm itself would run, derived from that
install's `<pkg>/package.json` before the live row is looked at, in the order npm's own
`getBinFromManifest` uses: normalise `bin` to an object, where a string publishes one
bin named for the unscoped package; if every published bin points at the same file,
take the first key, which covers both a single bin and an alias set; otherwise take the
key equal to the unscoped package name; otherwise npm refuses to choose and so does
this. The basename of the child's own launcher token must equal that selected name — a
manifest publishing `demo-mcp` and `maintenance` runs `demo-mcp`, and a child running
`maintenance` is refused — and the `.bin` link has to resolve to the very file the
manifest points at. Any read that fails means no match. On a match
the `npm exec` row, its child, and everything below are captured as the one helper
unit. On no match the row is refused exactly as before — which is also what an
`npm exec` that is still installing gets, since it has no child yet.

Five kinds of declaration therefore have no title form at all and stay on the
audit-pin path. A spec that is not a registry spec — one starting with `.`, `/` or
`~`, or containing `:`, so directory, git and URL specs — because there is no cache
directory to derive. A declaration whose arguments carry a credentialed URL, because
npm redacts secrets out of the title and the row can no longer be reconstructed from
the declaration. A package that is already present in the project's own
`node_modules`, because npx then runs the local bin and writes no `_npx` directory for
this to check against. An install that publishes no bin npm would pick on its own —
several bins, pointing at different files, none named for the package — because npm
itself would need a `--package` or `--call` to choose and the declaration carries
neither. And a server whose npx cache is not the daemon's own: the cache root is read
from the daemon's `npm_config_cache`, which the sessions it launches inherit, so a
per-session override or a `cache=` setting in an `~/.npmrc` is not read and the
directory this derives is not the one that server installed into.

Residual, deliberately not closed here: a node process that sets its own title to
`npm exec <declared spec>` and spawns one genuine server out of the declared package's
cache install as a decoy is admitted, along with whatever else that process is doing.
Nothing read from `ps` can tell that apart from the real thing, and this is not the
rule that would catch it — every process-tree rule in this file trusts the tree, the
audit pins included, and an agent that deliberately disguises its own background work
as its declared server defeats all of them equally. The declared-server rule grants
such an agent nothing it could not already have had by pinning.

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
