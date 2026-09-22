# Agent accounts

Keep can launch any number of Claude or Codex profiles in one workspace. Each conversation is pinned to the account that created it. Opening, restoring, restarting, and recovering that conversation keeps the same account unless you explicitly run a handoff.

Account configuration contains only an id, label, provider, and config directory. Keep never stores or copies login credentials. With no account configuration, `claude/default` and `codex/default` preserve the existing native CLI behavior.

When you add a Codex profile, Keep immediately adopts the current default Codex profile's shared capabilities. Each later launch refreshes those managed values before Codex starts. See [shared account setup](account-setup.md) for the exact boundary and override behavior.

## Choose an account in the desktop app

The project rail and Watch launch controls open a **New session** chooser. Select **Plain shell**, **Claude Code**, or **Codex**, and edit the launch directory when you want to work somewhere other than the current project. The directory must be an absolute path to an existing directory. Agent sessions include an account selector and an optional model override for that launch. Fresh Claude sessions prefill Fable 5.1; clearing the model uses the account default. Plain shells keep their normal shell configuration. These choices do not change global account or model settings.

**Reopen** in Fleet, Triage, and Watch shows the conversation's recorded account. Keeping it resumes normally. Choosing another account of the same provider performs a verified native transfer and opens the conversation without sending an instruction to continue working. The source may first reopen on its recorded account so Keep can verify and transfer it safely. If native transfer is unavailable, **Transfer context…** offers the separate, explicit fresh-conversation workflow below.

Review-queue **Start work**, **Investigate**, and **Discuss** use the same agent, account, and model choices. Retry and recovery preserve the saved selection. Conversation links, saved successors, and history navigation only open the existing view; they do not choose an account or launch another process.

The existing **Continue on another account** action on a live session still transfers and sends a continuation instruction. Use **Reopen** when the intent is only to open a closed conversation.

## Delegate implementation or review from Claude

Claude's implementation and review skills use `keep codex` to select a Codex account for each new job. Tell Claude which registered account to use, or let it resolve Keep's configured Codex default. The selected account remains explicit for resume lookup, launch, status, results, and cancellation, even if the default changes later.

For example, `keep codex --account codex-secondary context --json` shows the selected account and its job paths without starting a task. Jobs and brokers are isolated per account and configuration directory; existing plugin jobs keep their original state. See [delegated Codex jobs](codex-delegation.md) for commands and lifecycle details. Launching Claude from Codex is not supported yet.

## Add a Claude subscription

Choose a new, empty config directory. Setup must run before login because it creates the profile directory and shares compatible settings, skills, rules, commands, and repository memory without linking account state or credentials. It also copies the source profile's installed plugins into the new profile. Run the same setup command again later to install any plugins the source has picked up since.

```sh
keep accounts add claude-secondary \
  --agent claude \
  --label "Claude secondary" \
  --config-dir "$HOME/.claude-secondary"
keep accounts setup claude-secondary --share-from claude/default
keep restart-daemon
```

Then sign in directly with Claude. This is an explicit authentication action and opens the provider login flow:

```sh
env \
  -u ANTHROPIC_API_KEY \
  -u ANTHROPIC_AUTH_TOKEN \
  -u CLAUDE_CODE_OAUTH_TOKEN \
  -u ANTHROPIC_BASE_URL \
  -u CLAUDE_CODE_USE_BEDROCK \
  -u CLAUDE_CODE_USE_VERTEX \
  -u CLAUDE_CODE_USE_FOUNDRY \
  CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" \
  CLAUDE_SECURESTORAGE_CONFIG_DIR="$HOME/.claude-secondary" \
  claude auth login
```

Check the login without printing identity or credential fields:

```sh
env CLAUDE_CONFIG_DIR="$HOME/.claude-secondary" \
  CLAUDE_SECURESTORAGE_CONFIG_DIR="$HOME/.claude-secondary" \
  claude auth status --json |
  jq '{loggedIn,authMethod,apiProvider,configDirectory,projectsDirectory}'
```

List profiles or choose the default used only for new sessions:

```sh
keep accounts list
keep accounts default claude claude-secondary
```

Open a new session on a selected account:

```sh
keep open <card> --fresh --agent claude --account claude-secondary
```

Specifying `--account` while resuming an existing session does not move it. Keep rejects a conflicting account and asks for an explicit handoff.

### A fresh open with no account named

