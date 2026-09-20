# Daemon self-repair

The daemon fails in the same ways more than once. A scheduler starts throwing the
same error every minute; the daemon restart-loops under launchd's `KeepAlive`; a
delivery incident sits unconfirmed for hours. Each time, somebody has to notice
the red row in `keep health`, open a card, make a worktree, and put an agent on
it. Self-repair is that loop, automated, with the one dangerous step left out.

When a failure signature persists, Keep opens **one card per signature** with the
health record and a log excerpt attached, creates a fresh `keep-tool` worktree out
of process, and opens one repair session there, pointed at a root-cause recipe
stored on the card. The scheduler itself never restarts the daemon and never lands
anything. When the agent lands a reviewed fix, `wt land` fast-forwards a ready
`~/keep-tool` checkout and restarts the daemon. Inspect a skipped or failed deployment:
a checkout already past this land belongs to its newer landing session; recover only a safe
failure the repair still owns, otherwise record the blocker or dependency. If it could not
land, it leaves the card in review with its branch named and the daemon untouched.

## What counts as a signature

A signature is a fault, not an occurrence: `pid 123` and `pid 456` are the same
fault and get one card between them, not one per tick. `bin/self-repair.js`
`signatures()` is pure — it takes a health snapshot and the repair state and
returns candidates.

| Signature | Opened when |
| --- | --- |
| `sched:<name>:<hash8>` | a scheduler has `consecutiveFailures >= minFailures` (5) on one normalized error, and that signature was first seen at least `minAgeMin` (30) minutes before its latest failure |
| `daemon:restart-loop` | more than `restartsPerHour` (3) daemon starts in the last hour, on two consecutive ticks; a start that `keep restart-daemon` asked for (a deploy) does not count |
| `delivery:<incidentId8>` | the `delivery` row's `incidentId` has been unchanged for `minAgeMin` |

Retired schedulers, disabled rows, on-demand schedulers (`usage`, `digest`) and
the `self-repair` row itself never produce a signature. Nor do `runs`, `lint` and
`git-pull`: `runs` fails on delivery and on the sessions the check scheduler opens —
a busy thread, a terminal host that is not up, a card that will not load — which is
congestion rather than a bug in this process, and `lint`
and `git-pull` fail on registry and checkout state (a malformed card, a dirty or
diverged checkout), which is Owner's to fix rather than a daemon bug. A `delivery`
row carrying a live incident gets the `delivery:` signature rather than a second
`sched:` one.

A tick may also decide the state it is reporting is one its own scheduler tolerates
rather than a fault, and record
`health.record(name, { skipped: true, expected: true, detail })` instead of a failure.
A skip ordinarily *keeps* the streak, so that a scheduler which failed and then had
nothing to do still reads as unresolved; `expected` zeroes it, which is what keeps the
row out of the red and out of this table — `signatures()` gates on
`consecutiveFailures`. It also writes `expected: true` on the row, which is what
`bin/lint.js` `daemon-health` reads to leave the row alone instead of naming it "no
successful run in 24h"; the two travel together so they cannot drift apart, and every
other record — a success, a failure, an ordinary skip, a disable — clears the mark, so
a real fault is a candidate again the moment it lands. `lastError`/`lastErrorAt` stay
as history; `presentationOf` only reads them while the streak is nonzero.

Two rows use it. `discord` records it when its browser reader is unavailable — by
either route, the `ReaderUnavailable` its `poll()` swallows into the status file or a
reader subprocess that would not spawn, timed out or printed nothing usable. Nothing
downstream of a good reader envelope qualifies: a wrong guild or channel, a classifier
that refused, a decisions file that would not write, a `KEEP_DISCORD_READER_ARGS`
nobody can parse are real failures and stay red. `usage` records it when every failure
in a batch is an endpoint rate limit over a reading still younger than two hours **and**
no other account is sitting on an unresolved non-rate-limit fault — the row is
scheduler-wide, so one account's weather must not clear another account's evidence. In
that mixed case it records a plain skip instead: the streak is neither cleared nor
inflated, and the real fault still reaches three on its own retries.

One tick writes one record. A tolerated-state record followed in the same tick by a
real failure would zero the streak and then add one to it, so the failure could never
count past one however long it recurred.

`hash8` is `sha256(name + '|' + normalizedError)`. The normalizer collapses
whitespace and then replaces, in order: ISO timestamps (`<time>`), absolute paths
(`<path>`), uuids (`<id>`), hex runs of 7 or more (`<hex>`), and bare numbers
(`<n>`), lowercasing the result. That is the whole reason one recurring fault
produces one card instead of one per tick, so it is tested directly in
`bin/self-repair.test.js`.

