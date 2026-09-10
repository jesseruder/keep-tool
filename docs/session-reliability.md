# Session reliability contract

The conversation ID is not a process ID, pane ID, task ID, or background job ID.
The normalized session model is rebuilt from observations, not persisted as a
second competing registry. Only physical process replacement changes the process
instance; titles, queue membership, card progress and focus do not.

## Status invariants

- An observed physical exit wins over stale questions and task state, unless a
  live replacement or independently live process exists for the conversation.
- A foreground turn, background work, and a request for a person are independent.
  An explicit asynchronous question may coexist with running background work.
- Ending the foreground turn is not proof that background work ended.
- Known services do not keep a conversation waiting indefinitely. Unclassified
  background jobs are uncertain evidence, not by themselves a reason to hide an
  interactive conversation that needs another instruction.
- Historical deployment prose cannot create a live wait. Task completion is not
  conversation closure. A metadata-only startup is not an active turn.
- Every activity result names its decision rule, source, confidence and evidence
  timestamp. Competing applicable rules are retained without prompt text.
- Agent adapters recover from transcripts when hooks are missing. Hooks are
  bounded freshness hints, not an independently authoritative second timeline.

## Terminal invariants

- Background data refresh does not select another conversation or steal focus.
- Triage and Watch reuse one local terminal viewer for the same pane.
- Hidden viewers cannot claim control or send size updates. Only the controlling
  visible viewer resizes the PTY; observers adapt to its size.
- Snapshot replay completes at the snapshot dimensions before local fitting.
- Old connections and disposed instances cannot deliver output or lifecycle
  events to a replacement terminal. Deferred focus loses to newer user input.

## Release verification

Run `npm run test:reliability` and `npm run test:reliability:browser` before
activating session/terminal changes. Browser tests use an isolated daemon fixture,
never the user's live panes. Replay tests exercise multi-event flows, duplicate
observations, missing hooks, background completion, exit and replacement.

A passing fixture is not a live-agent restart test. Report separately: code
verified, daemon activated, browser behavior verified, and real-agent behavior
verified. A new agent version may require adapter fixtures to be updated.

## Limits of this pass

This is one normalized observation and decision policy, not a replacement agent
event protocol. Foreground transcript adapters still use bounded windows and hook
freshness limits. The diagnostic decision trace is capped at 1,000 transitions and
one hour in memory and is cleared on daemon restart. It is not a recovery log.

Background jobs have a separate durable recovery ledger in
`.keep/background-jobs/<agent>/<conversation>/state.json`. It stores classified
jobs, evidence timestamps, known owning process instances, and a byte checkpoint
with file identity and an anchor hash. It does not store prompts, commands or
tool output. Historical jobs predating the observed process have unknown process
ownership. Closing a conversation does not complete its jobs.

The daemon advances one transcript with a 4 MiB budget every 500 ms, outside HTTP
requests. A single larger record may exceed that budget, up to a 32 MiB hard
record limit. Complete lines commit atomically with job state; partial lines retry.
Lifecycle hooks use an immutable durable inbox and are removed only after commit.
Missed completions recover from transcript notifications or corroborated child
transcripts. Stop hooks alone never establish completion. Codex yielded cell and
process IDs are namespaced separately and require matching completion results.

Jobs without corroboration for 30 minutes become uncertain, not completed.
Known services remain recorded without blocking next-instruction readiness.
Completed history is capped at 500 jobs per conversation once outstanding calls
and yielded cells drain (buffered results may still need tombstones); 2,500 total jobs or
2,000 unresolved tool correlations/notification hashes trigger a coverage gap.
Truncated/replaced files, unreadable history and oversized records are explicit
uncertainty, not proof that work ended. Recovery replays the available file while
preserving unresolved prior jobs; a permanent history gap remains visible rather
than silently resetting the ledger. This ledger is evidence, not authority to
kill a process or bypass the stricter close/restart checks.

### Restart proof

Restarts use the same incremental ledger for Claude and Codex, rather than
replaying the whole conversation on every attempt. Existing ledgers replay once
to add the restart evidence contract. The ledger records explicit turn completion,
outstanding tool correlations, child-launch mappings and child identities.
Every owned child is recursively checked, even after a parent-side completion
notice; a resumed child can be active without a new launch. Unknown ownership,
unmapped launches, missing child history, and unresolved jobs (including services
and process-local schedules) block restart. Stop hooks alone cannot grant proof.

Process identity includes the pane, shell PID and agent PID. A transcript byte
watermark separates newly observed launches from historical jobs whose process
ownership is unknown. Historical jobs are not reassigned to the current agent.
Reusing a job ID across known process instances preserves an unresolved previous
run rather than treating replacement as completion. Unknown process identity must
not silently cancel a live schedule.

The proof captures source inode/device, size, modification/change times, and
checks for newly arrived hook inbox entries immediately before exit input. New
prompt/tool hooks create a barrier until subsequent transcript evidence arrives.
The transaction separately verifies the exact agent PID, live descendants,
visible viewers, pending questions and the real terminal prompt. Recovery is a
temporary queue blocker; incomplete or contradictory evidence remains a hard
failure. No new process killing or automatic cleanup policy is introduced.