`keep open <card> --fresh` without `--account` no longer goes straight to the registry default. Keep tries the caller's own account first — every launched session carries it as `KEEP_AGENT_ACCOUNT_ID` — then the registry default, then the remaining accounts of that provider in registry order, skipping any whose weekly or five-hour window is spent. An account with no usage reading is still usable, but ranks behind one that is known to have room, and an id from the other provider is ignored. The result names the account it opened on and, on a second line, which accounts it passed over and why.

Every applicable window is judged and the worst one decides, so a comfortable week cannot hide a five-hour window at 100%. Codex accounts are read the same way, from the `week` and `5h` windows their own rollout records, with a longer horizon before the reading counts as stale — Claude's snapshot is polled, while Codex's only advances when a Codex session takes a turn.

The window judged is the window the launch would actually spend. With `--model`, that model's per-model weekly bucket applies to every candidate. Without one, each Claude account is judged against its *own* default model — the `model` in that account's `settings.json`, which is what `claude` itself reads at startup — so an account sitting at `week 80%` with its default model's `Fable wk` at 100% is passed over rather than handed a session that cannot take a turn. An account whose settings cannot be read, or that names no model, keeps the generic `week` and `5h` windows; Codex accounts always do.

A stale reading is unknown, and unknown still launches — except that usage only rises until a bucket resets, so a bucket that read at or past 100% and whose reset is still ahead of us is spent right now however old the reading is. That one verdict survives staleness in both providers; a stale reading never proves *room*, and a spent bucket whose reset has already passed is unknown again.

If every account of that provider is at the wall, the open is refused and names each account's limiting bucket and reset time. Launching anyway is `--account <id>`: an explicit account is always honoured, spent or not, and a spent one prints a `warning:` line on stderr. This applies only to `keep open` asking; the daemon's own launches — scheduled checks, the reviewer, restore, reopen, and the console, which always names an account — keep the behaviour they had.

### Where the readings come from

`bin/usage.js` polls the OAuth usage endpoint per Claude account every five minutes into `~/keep/.keep/usage-cache.json`. That endpoint's limit is per account and shared with every running Claude Code session, so `HTTP 429` is weather, not a fault. A 429 starts a ten-minute cooldown that doubles to at most **twenty** minutes — short enough that a recovered endpoint is read again inside the thirty-minute window the consumers judge staleness by. A `Retry-After` header longer than that is still honoured: that one is the server saying when it will answer.

While that is running, the `usage` row in `keep health` stays out of the red. When *every* failure in a batch is a 429 and each affected account still holds a reading younger than two hours, the row records a skip — `rate limited (Primary); retrying 12:40, reading 14m old` — and the daemon logs one line on entering that state rather than one per poll. Anything that is not a rate limit, a 429 against an account with no reading, or a reading older than two hours fails the row exactly as before.

There is one `usage` row for every account, so weather on one account must not erase another's evidence. The skip clears the failure streak only when no account is sitting on an unresolved fault that is *not* a rate limit — broken credentials, a timeout, an unparseable response, a Codex scan that found no snapshot. When one is, the detail says so (`…; unresolved: Primary: credentials unavailable`) and the skip leaves the streak alone: weather does not inflate it and does not clear it, so the real fault still turns the row red on its own third retry.

### Automation accounts

Work the daemon starts by itself runs under a named *purpose* in
`automationAccounts` in `~/.config/keep/config.json`, resolved by
`accounts.automationFor('claude', <purpose>)`. Each purpose falls back to
`automationAccounts.claude` and then to `defaultAccounts.claude`, so none of them
needs configuring to work:

- `reviewer` — the fleet reviewer pane, and the budget its ticks are checked against.
- `watcher` — the turn watcher's verdict calls.
- `ideas` — the daily ideas sweep, and the budget it is checked against.
- `repair` — the headless daemon self-repair runs (see [daemon self-repair](self-repair.md)).

With more than one Claude account configured, an automation path that does not pin
an account cannot read a budget at all: it reports "reviewer account is unknown in
multi-account mode" and does nothing. Pin the busy purposes onto their own account
rather than letting them share the interactive default's weekly window.

## Transfer a limited session

Native handoff moves an existing conversation between two accounts for the same provider. Use **Continue on another account** in the dashboard or the CLI with the exact session and pane:

```sh
keep handoff <session-id> --pane <pane-id> --account claude-secondary
```

