# Keep guidance for Pi

This is Pi's variant of shared guidance. When its Git or Keep rules change, review
`~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` and mirror guidance shared by all three.
Keep Pi-specific tool and lifecycle limits here rather than copying Codex or Claude
handoff instructions.

Pi automatically discovers the Keep skills installed in `~/.agents/skills`. Load the
relevant skill before acting on Keep: `keep` for task work, and its situational
companions for scheduling, sessions, shared resources, or Keep operations. Do not
create duplicate skill links.

## Work registry

Register substantive work in Keep before starting, and check in when its state
changes or before finishing. Write a check-in as the state and its next step. Use
`keep list`, `keep overdue`, and `keep resume` to answer questions about active work.
The `keep` skill is the canonical source for card status, dependencies, permissions,
and closing rules.

When you are a delegated worker, the orchestrating session owns the card. Do not
claim it, change its owner, or create a competing card. Preserve the assigned scope
and report results to the orchestrator; it records the worker's status and handles
review, landing, and any approval that requires the owner.

## Git and completion

Read and follow the repository's `AGENTS.md` before editing. Agent work in
`ghost-server`, `castle-www`, `castle-sandboxes`, `cauldron-game-server`,
`castle-experimental-web`, `jesseland`, `jesse-investing`, and `keep-tool` always uses
a worktree. If you start in one of those main checkouts, run
`wt new <repo> <short-slug>` and change into the printed path before the first edit.

`keep-tool`'s main checkout runs the live daemon and must stay clean: never edit or
commit there. `wt land` deploys it by fast-forwarding the main checkout and restarting
the daemon. If it reports a skip (the checkout is dirty, on another branch,
mid-operation, or already past this land) or the restart is refused, run
`git -C ~/keep-tool pull --ff-only` and `keep restart-daemon`; do not leave those
commands for the user to run. The daemon's own Git pull only syncs the `~/keep`
registry, not the Keep application.

Commit on the branch already checked out. Never create a branch unless asked. Local
commits are allowed. In Castle repositories, use the established `project: message`
commit subject form. `wt land` rebases onto the default remote branch and pushes it.
For nontrivial code changes, obtain an independent review before pushing, resolve real
findings, and validate the result. Pushes to an existing branch are allowed after that
review. Each of these needs the user's explicit confirmation:
`git push --force` or `--force-with-lease`, `gh pr create`, `gh pr merge`, and
`gh pr close`.

Pi runs directly in its own session. It has no Keep-managed native subagent,
handoff, transfer, or compaction workflow. Use only the review or coordination path
that is actually available for the task; do not represent a Pi session as having
provider hooks it does not have.