Code-mode polls also accept literal, straight-line result variables, JSON
serialization, ordered `Promise.all` results, and bounded literal `for-of` and
indexed/labelled loops. A non-executing symbolic mapper counts parallel callback
prints but never assumes their order; polls before/after those blocks can still
be correlated. Mutation, unknown control flow, dynamic bounds, and transformed
poll results remain unverified. The poll-parser migration replays
history while retaining unresolved old jobs; it clears them only on correlated
completion or proof that the old "launch" was a poll. Live histories get three
of every four bounded ledger ticks, with the remaining ticks covering the fleet.
Computed dispatch through immutable literal tool-name lists or an exact
`ALL_TOOLS.find` name lookup is no longer mistaken for a child-agent launch.
Unknown dispatch, shadowed/mutated names, and unparseable code remain possible
launches; replay never drops known owned children.
Syntax failures are cleared only when both source parsing and the harness report
a pre-execution syntax error. Native patch payloads are not JavaScript dispatch.
An explicitly aborted Codex child may be quiescent once all its calls, jobs and
descendants are resolved. Legacy Claude child final text requires a parent
completion acknowledgement no older than the child's latest observation; new
child activity invalidates that fallback. These exceptions never make an
unfinished parent eligible for restart.

### Daemon restart and interrupted compaction

Use `keep restart-daemon` under the normal daemon hold, not `launchctl kickstart -k`.
The command requires the launchd KeepAlive service. It refuses pending model-swap
records (including unreadable records), active compaction, model restoration, or
injection. Successful admission prevents new compaction/injection before the daemon
exits; launchd relaunches it without stopping the terminal host. A direct OS kill
bypasses this guard and is not a safe activation workflow.

An unflushed `/compact` or `/model` transcript record is not proof that the agent
is still working. Interrupted-swap recovery can inspect that terminal, but requires
a completion result after the command echo, a prompt, no busy indicator, and the
existing draft/modal checks before restoring the model. Other unfinished turns
remain protected.

Native desktop long-running QA and real-agent restart/hook uptake are separate
from the isolated browser release gate. Do not describe them as verified merely
because these tests pass.

## Generated summaries and titles

Summary/title workers are text-only Claude print processes, launched in fresh
temporary directories with safe mode, a dedicated system prompt, no built-in or
MCP tools, no skills, and no session persistence. They retain normal authentication
but not parent session/task identifiers. This prevents the Keep checkout's git
status, instructions, memory and hooks from being mistaken for the source session.
Temporary directories are removed on completion or launch failure. Other headless
agent workflows retain their existing settings; this isolation is specific to
the summarizer.

Caches include a generator version and hash the instruction, model and source.
Pre-isolation caches are ignored (not fed into new titles) and regenerate through
the bounded queue. Title inputs explicitly identify the source session's project
and card. A trivial latest reply does not block repair of an invalidated cache.

Delivery diagnostics persist in `.keep/delivery/diagnostics/events.jsonl` with
one rotated `.1` file (roughly 2 MiB total). Attempts have correlation IDs and
record precheck, writing, screen confirmation, Enter, exact-draft checks and
receipt outcomes. Only identity fields and boolean checks are retained: no
message, command, screen, key values or raw error text. Diagnostic write failure
does not affect delivery. Unlike the in-memory focus/status traces, these survive
daemon restarts. Answers recorded by their own asking session are acknowledged
without terminal reinjection; cross-session answers still require delivery.

## Conversation readiness versus background obligations

Interactive ended conversations default to needing the next instruction. Card
status, dependencies and scheduled checks are retained separately in
`activity.background` and the triage background label; they do not alone override
conversation readiness. Explicit questions can coexist with background work.
A deliberate yield must have concrete job, dependency or schedule evidence.
Jobs launched in the current user turn also supply yield evidence; an older job
does not automatically suppress the response to a new user instruction.

Stop hooks retain only an inferred intent enum from the provided final message,
not the message itself. A Stop is used only with corroborated transcript end-turn;
new user/tool activity invalidates it. Native hooks do not provide a guaranteed
semantic stop reason, so transcript fallback remains explicitly inferred.
This is not a claim of perfect natural-language intent classification.

Claude recurring CronCreate/CronDelete results are recovered into the job ledger.
Recurring polls may support a scheduled wait only for their creating process and
within their seven-day lifetime. Process exit/replacement, cancellation and expiry
invalidate them. One-shot schedules are recorded but do not establish a persistent
wait without completion evidence. Existing Claude ledgers replay once to recover
cron events; Codex checkpoints do not reset for this adapter addition.

Scheduling through `keep add/checkin --check-after` now records a structured, turn-scoped
handoff alongside the schedule: `scheduled_by`, `scheduled_at`, `scheduled_for`
and `scheduled_intent`. After that turn ends, a matching session/check with a
recipe yields to the check without interpreting the final wording. A newer human
or automated turn, a replacement process, schedule cancellation/replacement, or
task completion invalidates the handoff. Explicit questions still take priority.
Use `keep checkin ... --handoff needs-input` when scheduling and also handing a
decision back to the user; `--handoff waiting` can explicitly reaffirm a schedule.
Editing only a recipe does not create a wait. Older schedules without a timestamp
are not retroactively assigned intent; their next scheduling action writes it.

Scheduled-task polling runs every minute (first pass 30 seconds after daemon
startup). Delivery may still defer while a conversation is busy. The default
busy-thread grace remains roughly two hours: 120 one-minute deferrals before
headless fallback, rather than 12 ten-minute deferrals. Explicit
`KEEP_DELIVER_MAX_DEFERRALS` overrides remain counts of polls.
