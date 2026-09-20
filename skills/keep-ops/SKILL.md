---
name: keep-ops
description: Diagnose and repair Keep itself - the daemon, terminal host, console, scheduled delivery, accounts and Codex jobs - with keep doctor, health, stalled, self-repair, codex-jobs, restore, restart-daemon and force-restart. Use when the console shows "no host pane" or stale sessions, a scheduled check never ran, keep restart-daemon refuses, a headless model call exits 1, sessions vanished after a reboot, or you are a self-repair session on a daemon failure card.
---

# Keep — operating and repairing Keep itself

This is for when Keep is the thing that is broken. Read state before changing any: most
"Keep is down" reports are a slow machine, an exhausted account, or a guard doing its job.

## Look, in this order

1. `keep doctor` — installation: hooks, skill links, launchd service, optional features,
   accounts. Its `fix:` lines are safe to run.
2. `keep health [--json]` — one row per scheduler with last success, consecutive failures
   and the normalized error. A red row names the failing scheduler; the daemon log has
   the stack.
3. `keep stalled [--json]` — sessions, Codex jobs and deliveries that stopped moving.
4. `keep self-repair --dry` — what the daemon would open a repair card for, and why;
   bare `keep self-repair` lists the open signatures, their cards, cooldowns and today's
   count against the daily cap. See `docs/self-repair.md` in the keep-tool checkout.
5. `keep codex-jobs [--json]` — companion jobs and brokers per account. `--reap --dry`
   shows what a reap would cancel; `--reap` cancels stale jobs and orphan pollers.
6. `uptime` and `sysctl vm.swapusage`. A load average several times the core count, or
   swap nearly full, explains timeouts everywhere at once.

## Failure signatures

- **"no host pane" on every console item**, or `keep pane ls` printing `host request timed
  out (list)`: the terminal host is alive but answered `list` slower than the daemon's
  request timeout, so the console published zero panes. The panes are almost always fine.
  Confirm from the socket: a raw `hello` frame to `<registry>/.keep/host.sock` answers at
  once while `list` times out (`keep host status` asks for both, so it times out too).
  Check machine load and swap, and relieve the load
  (runaway test runs, leaked containers; a container VM keeps its memory until the
  container app itself quits). Do not restart the host: `keep host shutdown` ends every
  pane and every session in one.
- **`keep restart-daemon` refuses with "Pending model restoration prevents daemon
  restart"**: a `<registry>/.keep/compact/*.swap.json` record exists — auto-compaction
  swapped a session's model and has not confirmed the restore. If that session is live and
  mid-compaction, wait and retry. If it has exited, the record can never clear by itself:
  report the session id and the reason from the matching `<sid>.json` to Owner. Deleting a
  durable restore record is Owner's call, and the record names the `settingsModelBefore`
  that may need restoring.
- **`keep restart-daemon` refuses for another reason** (a compaction or delivery in
  flight): it is telling you a restart now would lose work. Retry in a few minutes. Never
  work around it with `launchctl` or `kill`.
- **A headless model call exits 1 almost immediately, with the error on stdout**: the
  account is out of usage ("You've hit your weekly limit"), not a bad invocation. Headless
  purposes (summarize, landed, slack, reviewer, watcher, …) map to accounts only in
  `automationAccounts` in `~/.config/keep/config.json`; an unmapped purpose falls back to
  the default Claude account. A new purpose needs its entry before it is tested. Back the
  file up before editing it.
- **A scheduled check never ran**: `keep show <card>` for a `check deferred` note (the
  checks account's usage window was exhausted, or the one-session-per-card-per-day cap
  was reached), then `keep health` for the `runs` row. `keep verify <id>` runs it now.
- **Sessions are gone after a reboot or a killed host**: `keep restore --dry`, then
  `keep restore`. It reopens sessions whose agent process is gone and leaves live ones alone.
- **A session is wedged and a normal Restart refuses**: `keep force-restart` interrupts
  that conversation and its child processes. It needs Owner's explicit approval for that
  exact session every time; read `docs/force-restart.md` first. Never use it, Close, or
  cleanup to correct a displayed status.
- **A probe or check fails with "not logged in"** for a third-party CLI: the token
  expired. Interactive logins need Owner in a real terminal; record it with
  `keep needs <card> "<cli> login"` rather than retrying.

## Maintenance commands

The daemon runs these on its own schedule; run them by hand to inspect or catch up.
`landed`, `standup` and `ideas` take `--dry` to show what they would do without a model
call or a write.

- `keep lint [--rule <name>] [--json] [--fix-hints]` — the deterministic daily hygiene
  checks; refreshes the brief's cached findings. `--rule tmp-artifact` flags cards citing
  `/tmp`; `--rule unsatisfiable-wait` finds waits that can never clear.
- `keep landed [--dry] [--only <id>]` — fetches project default branches, annotates cards
  whose cited shas have landed, and closes review cards waiting only on that land.
- `keep standup [--since "YYYY-MM-DD HH:MM"] [--dry] [--show]` — the weekday standup note
  (an optional feature; see `features` in the configuration).
- `keep ideas [--dry] [--model <m>]` — the fleet-wide workflow-improvement pass over seven
  days of evidence; daily at 07:30 local, retried until noon.
- `keep brief [--send]`, `keep digest`, `keep sync` (a push: follow the session's
  push-approval rules).

## Changing the daemon's code

The daemon runs from the main keep-tool checkout, which must stay clean: work in a
worktree, then land. `wt land` fast-forwards a ready main checkout and restarts the
daemon; it reports a skipped or failed deployment for the landing session to resolve.
For manual recovery, skills, docs and CLI-only changes may need only the fast-forward;
daemon-code changes need the restart too.
The daemon's own git pull syncs the registry, never the code.

A self-repair session follows the recipe on its card: root-cause from the attached health
record and log excerpt, then land a reviewed fix. `wt land` attempts the deployment after
the land; if it reports a skip or failure, resolve it before closing the card. If it cannot
land, it leaves the card in `review` with the branch named and the daemon untouched.

## Reporting

Check in the diagnosis with the evidence (the health row, the log lines, the timings) and
what you ruled out, not just the fix. If the same fault could recur silently, file the
missing guard or expiry as a follow-up with `keep add "<title>" --file`.
