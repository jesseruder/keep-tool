# Pi integration

Keep can launch and track [Pi](https://github.com/badlogic/pi-mono) sessions. Pi reads
the global instructions and Keep skills directly; the small Keep extension records
the lifecycle evidence that Pi itself does not expose as native hooks.

## What Pi loads

Pi discovers Keep's installed skills from `~/.agents/skills`. No extra skill links
are needed. The global instructions are installed at `~/.pi/agent/AGENTS.md`; their
source template is [`integrations/pi/AGENTS.md`](../integrations/pi/AGENTS.md).
Project `AGENTS.md` files still supply repository-specific instructions.

Pi has no Keep-managed native subagents, session transfer, automatic compaction, or
message relay. The instructions therefore keep ownership, scope, review, approval,
and worktree rules, without claiming those provider features exist.

## Install the extension and instructions

From the stable main Keep checkout, create the Pi extension directory and link the
extension into it. A link keeps the extension current as the checkout changes. Do not
link a temporary worktree: it can be removed after its work lands.

```sh
KEEP_CHECKOUT=/absolute/path/to/keep-tool
mkdir -p ~/.pi/agent/extensions
ln -s "$KEEP_CHECKOUT/integrations/pi/keep.ts" ~/.pi/agent/extensions/keep.ts
```

Install the global instructions only if there is no existing custom file:

```sh
mkdir -p ~/.pi/agent
test ! -e ~/.pi/agent/AGENTS.md && \
  cp integrations/pi/AGENTS.md ~/.pi/agent/AGENTS.md
```

If `~/.pi/agent/AGENTS.md` already exists, merge the Keep guidance into it instead
of overwriting the user's instructions. The extension is local only; it reads no
credentials and does not need an API key.

## Session lifecycle

### Delegated background work

Codex and Claude can delegate a scoped task to Pi without opening another desktop
session. Pi delegation is opt-in per task. Launch from the assigned worktree:

```sh
keep pi task --background --model opencode-go/minimax-m3 -- 'Implement the scoped task, verify it, and report the commit and checks. Parent owns review and landing.'
keep pi status <job-id> --json
keep pi result <job-id>
keep pi cancel <job-id>
```

Use `keep delegate <card> --step <n> -- keep pi task --background -- '<task>'`
to associate a worker with a plan step. The parent retains the card and records the
outcome. Job status, output, and private Pi transcripts live under
`~/keep/.keep/pi-jobs/`; they do not create top-level desktop sessions. Running
jobs contribute to the parent's pending background work. Omit `--model` to use
Pi's configured default. Failed or cancelled jobs remain inspectable.

Workers run a single task to completion. They do not accept interactive messages
or `keep tell`; start a new scoped task for a follow-up. Keep's interactive session
path below remains available when the user wants a Pi terminal or a full handoff.

### Interactive sessions

Keep opens a fresh Pi session with a stable Pi session id:

```sh
pi --session-id <uuid>
```

It resumes a tracked session with:

```sh
pi --session <uuid>
```

The extension records the current Pi session id when it writes lifecycle evidence to
`~/keep/.keep/pi-events/<session-id>.json`; it follows Pi's current session across a
new session or resume. It emits `start`, `running`, `settled`, `prompt`, and `shutdown`
events, and runs Keep's shared-step and self-repair guards before Bash tools. Pi tool
calls inherit the Keep session context for `keep` CLI attribution. Keep also scans Pi's
JSONL sessions under `~/.pi/agent/sessions`. Pane history remains the terminal host's
scrollback.

When no model is supplied, Keep lets Pi use the provider and model from Pi's own
configuration. Pass a provider-qualified value such as `opencode-go/minimax-m3` with
`--model` to override that configuration for a launch.

Keep does not currently apply Claude's raw-resume guard to Pi, record post-tool step
or deploy outcomes, relay a message into Pi (including mobile replies), or support Pi restart, transfer, handoff,
Keep-managed compaction, or Review Queue automatic launches. Those actions stay
unavailable instead of being emulated.

### On another node

`keep open <card> --agent pi --fresh --node <node>` runs Pi in a pane on that node. The
node must have Pi and the extension installed at `~/.pi/agent/extensions/keep.ts` (`keep
doctor` on the node reports it), and a terminal host new enough to read Pi phase files;
otherwise the open is refused before a pane is started. The extension's hooks reach the
daemon from there (see [agent integration](agent-hooks.md), "Pi sessions on another
node"), and the daemon reads the phase file through the node, so the console shows the
session's turn state and a Pi question as it does for a local one. The console has no
transcript preview for a Pi session on a node yet: its row comes from the pane and the
phase. `keep tell`, `keep move`, Pi background jobs and Review Queue launches stay
unavailable for Pi on a node, as they are on the daemon node (moves: Claude only).

Keep also refuses `keep open <Pi session>` while any interactive Pi process outside a
Keep Pi host pane is running. Pi sets its process title to `pi` and hides the session
arguments, so Keep cannot safely prove which external session it would resume. Exit the
external Pi process, then retry the open. For a session on another node, that node's
processes and panes are the ones checked.

## Verify

After restarting the Keep daemon, open a fresh Pi session from Keep, run `keep list`
inside it, and end the session. The console should show the Pi session and Keep should
associate the command with that session id. Resume the same session and confirm its
prior conversation is present.

See [agent guidance](agent-guidance.md) for the shared Keep conventions and
[agent integration](agent-hooks.md) for the Claude and Codex adapters.