## Thresholds and rate limits

- One open card per signature. A second is never opened while the first is open.
  The card is recorded the moment `addTask` returns, before the worktree build, so
  a daemon that dies mid-build resumes that launch on the next tick instead of
  opening another card. A launch that fails three times gives up and says so.
- At most `maxPerDay` (2) cards per local day, fleet-wide.
- After a signature resolves, `cooldownHours` (24) before it may open another.
- A signature that recurs after the cooldown opens a new card whose note links the
  previous one.
- `budgetMin` (60, capped at 90 whatever the config says) is **advisory**: the
  recipe asks the session to aim for it and to check in if the work will take
  longer. Nothing kills a repair session on a clock.

## Resolution

Each tick asks whether a signature's symptom is gone: the scheduler is back to
`consecutiveFailures === 0` with a `lastOkAt` newer than the card, the restart
loop stopped, the delivery incident cleared. Once it has stayed gone for an hour,
the card gets **one** check-in — "signature cleared at *t*; verify the fix landed,
then close" — plus `resolvedAt` and a cooldown. The first-sighting stamp is cleared
at the same time: a recurrence after the cooldown is a new fault, and has to
survive `minAgeMin` again before it opens anything.

The card's status is deliberately not changed. A cleared symptom is not a landed
fix, and only a person or the repair agent's own check-in should close the card.

## State and config

State lives in `~/keep/.keep/self-repair/state.json`, never in `health.json`,
which is rewritten whole on every `record()` and would lose it:

```json
{ "signatures": { "<sig>": { "firstSeenAt": 0, "lastSeenAt": 0, "cardId": "",
  "openedAt": 0, "sessionId": "", "pane": "", "worktree": "", "artifacts": [],
  "recipe": "", "attempts": 1, "lastAttemptAt": 0, "projectMissingAt": 0, "okSinceAt": 0,
  "resolvedAt": 0, "cooldownUntil": 0, "previousCardId": "" } },
  "day": "2026-09-15", "openedToday": 0 }
```

`sessionId` (or, if the host never registered one, `pane`, or `runId` from an entry
an older keep-tool wrote) is what marks a signature as launched. A reserved card
with none of them is a launch that did not finish, and the next tick resumes it.
A launch that threw *after* the pane came up still counts as launched: the agent is
running, and a second one on the same fault is the one thing this must not do.
`attempts` belongs to one card, so it is cleared when the signature resolves and by
`--reset`. A `runId` from the pre-session code counts as launched for 90 minutes
(the old wall-clock cap) and then stops, so a card the old code opened cannot wedge
its signature forever.

Each tick checks the recorded session against the host, matching by session id as
well as pane id so an in-place restart or an account handoff does not read as an
exit. A dead reading only starts a clock (`deadSince`); the sweep acts when a later
tick still sees it dead **10 minutes on**, and a live reading in between clears the
clock. When it does act it sets `relaunchDue` and deliberately leaves `sessionId`
in place — nulling it would disarm KEEP_REPAIR for a session that turns out to be
alive — and the relaunch overwrites it. An empty pane list, or no host at all,
counts as "could not tell" and changes nothing. The sweep only looks at signatures
that are still firing and whose card is still open; anything else belongs to the
resolve path, and it says nothing about a card it is not going to touch.

**Every attempt counts**, started or not: a launch that never got off the ground, a
pane adopted from the host, a successful relaunch. The attempt is recorded before
the launch runs, so a launch that throws cannot retry every tick. After
`MAX_LAUNCH_ATTEMPTS` (3) the card is told so once, `launchGaveUp` is set, and
nothing more happens for that signature until `--reset`.

**Except a project that is not here.** Before an attempt is spent, the tick checks
that the card's project (`~/keep-tool`, or wherever `keep project` moved the card)
is a directory on this host — the same check as lint's `missing-project` rule, and
the one `openSession` makes again before refusing with "project directory does not
exist". A missing project is an environment fault, not a launch: no agent ever
existed, and spending the three attempts on it gave up on a signature nothing had
looked at (the brief delivery card on 2026-09-17 burned all three that way). The
card is still opened, with its evidence and recipe, but no worktree or session is
made; the card is told once per outage (`Repair blocked: project … is not a
directory on this host`, with the fix: a symlink from the checkout the daemon runs
from, or `keep project <card> <path>`), `projectMissingAt` is set, and the count
stays where it was — zero for a fresh card, or whatever a card whose project vanished
under it had already spent — while `keep self-repair` shows the row as *paused …
project missing* and `--dry` as `hold`. A relaunch the liveness sweep would have
made is held the same way, and its check-in says so instead of promising a session.
The first tick that finds the directory back clears the marker, whatever else still
holds the launch, and the launch that then goes ahead is the next attempt. And before it opens anything, a launch asks the host
whether the card already has a live pane **that this scheduler spawned** — the
launch stamps `repair: true` into the pane meta, alongside `card` — so a spawn
response lost after the pane came up does not become a second agent, while a
session Owner or a reviewer opened on the same card is never mistaken for the
repair agent and adopted as one.