**A transfer you start yourself is forced.** Every click on **Continue on another account**, its **Retry**, a **Reopen** onto another account, and `keep handoff --force` send `ownerForce`. Keep then asks for no proof that the session is idle: it tries a graceful close, then SIGTERM and SIGKILL on the exact process tree it inspected, copies the conversation, and resumes it on the target. You can see whether the session is working; a turn in progress is interrupted. What still refuses is what would make the move fail or corrupt it: the target not logged in or set up incompatibly, a permission class or model that cannot be reproduced, overlapping or aliased profiles, a rollout that changes while it is copied, or a process that is not the one inspected. For Codex, a forced move reads which child threads belong to the conversation from each rollout's own `session_meta` instead of the job ledgers. A forced request never joins the retry queue: its refusal comes back to the click. The rate-limit queue and every other automatic transfer never force and keep the full verification below.

Before stopping the source, Keep verifies the target login, compatible provider settings, a reproducible permission class, model, reasoning effort, approval policy, reviewer, and working directory, an idle or terminal rate-limited turn, and the absence of unresolved tools, background commands, child agents, drafts, questions, or permission dialogs. Only after every preflight succeeds does Keep exit the source gracefully. It copies the verified conversation artifacts, resumes the same session id under the target profile, changes durable authority, and sends one continuation instruction.

The child agents in that verification are found by their transcripts, and those are not always beside the parent's. Keep looks for `agent-<id>.jsonl` under `<projectDir>/<sid>/subagents/` first, then under the same session id in every other project directory of the source profile — a session that changed cwd into a worktree writes its later subagent files there — including a `<sid>.superseded-*` tree, and finally, only if exactly one exists, under some other session's tree. The search never leaves that profile's `projects/`, and every extra tree it finds moves to the target with the session. A child with no transcript anywhere, or one sitting under a foreign session's tree, is skipped when the parent's own job ledger says that agent finished, and refuses the transfer when it does not.

Claude Code asks its folder-trust question in the directory a session resumes in, and a transfer that lands on that dialog never gets its continuation typed. So when the source profile already trusts the resume directory — or an ancestor of it — Keep writes that same directory key into the target profile before it stops the source, and records it as `trustCarried` on the handoff record. If the source does not trust it either, nothing is written: there is no answer to carry, and the target's dialog is the correct outcome. A target that cannot be pre-trusted refuses the transfer with the session still running, and a trust dialog seen on the target afterwards is reported as *awaiting workspace trust*, which parks rather than retries.

### Move every rate-limited session at once

When an account has more than one session parked on its weekly limit, the account controls offer **Move N rate-limited sessions to ‹account›**, one button per same-provider destination, with that destination's usage next to it. The button does not transfer anything. It enqueues each of those sessions in the daemon's transfer queue (`~/keep/.keep/handoff-queue/`, one file per session) and answers with what it queued and what it skipped.

A queue entry is only patience. Every thirty seconds the daemon takes the entries that are due and asks for the **same** transfer the single-session button asks for, through the same `handoffSession`, with every preflight intact. The queue never bypasses a check, never launches or types anything, and passes `force` only when the request that queued the session carried it.

What happens to a refusal depends on which kind it is:

- **Transient** — the injection lock was busy, a turn or a background child was still finishing, the pane was being watched, the job ledger was recovering, the host timed out (including a pane list the host did not answer, which refuses as *host request timed out listing panes* rather than *Interrupted handoff needs the original pane*), `ps` failed (including the `ps` a post-hoc stop proof needs, below), a `caffeinate` or sentinel child was still around. A process that looked changed belongs here too: the identity and helper checks read one `ps` snapshot, which under memory pressure can come back wrong, and each attempt re-derives the identity from a fresh one rather than remembering a mismatch. So does a restart whose typed `/exit` the screen never confirmed *and* which took that draft back off the pane, since the pane is then exactly as it was found. These clear on their own, so the entry waits 20s, then 40s, 80s, 160s, and every 3 minutes after that. If it is still being refused `KEEP_HANDOFF_QUEUE_MAX_MIN` minutes (45 by default) after it was queued, it parks and the console shows **Transfer gave up: ‹reason›** with **Retry** and **Cancel**.
- **Blocked** — an unreproducible model or permission class, a logged-out target, a missing artifact, an incompatible target setup, a dialog on the screen, a typed `/exit` still sitting in the input box. Retrying would only repeat it, so the entry parks immediately and the console shows **Transfer needs you: ‹reason›** with **Cancel**.

