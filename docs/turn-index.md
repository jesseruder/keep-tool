# Turn index

A SQLite index of Claude Code and Codex CLI turns, so a week of fleet history can
be searched and measured without re-reading gigabytes of JSONL. It is read-only
with respect to the agents: nothing here changes what a hook decides or what a
session does.

The index answers questions the raw transcripts make expensive: how many turns a
session took, which of them Owner spent only to restart a stalled agent, what an
agent actually touched in a turn, and where a phrase was last said.

- Module: `bin/turn-index.js`
- Database: `<registry>/.keep/turns.sqlite` (gitignored, like the rest of `.keep/`)
- CLI: `keep turns show|search|stats|ingest|backfill`

`node:sqlite` is still experimental in Node 22, so `bin/keep` runs Node with
`--disable-warning=ExperimentalWarning`; otherwise every CLI call and every hook
would print a warning to stderr. FTS5 is compiled into Node's bundled SQLite.
The database is a derived cache: deleting it costs a backfill, nothing more.

## Ingestion

Every transcript file keeps a byte offset in `ingest_state`. A pass reads only
the bytes appended since the last one, parses whole lines, and leaves a partial
trailing line for next time. The cost is proportional to the delta, not to the
file — on a synthetic 31 MB transcript, indexing one appended turn takes about
1.2 ms (median of 20, max 3.7 ms), while a cold full pass runs at ~15 MB/s.

If a file shrinks (`size < offset`) the session's rows are dropped and it is
re-read from zero. Each file's pass runs inside one `BEGIN IMMEDIATE`
transaction; with WAL and `busy_timeout=5000` the hooks, the daemon, and a
backfill can run at once, and a pass that still cannot get the lock returns
`{ skipped: 'busy' }` rather than failing its caller.

Three paths feed it:

1. **Stop hooks** — `keep hook stop` and `keep hook codex stop` call
   `ingestFile` after the Stop decision is made, inside a `try/catch` that
   swallows everything (only `KEEP_DEBUG` makes a failure visible). The hook's
   output is unchanged, including the codex branch's early return for child and
   headless rollouts, which are indexed too.
2. **The daemon** — `keep serve` runs a `turnIndexTick` every 30s over the live
   session ledger plus any reviewer marker, resolving each file from the caches
   it already maintains. Bounded at 64 files per tick and round-robin, so a large
   fleet is swept over several ticks instead of one long one. Health is recorded
   under `turn-index`.
3. **`keep turns backfill`** — walks every Claude project root (all configured
   accounts, plus `subagents/` subdirectories) and every `~/.codex/sessions`
   date directory, ingesting files whose mtime is at or after `--since`
   (default: 14 days ago). Files are streamed, never read whole.

## Schema

`PRAGMA user_version` carries the schema version (currently 1); a future change
bumps it and adds migration statements.

### `sessions`

| column | notes |
| --- | --- |
| `id` | Claude session id, or the Codex thread id from `session_meta` |
| `agent` | `claude` or `codex` |
| `kind` | `interactive`, `headless`, `subagent`, or `reviewer` |
| `cwd` | as recorded in the transcript |
| `project` | `cwd` folded to its main checkout (a worktree files under the repo its cards use), `~`-normalized |
| `account_id` | the Keep account whose config directory holds the file |
| `file`, `parent_id`, `started_at`, `last_at`, `title`, `card_id` | |

Kind is decided once and never downgraded, because a later ingest pass sees
neither the opening prompt nor the Codex `session_meta`:

- **Claude** — a file under a `subagents/` directory is `subagent`; a session id
  in `.keep/reviewer/` is `reviewer`; a session id in `.keep/spawned/` (how Keep
  marks its own headless runs) or a first prompt that opens like a system prompt
  (`You are …`, `You classify …`: scheduled checks, the Slack classifier, tab
  naming, the brief, and Owner's own `claude -p` batch jobs) is `headless`;
  everything else is `interactive`. `KEEP_RUN` itself
  is an environment variable of the spawning process and never reaches the
  transcript, so the `.keep/spawned/` marker is what stands in for it.
- **Codex** — `thread_source: 'subagent'` or `codex.isChildSession(meta)` is
  `subagent`; `codex.isHeadlessSession(meta)` is `headless`; otherwise
  `interactive`.

### `messages`

One row per text block, tool call, or tool result, with `UNIQUE(session_id, seq)`.

- `role` is `user`, `assistant`, or `tool`.
- `kind` is `human | keep | command | preamble | meta` for user rows,
  `text | tool_use` for assistant rows, `tool_result` for tool rows.
  `keep` is text starting with `[keep]`; `command` is a slash-command or
  bash-input wrapper; `preamble` is an injected context block (Codex's
  `<environment_context>` and friends, the `# AGENTS.md instructions` block,
  Claude's bare `<system-reminder>` wrappers); `meta` is an `isMeta` record.
- `text` is capped at 16 KiB for human/keep/assistant text and 2 KiB for tool
  results and serialized tool inputs.
- `files` is a JSON array extracted from `Edit`/`Write`/`Read`/`MultiEdit`/
  `NotebookEdit` inputs, from `apply_patch` bodies, and from obvious path tokens
  in shell commands. `command` is the first 500 characters of a shell tool's
  command. `stop_reason`, `tokens_in`, and `tokens_out` come from the Claude
  assistant record they were parsed from and sit on its first row.

### `turns`

One row per turn, `UNIQUE(session_id, n)`, `n` counting from 1 per session.

A turn **starts** at a user message of kind `human`, `keep`, or `command` — a
preamble or a meta record never opens one. It **ends** at a Claude assistant
record with `stop_reason: 'end_turn'`, at a Codex `event_msg` of type
`task_complete` (or `turn_aborted`), or at the next opener, whichever comes
first. Tool results belong to the turn in progress.

Turn rows are *derived*, never accumulated: whenever a turn is touched, its
aggregates are recomputed from its own messages. That is what makes a turn that
spans several ingest passes — the daemon's 30s tick lands mid-turn constantly —
come out the same as one indexed in a single pass. `assistant_text` is the
turn's assistant text concatenated (16 KiB), `last_assistant` its final block
(4 KiB), `opener_text` the first 2 KiB of the opener, and `tools`, `files` and
`commits` are JSON arrays. `commits` is best effort: the shas `git commit` prints
in brackets, read out of the turn's tool results and commands.

`verdict`, `verdict_reason`, `state_line` and `verdict_at` are reserved for the
turn watcher and are left null here.

### `messages_fts`

An FTS5 external-content table over `messages.text` (`tokenize='unicode61'`)
with insert/delete/update triggers. `keep turns search` uses `snippet()` for the
match context. Query tokens are quoted before they reach `MATCH` (so `home-only`
is a phrase, not a `NOT`); the module's `search(query, { raw: true })` passes FTS5
syntax through unchanged.

## CLI

```
keep turns show <session-id|card-id> [--last N] [--json]
keep turns search "<query>" [--since when] [--project p] [--agent claude|codex] [--limit n] [--json]
keep turns stats [--since when] [--json]
keep turns ingest <file> [--agent claude|codex] [--force]
keep turns backfill [--since when] [--roots dir,dir] [--force] [--json]
```

`show` takes either a session id or a card id; a card resolves to every session
linked to it. `when` is keep's usual grammar, read backwards because a window
is backwards: `--since +7d` means the last seven days, `--since 2026-09-01`
means from that date.

`stats` reports, per agent and session kind, the number of sessions, turns,
human openers, `[keep]` openers, and **nudges** — human openers whose whole text
is a bare restart (`continue`, `keep going`, `go ahead`, `proceed`, `what's
next`, `check again`, `done`, …). The nudge count is the number the turn watcher
is meant to reduce, and the reason this index exists.

## Deliberate limits

- Sidechain records written inline into a parent Claude transcript are skipped.
  They are a subagent's conversation, not the parent's turn, and counting them
  would inflate both message counts and tool counts. Subagent transcripts that
  Claude writes as their own file are indexed as `subagent` sessions.
- Codex writes each user and assistant message twice (`event_msg` and
  `response_item`); only `response_item` rows are indexed, so counts stay honest.
  `event_msg` is read for `task_complete` alone.
- `tokens_in`/`tokens_out` are populated for Claude only. Codex reports usage in
  separate `token_count` records that do not attach to a message.
- `card_id` is filled only when a caller supplies it (the daemon passes it for
  sessions it already knows); `keep turns show <card>` resolves the link from the
  card's own frontmatter instead.