`--reset` refuses while the recorded session is still running — clearing the entry
would take KEEP_REPAIR away from a live agent mid-repair and let the next tick open
a second card on the same fault. The CLI asks the terminal host directly; if it
cannot be reached and the launch was never confirmed, it refuses for 90 minutes and
says to check the pane. Otherwise it refuses only while the card is genuinely live:
a card that is `done` or `archived` clears, **and so does one this scheduler has
given up on** — the give-up check-in tells Owner to run exactly this command, so the
card does not have to be closed first. A refused reset never drops the recorded
session.

`keep self-repair` marks the states that explain a quiet row: `gave up after N
sessions (--reset to start over)`, `relaunch due`, and `pane unseen since <t>`.

Every change goes through one synchronous read-modify-write helper — atomic only
because nothing inside it awaits, the same constraint as `review.js`'s
`mutateMeta`. Entries are pruned 14 days after they resolve. If the directory is
unwritable the tick logs and skips; the daemon keeps running.

Config is `~/keep/watch/self-repair.json`, with these defaults when absent:

```json
{ "enabled": true, "launch": true, "minFailures": 5, "minAgeMin": 30,
  "restartsPerHour": 3, "maxPerDay": 2, "cooldownHours": 24,
  "model": "opus", "budgetMin": 60 }
```

An unknown key is ignored with a logged warning rather than failing closed:
nothing dangerous is enabled by a key this version does not understand. `maxPerDay`
and `restartsPerHour` accept `0` (no cards at all; any restart in the last hour is
a loop); every other number must be at least 1. `launch:
false` opens cards with their evidence but creates no worktree and spends no
agent. `KEEP_SELF_REPAIR=0` disables the scheduler entirely, and
`KEEP_REPAIR_MODEL` overrides the configured model for one daemon.

## The card

Title `Daemon self-repair: <scheduler|restart loop|delivery incident>: <error>`,
project `~/keep-tool`, tags `personal` and `self-repair`, status `active`. The
note is the symptom: signature, first seen, consecutive failures, last error, last
ok. The plan is always these four steps:

1. Reproduce and root-cause from the attached health record and log excerpt
2. Fix in the worktree with a test that fails before and passes after
3. Independent review, then `keep reviewed` and `keep land` if `keep allow <card>
   land` allows; otherwise leave the card in review with the branch named
4. Confirm the row is green with `keep health`. Inspect a `wt land` skip: a checkout
   already past this land belongs to its newer landing session; recover only a safe failure
   the repair still owns, otherwise record the blocker or dependency.

Evidence is attached as artifacts under `.keep/artifacts/<card>/`: the failing
health row with the `daemon` row, the whole health snapshot, the last 80 serve.log
lines mentioning the scheduler or its error (or the last 40 if none match), and,
for a delivery incident, the inspection result, the matching journal, and the tail
of `diagnostics/events.jsonl`. The recipe is stored alongside them as `recipe.md`,
after the evidence so it can cite it, and citing it by absolute path because the
agent reads it with the worktree as its cwd. The opening message is capped at 2000
characters and the recipe is about half again that, so the session is pointed at
the file rather than told its contents. Each excerpt is scrubbed line by line, **redacted**
and clipped to 64 KB, and staged inside `.keep` so nothing on the card ever cites
`/tmp`. Redaction matters because evidence is committed and pushed with `~/keep`:
URL credentials, `Bearer`/`Basic` headers, `*_TOKEN=`/`*_SECRET=`/`*_KEY=` values,
token-shaped flags and long opaque strings are elided, in the evidence files and in
the card's title, note and recipe. Uuids and hex runs are deliberately kept — a
session id or a sha is what makes the excerpt worth reading, and neither is a
secret. The known cost: a classic 40-hex GitHub token looks exactly like a sha and
is kept too. serve.log should never carry one; if a line does, treat the token as
burned and rotate it, and file the log line that leaked it.

A check-in records the launch: session id and pane, worktree path, account purpose
and model, so Owner can see what was spent.

## The repair session

