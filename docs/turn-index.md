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
file.

A pass has three phases, and only the third holds the write lock:

1. read `ingest_state` and decide what to read (no transaction — WAL readers
   never block a writer);
2. read and parse the delta into memory, capped at `maxBytes`;
3. `BEGIN IMMEDIATE`, re-check that nobody else advanced the offset while we
   parsed (if they did, this pass is simply dropped as `skipped: 'raced'`), then
   insert and commit.

Two knobs keep a caller from waiting:

- `busyTimeoutMs` — how long to wait for the write lock. Hooks pass 250 ms and
  treat `{ skipped: 'busy' }` as success: the delta is still on disk and the next
  pass will take it. Backfill uses the 5 s default.
- `maxBytes` — how much of a pending delta one pass may take. Hooks pass 512 KiB,
  so a session with no prior index state cannot make an agent wait behind a
  hundred-megabyte transcript. The result then carries `partial: true` and the
  daemon (or the next hook) continues from the recorded offset. A single line
  longer than the cap still completes, because dropping a 5 MB tool result would
  lose a real record rather than defer it.

Measured on a synthetic 31 MB transcript, with a fresh process per hook (which is
how production pays it):

| case | cost |
| --- | --- |
| one appended turn, session already indexed | median 22 ms, max 31 ms |
| 5.2 MB backlog, no prior index state | 45 ms for one 512 KiB bite, `partial` |
| first hook ever: new database, new directory | 150 ms |

The first-hook figure is the one-time floor: creating the database and its schema
(~28 ms) plus one `git` subprocess (~110 ms) to fold a worktree onto the main
checkout its cards are filed under. That fold is cached in the index itself —
`sessions.project` for the same `cwd` — so it runs at most once per directory
across the whole fleet, not once per hook. An in-process memo could not do this:
every hook is a new process.

A file is reset (its session's rows dropped, re-read from zero) when it shrinks
(`size < offset`), when `--force` is given, or when the SHA-1 of its head no
longer matches the one recorded in `ingest_state`. The fingerprint covers the
first 4 KiB, or the whole file if it is shorter, and the covered length is stored
with the digest — otherwise every append to a short transcript would look like a
replacement. It exists because a rewritten file can keep its size, so the offset
alone cannot prove the bytes behind it are still the same bytes.

Three paths feed it:

1. **Stop hooks** — `keep hook stop` and `keep hook codex stop` call
   `ingestFile` after the Stop decision is made, inside a `try/catch` that
   swallows everything (only `KEEP_DEBUG` makes a failure visible). The hook's
   output is unchanged, including the codex branch's early return for child and
   headless rollouts, which are indexed too.
2. **The daemon** — `keep serve` runs a `turnIndexTick` every 30s over the live
   session ledger plus any reviewer marker, resolving each file from the caches
   it already maintains. The bound is wall time and bytes, not file count, because
   this runs on the daemon's event loop: a tick stops after 150 ms or 8 MiB,
   whichever comes first, with any one file capped at 1 MiB so it cannot blow the
   time budget on its own. The round-robin cursor survives the tick, so the next
   one resumes where this one stopped. Files, bytes and milliseconds are recorded
   in the `turn-index` health detail.
3. **`keep turns backfill`** — walks every Claude project root (all configured
   accounts, plus both `subagents/` layouts) and every `~/.codex/sessions`
   date directory, ingesting files whose mtime is at or after `--since`
   (default: 14 days ago). Files are streamed, never read whole; backfill is the
   one caller that loops on `partial` until a file is finished.

## Schema

`PRAGMA user_version` carries the schema version (currently 3). Each entry in
`MIGRATIONS` brings the database from version n-1 to n and runs exactly once, so
a fresh database is built by running all of them in order and an existing one
only runs what it is missing. Version 2 adds `ingest_state.head_sha`; existing
rows acquire a fingerprint on their next pass rather than being re-ingested.
Version 3 adds the `sessions(cwd)` index the project cache reads.

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

### Subagent transcripts

Claude writes a subagent's conversation to its own file, at either
`<project>/subagents/agent-<id>.jsonl` or
`<project>/<parent-session>/subagents/agent-<id>.jsonl`. Both layouts exist on
disk and both are walked.

Those records are shaped to trap a naive reader: every one carries
`isSidechain: true`, `sessionId` holds the **parent's** uuid, and the subagent's
own identity is in `agentId`. So in a subagent file the two identities are read
from opposite fields — `agentId` (or the filename with its `agent-` prefix
stripped, which is the same value) becomes `sessions.id`, and `sessionId` becomes
`parent_id`. Taking `sessionId` as the identity instead would file the subagent's
messages under its parent, repoint the parent's row at the subagent's file,
relabel the parent `subagent`, and — on a reset — delete the parent's rows. Every
session-scoped delete is keyed on the subagent's own id for that last reason.

Sidechain records are therefore skipped in a parent's own file, where they are
someone else's conversation, and ingested in a subagent file, where they are the
conversation.

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
keep turns prune [--older-than when] [--dry] [--json]
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

## Retention

The index is a derived cache over transcripts Claude and Codex keep forever, so
without a cutoff it grows for the life of the machine. `keep turns prune` drops
every indexed session whose last activity is older than **120 days** — its
messages, its turns, its FTS rows, and its `ingest_state` entries — and the
daemon calls it with that same default at most once a day, reporting what it
dropped in the `turn-index` health detail. `--older-than` takes the same
backward-looking `when` as `--since`, and `--dry` reports what would go without
touching anything. The daemon's sweep is bounded (200 sessions, oldest first) so
a first prune after a large backfill does not block its event loop; while the
result says `more`, the next tick continues rather than waiting a day.

A pruned file that is still on disk is simply re-indexed from zero the next time
something ingests it, since its `ingest_state` row went with it. Sessions with no
timestamp at all are never pruned: an unknown age is not an old age.
`PRAGMA journal_size_limit` caps the WAL at 64 MiB so a backfill does not leave
the write-ahead log at whatever size it grew to.

## Deliberate limits

- Sidechain records written inline into a parent Claude transcript are skipped.
  They are a subagent's conversation, not the parent's turn, and counting them
  would inflate both message counts and tool counts. Subagent transcripts that
  Claude writes as their own file are indexed as `subagent` sessions.
- A pass that loses the race — another hook or the daemon advanced the offset
  while this one was parsing — is dropped rather than retried. The pass that won
  indexed the same bytes, so there is nothing to redo.
- Codex writes each user and assistant message twice (`event_msg` and
  `response_item`); only `response_item` rows are indexed, so counts stay honest.
  `event_msg` is read for `task_complete` alone.
- `tokens_in`/`tokens_out` are populated for Claude only. Codex reports usage in
  separate `token_count` records that do not attach to a message.
- `card_id` is filled only when a caller supplies it (the daemon passes it for
  sessions it already knows); `keep turns show <card>` resolves the link from the
  card's own frontmatter instead.