The model a Claude session is relaunched with comes from its transcript: the newest genuine assistant record names the base model, and a typed `/model claude-…` names the model and its context window exactly. A `/model` with no argument (the picker) or a bare alias (`opus`) leaves only the harness's confirmation, `Set model to `Fable 5.1`` or `Opus 5 (1M context)`, and that label is believed only when its family and version match the model something else has already proven: the assistant record after it, or the pane's launch metadata when nothing in the file is newer than the switch. The label then decides the `[1m]` window. Because `modelPicker` rows in settings can rename a row, no label is believed at all when a `--settings` file was passed, when the launching account's `settings.json` or the machine's managed settings define `modelPicker`, or when a macOS managed-preferences profile for Claude Code exists; those transfers refuse with "Current Claude model cannot be reproduced safely" as before. Picker rows delivered by an organization's server policy, and rows removed from settings after the pick, cannot be seen from here. That is the accepted residual: behind an assistant record it is limited to the context window, because the record proves the base model; when the pick is the newest thing in the file, the launch metadata proves only the model before the pick, so a renamed row there could also mean a different base model. Keep does not run under such policies today; a machine that does should keep its `modelPicker` in a source this reads. A `/model` the API refused — the harness answered it with `API error: 429 …` (or any other API error) instead of `Set model to …` — changed nothing, so the scan steps over it to whatever set the model before. Keep's own compaction switch now types a full id (`/model claude-opus-5`, with `[1m]` on a 1M session) for the same reason: a bare `/model opus` is exactly the row this has to take on a label's word.

Before each attempt the queue rebuilds live state — not once per tick, because the transfer ahead of this one may have taken minutes — and rechecks that the entry still describes the session. Where the session lives is resolved from durable authority first, the same source the transfer itself uses, and only then from the state row. A session that has left the state, that is already on the target, or that a person has since moved to some third account is retired rather than transferred from wherever it is now. If the rate limit has cleared — the window reset, or the person simply went back to work — the entry is cancelled with "rate limit cleared" instead of stopping a live session and typing a continuation into it.

The one exception is a transfer that has already passed its stop: the source agent has exited, or its artifacts and target authority are staged behind it. Those have to finish, or the session is stranded. A refusal that landed *before* anything was stopped — an injection 429, say — is not one of those, even though it leaves the same `recovery-needed` record behind.

The queue's own snapshot can still be a moment stale, so it names its assumptions on the request: `expectedSourceAccountId` and, unless the transfer is past its stop, `expectedRateLimitAt`. The transfer re-resolves both before it writes a journal record or stops anything. The limit is then checked twice more, because the target-login preflight starts an interactive shell and can take the better part of a minute: once after that wait and still before any write, and once inside the injection lock on the session the restart is about to close. A person can finish a turn in that window, and stopping an idle session to type a continuation into it is exactly what the expectation exists to prevent.

**Cancel** takes effect immediately, even while another session's transfer is in flight or the state for this one is being rebuilt: the entry is re-read with the fresh state in hand, and the attempt's result is only written if it has not changed underneath it.

The single-session **Continue on another account** button uses the same patience. When that transfer is refused for a transient reason *before* anything was stopped — the injection lock was busy, the host timed out, a `ps` snapshot came back unreadable — the console queues it and it is retried on exactly the same schedule, with **Cancel** in place of the transfer controls. Every attempt still refuses to stop a session that is mid-turn. `keep handoff` is unchanged and reports the refusal to whoever typed it.

Queuing is only offered for a refusal Keep can still see the source agent behind. A record with no verified stop is not proof the agent is running — the typed `/exit` can have landed and a later host call timed out — so the source process is checked in `ps` first, and a transfer whose agent has already exited is left alone with its recovery controls rather than promised a retry the recovery guard would then park. The same goes for a refusal whose live state could not be read at all: without it there is no way to tell which rate-limit event, if any, the entry is for.