It is an **ordinary interactive session in the terminal host**, opened on the card
the same way the console's "Start work" does:

```js
openSession({ taskId, fresh: true, cwd: <worktree>, agent: 'claude',
  accountId: <repair automation account>, model, message: <pointer to recipe.md> },
  { launchEnv: { KEEP_REPAIR: '1' } })
```

It used to be a headless run (`runs.startRun`, since deleted), and that was wrong in
one specific way: a headless run terminates at the end of its turn. The first live
repair diagnosed and fixed its fault, then ended its turn saying a background poll
would fetch the review result — the poll died with the run, no `keep reviewed` record
was written, and nothing landed. An interactive session is tracked by the machinery
that already exists: card check-ins, the turn watcher, the fleet reviewer. There is no
verdict to parse and no wall-clock kill. Every other agent Keep starts, scheduled
checks included, works the same way now.

`taskId` + `fresh` + `cwd` makes `openSession` check the cwd against the card's
project, so a card can never point a `--dangerously-skip-permissions` agent
anywhere on disk. The card's project is `~/keep-tool` and the cwd is a worktree
under `~/wt/keep-tool/`; `keep.projectMatchesCwd` resolves a linked worktree to its
main checkout, so that matches. `self-repair.js` also refuses any cwd outside the
configured worktree root (`insideWorktreeRoot`, which lives here) before it calls
`openSession` at all, and says so on the
card rather than throwing inside the daemon loop.

`KEEP_REPAIR=1` marks **the launched session and nothing else**. The first launch
gets it from `deps.launchEnv`; every later one — `restartSession`,
`forceRestartSession`, the account handoff, a reopen — has only a session id, so
serve.js's `repairEnvFor` asks `self-repair.isRepairSession(id)` whether that id is
recorded in the repair state, and re-sets the marker if it is. The marker therefore
follows the recorded session id: if that record is lost — `state.json` deleted or
corrupt — the marker lapses for a session that is still running, and the guard stops
refusing it. An unreadable state file is logged for that reason rather than passed
over in silence. The repair *card* is
deliberately not the test: Owner opening his own session on one to look at the fix
would otherwise inherit a refusal on `keep restart-daemon`, which is the restart he
is there to do. `deps.launchEnv` is internal only: an `env` or `launchEnv` key in an
HTTP request body is refused with 400. The variable rides the pane's environment
through `/bin/zsh -lic` into `agent-launcher`, which strips only its own
`KEEP_LAUNCHER` marker, so the guard below sees it in the agent's own Bash calls.

The session spends against the `repair` automation purpose, which falls back
through `automationAccounts.claude` to the default, so nothing needs configuring
for it to work.

The recipe frames the card log and the artifacts as data, not instructions, and
names the constraints: work only in the worktree, never edit or commit in
`~/keep-tool`, do not restart the daemon before the land, review through
`keep codex` — **waiting
for the result in the foreground, never ending a turn with the review pending** —
record it with `keep reviewed`, land only through `keep allow` + `keep land`, and
then confirm the row went green and close the card. Inspect any skipped deployment: do not
pull or restart a checkout already past this land; recover only a safe failure the repair
still owns, otherwise record the blocker or dependency.

## What is gated, and until when

**The restart is gated on the fix being landed.** The agent can make the fix; it
cannot decide, while that fix is still sitting in its worktree, that this is a good
moment to drop every live session's daemon — and a restart mid-repair destroys the
running state that produced the evidence. So `keep hook pre-bash` refuses, for any
command in a session with `KEEP_REPAIR=1`:

- `keep restart-daemon`, `keep service`, `launchctl` — including the node-wrapper
  and shebang spellings (`node ~/keep-tool/bin/keep.js restart-daemon`), starting a
  second daemon with `bin/serve.js`, and `curl`/`wget`/`fetch` at
  `/api/restart-daemon` (grepping the endpoint out of the source is still fine)
- git in the main `~/keep-tool` checkout **or anything under it**, targeted with
  `-C`/`--git-dir`/`--work-tree` or reached by `cd`, spelled `~`, `$HOME` or
  absolute, unless the subcommand is
  `log`, `status`, `diff`, `show` or `rev-parse` — the diagnosing agent has every
  reason to read the live checkout and none to write to it
- `git push --force`, `--force-with-lease`, a `+refspec`, and `wt land` — landing
  goes through `keep land`, which enforces the review record

The refusal names the rule and points at step 4 of the repair card. The guard is
keyed to `KEEP_REPAIR=1`, which every launch of a session the repair state records
as its agent sets, so no other session on the card sees it and no restart clears it.

