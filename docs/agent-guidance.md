# Agent guidance

Keep's skills assume a few process conventions that live in your own agent
instruction files rather than in this repository. This page is the source for them:
read it once, then paste the blocks below into your own `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`. Adjust the wording to your team; the skills only depend on the
substance.

## What Keep expects from an agent session

Register substantive work in Keep before starting it, and check in whenever the state
changes or before you finish, writing each check-in as state plus the next step rather
than a diary. Cite the commits you produced, and close a card when the work and its
validation are done instead of parking it on someone's review queue. Answer questions
about what is in flight from `keep list`, `keep overdue` and `keep resume`. The full
conventions — statuses, scopes, handoffs, scheduled checks, review findings — are in
[the Keep skill](../skills/keep/SKILL.md), which is installed with the `core` pack.

## Suggested CLAUDE.md block

```md
# Implementation

If the session model is a Fable model (`claude-fable-*`), load the
`implementation-handoff` skill before the first code edit of the session: it routes
the implementation to Codex or to a cheaper Claude model instead of spending the
scarce budget. On any other model, implement directly.

# Finishing work

After completing a nontrivial code change, run an independent review of it without
asking: load the `codex-review-runner` skill, which launches the review as a
read-only background task on a separate account. Skip it only for a trivial change —
a line or two, a config value, a typo — and never after read-only work or questions.

Run the review before the push, not after: commit locally, review that commit, wait
for the result, fix what is real, rerun the tests, and only then push. Relay the
findings, and say what you left alone and why.

Record the review you launched with `keep reviewing <card> --job <id> --commit
<range>` as soon as it has a job id. If your turn ends before the verdict does, the
daemon settles it and the card says whether the review came back or died — a run
that ends without a verdict is not a clean review. `keep review-route` says which
reviewer to use when an account is at its usage limit.

# Git

Local commits are always fine — commit without asking. Commit on the branch that is
already checked out; never create a branch unless asked. Pushing to an existing
branch needs no approval once the review above has run. These always need their own
confirmation, every time: `git push --force` / `--force-with-lease`, `gh pr create`,
`gh pr merge` / `gh pr close`.

Optional: for isolation, give each task its own worktree with the shipped `wt` script
(`keep-wt`) — `wt new <repo> <slug>` to start, `wt ls` to see them, `wt land` to
rebase and push the branch — and keep agent work out of the shared main checkout.

# Keep — work registry

Register substantive work in Keep and check in when the status changes or before
finishing. Load the `keep` skill before acting on it; answer "what am I working on"
from `keep list` / `keep overdue` / `keep resume`.
```

## Suggested AGENTS.md block (Codex)

```md
# Reviews

Before reporting a task done, get a second opinion from a reviewer subagent and act
on what it finds. The one exception: if the prompt contains the phrase "handoff from
Claude Code; do not spawn a reviewer", skip the reviewer and report back directly —
the review happens on the Claude Code side after the handoff returns, so an inner
review only doubles the wall time.

In an unattended session (the SessionStart block says Keep opened it and nobody is
reading it) do not use request_user_input or end on a question: decide, record the
decision on the card, or file a `keep needs`. The reviewer subagent stays required
unless the prompt carries the handoff phrase.

# Keep — work registry

The same Keep conventions apply here as in Claude Code: they are in the shared `keep`
skill. Register substantive work, and check in with the state and the next step
before you finish.
```

## Skill packs

`keep setup skills` installs the `core` pack alongside `keep setup hooks`: the `keep`
skill (cards, check-ins, plans, dependencies, closing), its situational companions —
`keep-scheduled-checks`, `keep-sessions`, `keep-shared-state`, `keep-ops` and
`keep-agent-session`, each loaded only when its moment comes — and `fleet-review`. `keep setup skills --pack handoff` adds the three
handoff skills (`implementation-handoff`, `codex-review-runner`, `ui-driving-handoff`),
which refer back to this page for the conventions above.

## Accounts

Secondary Claude and Codex profiles, used above for review and implementation
handoffs, are described in [accounts](accounts.md) and
[account setup](account-setup.md).