A transfer whose typed `/exit` did land, but whose confirmation was lost to a later host timeout, is recovered rather than stranded. The restart journals `sourceExitEnterAt` on the record just before it presses Enter on its typed `/exit`, after every check before that key has passed; the mark is taken back when the host refuses that Enter, and every new stop attempt starts without one, so a draft that was refused or taken back never counts. On the next attempt, a `recovery-needed` record still in `stopping-source` with no `sourceStopVerifiedAt` proves the stop after the fact when all of these hold: this attempt's `/exit` Enter was committed; the pane is the record's own, still carries this session, has not been relaunched since this transaction started (a `handoffTransactionId` marker left by the earlier transfer that launched this source is recorded as `sourcePaneHandoffTransactionId` and is fine; this transaction's own or any newer marker is not), and is no longer alive; and a fresh `ps` snapshot has no process with the recorded `sourceAgentPid` and `sourceAgentPidStart` (the pid gone, or reused by a process that started at another time). The record then gets `sourceStopVerifiedAt` with `sourceStopVerifiedBy: "post-hoc-ps"` and the ordinary recovery path runs — copy, relaunch on the target, one continuation. A `ps` that fails or comes back empty keeps it refused as *Source exit could not be verified*, which is transient; a recorded process that is still running, a pane that is not the record's, and a source that exited without this attempt ever committing its `/exit` Enter (a refusal followed by a crash skipped the job-ledger checks the stop makes) all stay *Source exit was not verified by the handoff transaction; recovery is blocked*.

Such an entry usually names no rate-limit event, so nothing cancels it for a limit that cleared. What stands in for that is the person: if the session is used again after the transfer was asked for, the entry is cancelled with "session was used since it was queued" instead of stopping a session somebody went back to work in. The retry carries that moment on the request too, so a turn finished during the attempt's own minute-long preflight — or in the seconds between the last check and the stop — refuses with *Session was used after the transfer was requested*, which parks the entry rather than retrying it. Otherwise it runs until it lands, until it gives up at `KEEP_HANDOFF_QUEUE_MAX_MIN`, or until you cancel it.

A queued session shows **Moving to ‹account›** with its last refusal and a **Cancel** button in place of the usual transfer controls, and counts as a pending handoff, so nothing offers to reopen or restart it meanwhile. A parked entry whose session has moved on keeps its note but hands the ordinary transfer and recovery controls back. The dashboard's `handoffQueue` carries the queued and parked entries plus the moves from the last hour; the queue's own health row is `handoff-queue`.

### Automatic transfer on the weekly limit

`rateLimitHandoff` in `~/.config/keep/config.json` maps a source account to the account its rate-limited sessions should move to:

```json
{
  "version": 1,
  "rateLimitHandoff": { "claude-main": "claude-secondary" }
}
```

With a key present, each queue tick enqueues every rate-limited Claude session on that source account, without `force`, and the ordinary queue rules above take it from there. The pair must name two existing accounts for the same provider and must not name the same account twice; an unusable key is reported on stderr once per tick and ignored rather than guessed at. A target whose own weekly window the usage snapshot shows at 100% is held rather than moved onto; an unknown or stale snapshot is never read as exhausted. A parked or cancelled entry is waiting on a person, so the policy never re-queues it — only the console's **Retry** does.

**This ships switched off.** With no `rateLimitHandoff` key, nothing is ever queued automatically, and the only way a session moves is the single-session button, the batch button, or `keep handoff`.

A session that has been auto-compacted carries a permanent job-ledger history gap that no replay can clear. That gap alone no longer refuses a transfer: once the ledger is caught up with no open job, no unresolved call, no unconsumed hook and a completed restart record, the gap only describes history that predates the compaction, and the full restart proof still runs. Every other kind of gap still requires an explicit forced transfer.

Source artifacts stay as a backup because tool-result records can contain absolute paths. Durable authority prevents their stale duplicate from being discovered or resumed. If a failure occurs after source exit, ordinary open/restart/restore stays blocked. Retry the same command or the same dashboard action to recover the journaled transaction. Keep does not automatically switch accounts, switch back later, or retry a different target.

For Claude, the native copy includes the main project history and verified child/file-history artifacts, and the resumed profile must emit a fresh SessionStart hook.

For Codex, the native copy includes only the root rollout and recursively owned child rollouts from `sessions` or `archived_sessions`. Interacted conversations owned by another root are recorded but are not copied or rebound. Keep does not copy `auth.json`, `config.toml`, SQLite databases, history indexes, cache, or any other profile state. The destination keeps its own login and database. The source and destination must use compatible provider endpoints and protocol settings; target-local credential environment names may differ.

Codex resumes with the latest effective model, reasoning effort, working directory, standard sandbox policy, approval policy, and approval reviewer recorded in the source rollout, even when the destination profile has different defaults. Named or custom permission profiles, multiple workspace roots, unsupported policy fields, symlinked or incomplete rollout trees, ambiguous or unrelated target rollouts, missing owned children, and child sessions selected as roots fail closed before source exit. An archived root must be unarchived in its source account first. A target artifact can be replaced only when the same durable transfer provenance proves its exact prior bytes, which permits a verified transfer back without treating an unrelated matching file as safe.

Add and authenticate a Codex profile separately:

```sh
keep accounts add codex-secondary \
  --agent codex \
  --label "Codex secondary" \
  --config-dir "$HOME/.codex-secondary"
CODEX_HOME="$HOME/.codex-secondary" codex login
```

The add command shares capabilities before the first launch. It does not copy `auth.json`, provider selection, models, projects, history, or runtime state. To change the capability source explicitly, use `keep accounts setup codex-secondary --share-from codex/default` before customizing managed values.

## Start a portable continuation

When native handoff is unavailable, select a linked, settled session in the desktop dashboard and choose **Transfer context…**. Select any distinct Claude or Codex account, optionally choose a model, confirm the launch working directory, and edit the explicit handoff. **Prepare preview** stores a durable immutable package and shows its complete contents before launch. Changing the account, model, directory, or handoff requires preparing and reviewing a new package.

The source must have ended its foreground turn with no running tools or background work. Keep snapshots the source transcript, linked card and next step, account identity, working tree, and Git state. If any of them changes between preparation and launch, the dashboard refuses the stale preview. Two separately prepared drafts cannot create two successors: a source-level launch lock and durable transaction state route the source back to its existing successor or recovery flow.

If a native handoff fails before the source stops and before a target starts, the dashboard can offer **Start fresh continuation**. This is an explicit recovery choice. Keep rechecks the exact live source session, pane, and account before abandoning the native journal, including the recorded process when the transaction has one; later phases and ambiguous identities never get this option. The portable readiness check still blocks every concrete tool or background job. For this verified pre-stop recovery only, it can discount the named ledger-history markers `history-gap` and `history-recovery` when no concrete job remains.

The fresh successor reads the package, card, and worktree, acknowledges the pending instruction, and then waits for a new instruction from Jesse or the user. Automated card and Stop-hook reminders do not resume it. The source remains available. An ambiguous launch is never retried; the dashboard can bind an observed successor only when its account, card, pane transfer identity, and delivered-opening receipt match.

When a fresh destination opens on a workspace-trust screen, Keep saves the exact opening text and destination pane before reporting **Awaiting workspace setup**. Open that existing successor and accept trust yourself. **Retry delivery** rechecks the source and the same pane identity, reserves delivery, and sends the saved opening once. Keep never accepts workspace trust, starts another successor, or resends after an uncertain delivery.

The CLI remains available for an explicit handoff file:

```sh
keep transfer <source-session-id> \
  --account codex-secondary \
  --context /path/to/handoff.md \
  --cwd /path/to/worktree
```

The package contains the explicit handoff document, recent user and assistant prose (including Codex compaction replacement history), the card and next step, and read-only Git state. It excludes tool payloads, environment records, configuration, credentials, native provider state, and provider cache. The source session remains intact, and the destination gets a new session id. A session must be linked to a Keep card before either flow can prepare a package.

Use `--prepare-only` to store the package without launching. Rerunning the exact command launches that prepared package once. If the API result is ambiguous after a possible launch, Keep refuses to try again; inspect the console and bind the observed destination explicitly:

```sh
keep transfer <source-session-id> \
  --account codex-secondary \
  --context /path/to/handoff.md \
  --cwd /path/to/worktree \
  --resolve-session <destination-session-id>
```

## Disposable CLI resume proof

`python3 scripts/account-resume-smoke.py` runs the installed Claude CLI against a local mock API with temporary source and target profiles. It uses a random session, copies the temporary project history, resumes under the second profile, and verifies that the same session id and prior user/assistant context reach the resumed request.

`python3 scripts/codex-account-resume-smoke.py --context-proof` performs the corresponding installed Codex CLI proof from source to target and back to the original source profile. It verifies the same thread id, appended-turn continuity despite the original profile's existing SQLite index, target-local credentials, exact rollout bytes before resume, unchanged profile databases during copy, effective model and permission settings on both resumed turns, archived-root refusal, and unchanged synthetic tool-output and compaction records. Both scripts use temporary profiles and a local mock API; they do not use a real subscription, write a real profile, or perform a login.

The deterministic handoff tests also cover tool results, subagent and file-history artifacts, compact-boundary rows, preserved source paths, and multi-hop transfers. The installed CLI was separately exercised against the same kind of local mock with a real `Read` tool round trip and with `/compact`; the resumed requests retained the historical tool exchange or generated compaction summary as appropriate.

Run that proof before the first two-login smoke. The real smoke should use a disposable session and a harmless prompt before transferring active work.