The guard is a `keep hook pre-bash` hook, so it only exists where that hook is
installed: a repair session running in a managed automation account whose
`settings.json` has no Keep hooks is unguarded, restart refusal and raw-resume
refusal both. `keep setup hooks` installs them in every managed Claude account, and
`keep doctor` names any account still missing them.

**Once the card's fix is on `origin/master`, exactly two commands come back:**

```sh
git -C ~/keep-tool pull --ff-only     # or: pull --ff-only origin master
keep restart-daemon                   # and the node/shebang spelling of it
```

The guard's eligibility is only the landed fix. `wt land` normally deploys it; these
commands are for a skipped or failed deployment. A documentation or CLI-only change may
need only the fast-forward, while a daemon-code change needs the restart too.

Each as a **whole command**, matched against the text, not against a parse of it.
Everything else in this guard reads a command line without being a shell, which is
the right trade for a refusal — a spelling it reads differently from zsh is at
worst an over-refusal — but an allowance cannot be built on it: `node -r /tmp/keep.js
~/keep-tool/bin/keep.js restart-daemon`, `bash --rcfile /tmp/x -ic '<command>'` and
an `export GIT_CONFIG_*` in an earlier segment all parse one way here and run
another way there. So the recipe's exact text is what is recognised, and a `cd`,
an `&&`, a wrapper, an assignment or an extra flag means no match.

The predicate is `landedFor(cardId)` in `bin/self-repair.js`, asked at most once
per Bash command and only when something is about to be refused. It resolves the
session to its card with `cardForSession(sessionId)` — the repair state entry whose
`sessionId` matches, which is the same match that armed `KEEP_REPAIR=1` — and then
asks whether that card's fix has landed.

`keep land` writes no record of its own: `.keep/reviews/<card>.json` holds
`keep reviewed` records, which say a patch was reviewed, not that one was pushed.
What `keep land` leaves is a check-in on the card — `Landed <branch> onto <default>`
with the pushed sha in that entry's `commits:` field — and that entry is the land
record. Four things have to line up, because the session being gated writes its own
check-ins and a line of prose is not evidence:

1. the entry matches that whole line, not looser prose about landing something
2. the card carries a clean `keep reviewed` record — a repair card holds no
   `--allow` grants, so its land can only have gone the reviewed-patch way
3. the cited sha is an ancestor of `origin/<default>` in the live checkout
4. that commit's `git patch-id --stable` is one the review record covers — the
   rebase `wt land` does before it pushes changes the sha and not the patch, which
   is the reason `keep reviewed` records patch-ids in the first place

The cost of 2 and 4 is one case this does not recognise: a land Owner authorized
with an explicit `--allow land` grant instead of a reviewed patch. Owner is by
definition present for that one, and the restart falls back to being his.

It never fetches: this runs in front of every
Bash call the session makes, so a network round trip would stall the whole repair,
and the refs are already fresh — the landed sweep and the `git-pull` scheduler keep
`origin/master` current, and `keep land` pushed seconds earlier.

When it says yes, the command runs and one line goes to stderr:

```
keep: repair session may restart: <card>'s fix <sha7> is on origin/master
```

Everything else stays refused, before and after the land: `keep service`,
`launchctl`, `bin/serve.js`, the `/api/restart-daemon` fetch, a bare `git pull`
without `--ff-only`, and `git -C ~/keep-tool merge`/`reset`/`checkout` or any other
write in the live checkout. Nothing may ride along with the two either — an
environment assignment (`GIT_CONFIG_*` can move the remote or point `core.hooksPath`
at a script), a node flag (`-r`, `--eval`), a wrapper such as `env -C`, a second
`-C`, or `--git-dir`/`--work-tree`, which pair another repository with the live
working tree — none of which can be attached to a whole-command match anyway. A session whose card cannot be resolved, whose card has
no land check-in, or whose predicate throws is refused exactly as it was before.

**The card is not closed automatically**, the fix is not landed without a recorded
review, and `--allow` grants cannot be set from an agent session, so the repair
card carries none.

## Seeing it

```sh
keep self-repair                          # open signatures, their cards, cooldowns, today's count
keep self-repair --dry                    # what the next tick would open (or hold, on a missing project), and why; writes nothing
keep self-repair --json
keep self-repair --reset <signature>      # clear one signature's cooldown and resolution
                                          #   (refused while its card is still open)
keep self-repair --disable | --enable
```

`keep lint`'s `daemon-health` finding ends with `repair card: <id>` when an open
self-repair card covers a failing row, and the morning brief's daemon line ends
with `Self-repair: <n> open (<ids>)`.
