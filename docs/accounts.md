# Agent accounts

Keep can launch any number of Claude or Codex profiles in one workspace. Each conversation is pinned to the account that created it. Opening, restoring, restarting, and recovering that conversation keeps the same account unless you explicitly run a handoff.

Account configuration contains only an id, label, provider, and config directory. Keep never stores or copies login credentials. With no account configuration, `claude/default` and `codex/default` preserve the existing native CLI behavior.

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

## Disposable CLI resume proof

`python3 scripts/account-resume-smoke.py` runs the installed Claude CLI against a local mock API with temporary source and target profiles. It uses a random session, copies the temporary project history, resumes under the second profile, and verifies that the same session id and prior user/assistant context reach the resumed request. It does not use a real subscription, write either real profile, or perform a login.

The deterministic handoff tests also cover tool results, subagent and file-history artifacts, compact-boundary rows, preserved source paths, and multi-hop transfers. The installed CLI was separately exercised against the same kind of local mock with a real `Read` tool round trip and with `/compact`; the resumed requests retained the historical tool exchange or generated compaction summary as appropriate.

Run that proof before the first two-login smoke. The real smoke should use a disposable session and a harmless prompt before transferring active work.
