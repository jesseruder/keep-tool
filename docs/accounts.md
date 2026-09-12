# Agent accounts

Keep can launch any number of Claude or Codex profiles in one workspace. Each conversation is pinned to the account that created it. Opening, restoring, restarting, and recovering that conversation keeps the same account unless you explicitly run a handoff.

Account configuration contains only an id, label, provider, and config directory. Keep never stores or copies login credentials. With no account configuration, `claude/default` and `codex/default` preserve the existing native CLI behavior.

When you add a Codex profile, Keep immediately adopts the current default Codex profile's shared capabilities. Each later launch refreshes those managed values before Codex starts. See [shared account setup](account-setup.md) for the exact boundary and override behavior.

## Add a Claude subscription

Choose a new, empty config directory. Setup must run before login because it creates the profile directory and shares compatible settings, skills, rules, commands, and repository memory without linking account state or credentials.

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

## Transfer a limited session

Use the dashboard action or the CLI with the exact session and pane:

```sh
keep handoff <session-id> --pane <pane-id> --account claude-secondary
```

Before stopping the source, Keep verifies the target login, compatible shared settings and MCP definitions, a reproducible permission class and model, an idle or terminal rate-limited turn, and the absence of unresolved tools, background commands, child agents, drafts, questions, or permission dialogs. It then exits the source gracefully, copies only the complete conversation artifacts, resumes the same session id under the target profile, verifies a fresh SessionStart hook from that profile, changes durable authority, and sends one continuation instruction.

Source artifacts stay as a backup because tool-result records can contain absolute paths. Durable authority prevents their stale duplicate from being discovered or resumed. If a failure occurs after source exit, ordinary open/restart/restore stays blocked. Retry the same command or the same dashboard action to recover the journaled transaction. Keep does not automatically switch accounts, switch back later, or retry a different target.

Codex profiles can be configured, selected for new sessions, attributed, and kept sticky across restarts. Cross-profile Codex conversation handoff is reported as unsupported until its storage and resume behavior has equivalent end-to-end proof.

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

`python3 scripts/account-resume-smoke.py` runs the installed Claude CLI against a local mock API with temporary source and target profiles. It uses a random session, copies the temporary project history, resumes under the second profile, and verifies that the same session id and prior user/assistant context reach the resumed request. It does not use a real subscription, write either real profile, or perform a login.

The deterministic handoff tests also cover tool results, subagent and file-history artifacts, compact-boundary rows, preserved source paths, and multi-hop transfers. The installed CLI was separately exercised against the same kind of local mock with a real `Read` tool round trip and with `/compact`; the resumed requests retained the historical tool exchange or generated compaction summary as appropriate.

Run that proof before the first two-login smoke. The real smoke should use a disposable session and a harmless prompt before transferring active work.
