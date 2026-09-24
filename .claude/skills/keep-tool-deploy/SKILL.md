---
name: keep-tool-deploy
description: Land and deploy a change to keep-tool itself - review, wt land, fast-forwarding the live main checkout, keep restart-daemon, refreshing skill links, and what to do when any of those is refused. Use in the keep-tool repo when a change is committed and ready to ship, after wt land prints a skip, or when deciding whether a change needs a daemon restart.
---

# Deploying keep-tool

The main keep-tool checkout is the running daemon's code. It must stay clean and on the
default branch: never edit or commit there. All work happens in a `wt` worktree.

## Order

1. **Test.** Run the focused test files for what you touched, then the full suite
   (`npm test`) with `KEEP_REVIEWER*` unset. Known load flakes (`host.test.js` screen
   reload, browser visibility tests): rerun the file alone on a quiet machine and compare
   against the base commit before calling it a regression.
2. **Commit locally**, then **review that commit** before anything is pushed — the
   `codex-review-runner` skill. Daemon code that launches sessions, types into sessions,
   or advances a delivery cursor gets the adversarial review at high effort; expect more
   than one round. Codex cannot commit in this repo (its sandbox mounts `.git` read-only),
   so commit here after a handoff.
3. **Record and land.** `keep reviewed <card> --commit origin/master..HEAD --verdict clean
   ...`, then `keep land <card>` (or `wt land`). A `findings` record is not superseded by
   the fix commit: re-review the fixed range first.
4. **Read the land output.** `wt land` finishes the deploy itself: it fast-forwards the
   main checkout to what it pushed and runs `keep restart-daemon`. Inspect any skip or
   failure before recovering. If the checkout is already past this land, the newer landing
   session owns the deployment: do not pull or restart it; verify health and coordinate
   with that session. Do not discard unrelated changes or switch a busy live checkout's
   branch. Recover only when the checkout is safe and this landing still owns the deploy.
   The pull and restart are the `deploy` step, so other
   sessions see who is deploying instead of coordinating by note and `keep tell`:
   - leave the worktree (`ExitWorktree` with action `keep`; a worktree session cannot run
     git against another checkout),
   - `keep steps keep-tool` — how far the running daemon is behind origin, and whether
     someone already holds the deploy (then `keep step claim keep-tool deploy --wait`
     instead of doing it twice),
   - `keep step claim keep-tool deploy -m "<card>: <sha>"` then
     `keep step run keep-tool deploy` (the pull `--ff-only` and `keep restart-daemon`).
   A failed run keeps your claim and prints its log: a dirty or diverged main checkout
   fails the pull. Coordinate with its owner and record the blocker before retrying.
5. **Read the health report.** After a restart that happened, `wt land` watches
   `keep health` for up to 90 seconds, so run `wt land` / `keep land` with a command
   timeout of at least five minutes or the report is cut off (`keep land` records its
   check-in before the deploy, so the citation is safe either way; `--no-health-wait` or
   `WT_HEALTH_WAIT=0` skips the wait). What it prints:
   - one line saying no scheduler regressed: done.
   - `<row> failed once since the restart`: often the restart itself (delivery,
     handoff-queue, auto-compact while the host reattaches). No revert; glance at
     `keep health` a few minutes later.
   - `DEPLOY REGRESSION`: a row that was healthy before the restart (or a row the deploy
     added, marked `(new row)`) failed twice in a row on the new code. `DEPLOY FAILURE`:
     the daemon never recorded a start on the new code, or started more than once (a
     crash loop). Both print the range that went live and a `git revert --no-edit
     <from>..<sha>` to run in a fresh worktree. The range starts at the commit the old
     daemon was running, so it can include other sessions' commits that had not been
     deployed yet — check with them before reverting theirs. Nothing is reverted for you:
     fix forward or revert, review, and land as usual.
   The daemon keeps watching for 30 minutes (longer for slow rows): a `deploy` row in
   `keep health` that reads "X started failing after deploy <sha> (was <sha>)" is the same
   finding arriving after `wt land` exited. It clears itself once the row succeeds again.
6. **Skills changed?** New or renamed skills need `keep setup skills` (and
   `keep setup hooks` when the hook text changed) so every managed account links them;
   sessions load new skills on their next start.
7. **Check in** with the landed shas (post-rebase, not the worktree shas) and whether the
   daemon restarted.

## Does it need a restart?

- `bin/serve.js`, `bin/serve/`, schedulers, anything the daemon `require`s: yes.
- CLI-only commands, skills, docs, tests: the pull is enough.
- `web/` assets: served from disk; reload the console.
- The terminal host (`bin/host.js`) is separate: `keep host reload` swaps its code without
  ending panes. `keep host shutdown` ends every pane and every session — never as part of
  a deploy.

## When the restart is refused

`keep restart-daemon` refuses when a restart would lose work; never work around it with
`launchctl` or `kill`.

- A compaction or delivery in flight: wait a few minutes and retry.
- "Pending model restoration prevents daemon restart": a `.keep/compact/*.swap.json`
  record. If its session is live, wait. If the session has exited, the record can never
  clear by itself — report the session id and the reason from the matching `<sid>.json`
  to Owner; deleting it is his call.
- If the change does not need the restart, say so in the check-in and move on.

## A fix already on origin but not running

`keep health` shows the daemon's `code <sha>`, and `keep steps keep-tool` says how many
landed commits it is behind. If the fix you were about to write is already there, there
is nothing to land: claim and run the `deploy` step rather than filing a need for Owner.

The daemon's own git pull syncs the `~/keep` registry, never this code.
