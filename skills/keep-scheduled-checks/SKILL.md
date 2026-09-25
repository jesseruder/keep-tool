---
name: keep-scheduled-checks
description: Schedule future work on a Keep card - --check-after, --check recipes, --probe, --on-pass, --check-every, and the --handoff flags. Use when launching an experiment, when anything must be done or verified later (a deploy to confirm, a metric to read, a rollout to re-check), when writing or editing a check recipe, or when a delivered "[keep]" check arrives in this session.
---

# Keep — scheduled checks

Anything that must be done or verified later belongs on a card with a check: an
experiment readout, a deploy to confirm in an hour, a metric to read after the weekend,
a cert expiring in 60 days, a rollout to re-check once adoption ramps. The core `keep`
skill covers cards, check-ins and statuses; this one covers the scheduler.

## Scheduling

- A new card: `keep add "title" --check-after <when> --check "<recipe>" --status waiting`.
  For an experiment add `--kind experiment`, and `--experiment-id <id>` when one exists.
- An existing card: `keep checkin <id> --check-after <when> --check "<recipe>"`.
- `when` is `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `+12h`, `+3d`, `+2w`, or `tomorrow`.
- `--check-after` on its own, with no `--check` and no `--probe`, schedules nothing — it
  only makes the card show up in `keep overdue`.
- Run one early with `keep verify <id>`; run a probe by hand with `keep probe <id>`
  (exit 1 = failed; it lands no check-in).

## What happens when it comes due

This is a scheduler, not a reminder: when the time arrives, `keep serve` delivers the
recipe to an agent that runs it and lands the outcome on the card as a check-in. The
daemon polls due recipes every minute.

- If the session that scheduled it is still open — even if it has been idle for hours —
  and not mid-turn or waiting on Owner when the time comes, the recipe is sent into that
  thread, and that thread is expected to run it and check in (`--clear-check-after`, or
  `--check-after` to reschedule). Busy sessions retain approximately two hours of default
  deferral before Keep opens a session instead.
- Otherwise Keep opens a fresh interactive Claude session on the card and types the same
  instruction into it — nothing runs headless. At most one such session per card per day,
  and none while the checks account (the automation pool's pick for `checks`) has its
  usage window exhausted (the card records a
  `check deferred` note and stays overdue). A deferral has a ceiling: on the second
  deferred day, or after 24 hours, Keep either opens the check on a configured
  `checks-fallback` account or records one `check stalled` check-in, and `keep overdue`
  says so from then on. A card marked `check stalled on the account budget` never ran
  its check — run it with `keep verify <id>` or reschedule it.
- Keep closes the session it opened once the check is on the card, or after an hour of
  silence — never mid-turn, and never over an unsent draft or an open question. If it
  ends without recording anything, the card says so and comes due again.
- Recurring checks are never delivered into a thread — they always go to a session Keep
  opens.
- A card with `--agent <name>` runs its checks as that standing agent: the session shows
  under Agents in the console (working on the card, idle when its pane is reaped) and
  `keep agents emit <name> …` from it lands on that agent's feed. Use it for a daily
  review or any recurring check Owner wants to see as an agent rather than a card.

## Say what a pass means

So a green check does not sit in Owner's review queue with nothing to decide:

- `--on-pass done` closes the card.
- `--on-pass rearm --check-every +7d` keeps it waiting and re-arms the check from now
  (minimum `+10m`; `--check-every` alone implies `rearm`).
- The default is Owner review.

Whoever runs the check records the outcome itself with `keep checkin`; the delivered
message spells out what this card's declaration means, so a `done` card is told to close
itself and a `rearm` card is told to re-arm with `--check-after <check_every>`.

## Prefer a probe when the check is a shell assertion

`--probe "<cmd>"` is a read-only one-liner whose exit code decides the card with no model
session at all. Use absolute paths (`/opt/homebrew/bin/...`) — the daemon's shell may not
have Homebrew on PATH — and keep it read-only. A failing probe escalates to the `--check`
recipe when the card has one, and otherwise lands for Owner review. `--probe ""` removes it.

## Scheduling yields your turn

Scheduling with `--check-after` records a turn-scoped waiting handoff for the scheduling
session. If you also need Owner's decision, add `--handoff needs-input` to `keep checkin`;
use `--handoff waiting` to explicitly yield to an existing scheduled recipe. Both require
a check time and recipe. A new human or automated turn, cancellation, changed schedule, or
completed card invalidates the old handoff; explicit questions still take priority.
Editing only `--check` does not yield a turn.

For fleet state (another card's step, a hold clearing), prefer `keep wait` as a background
command over timed `--check-after` rechecks — see the core `keep` skill.

Keep tracks Claude CronCreate/CronDelete as process-scoped scheduled jobs; for durable
checks that must survive session closure, use `--check-after` plus `--check`.

## Writing the recipe

Write a `check` recipe so that a stranger could run it — usually the thread that scheduled
it gets it first, but if that thread is closed a fresh session with no memory of this
conversation runs it instead. Name the system, the exact query or command, and the
threshold that decides the outcome. "Check if the experiment worked" yields a useless
verdict; "run query 1488 on Redash #109; if either arm has <500 exposures, it is still
ramping" does not. Keep it short, and keep it read-only — a check reports, it does not fix.

Never cite a `/tmp` path in a recipe; macOS purges `/tmp` on reboot. Copy files with
`keep artifact <card> <file>...` and cite the printed path.
