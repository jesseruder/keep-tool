# keep

A work registry: mission control for tasks, experiments, and Claude Code/Codex sessions.
One markdown file per task in `tasks/` — YAML frontmatter is machine state, the body
is an append-only log (newest first). Registry mutations create local Git commits;
remote sync is optional and belongs on a private registry remote.


## Layout

Application paths (`bin/` and `skills/`) live in the source checkout. Task and runtime
paths live in your separate data directory (`~/keep` by default). Never commit
registry data or credentials to the public source repository.

- `bin/keep` — the CLI (sh launcher + `keep.js`, runs on Node; symlinked from `~/bin/keep`)
- `bin/keep-core.js` — the shared layer under the CLI: registry paths, card IO, the lock, session links, plans, and the mutators every command group uses
- `bin/commands/` — one module per command group (`hook`, `step`, `turns`, `watcher`, `host`, `review`), each exporting its own slice of the command table
- `bin/features.js` — the optional-feature registry: descriptions, the configuration switches, and the empty dashboard state an off feature reports
- `bin/serve/` — the daemon's request ladder (`routes.js`) and periodic jobs (`schedulers.js`), both driven from a `ctx` object `serve.js` assembles
- `tasks/` — live tasks, one `.md` per task
- `archive/` — done tasks, swept here occasionally
- `digests/` — generated digests (Phase 2)
- `skills/` — canonical shared agent skills, symlinked into each agent's user skill directory
- `skills/packs.json` — the named skill packs (`core`, `handoff`) `keep setup skills` installs
- `reviews/` — fleet-reviewer findings, one file per day
- `bin/alerts.js` — alert routing, rate policy, channel adapters, and brief composition
- `bin/devices.js` — the phones registered for Expo push, and the `/api/devices` registry
- `bin/attention-push.js` — the console's waiting-session notification rule, run daemon-side for the phone
- `bin/unblock.js` — cross-card dependency resolution and linked-session delivery
- `bin/slack.js` — read-only Slack polling, fleet correlation, cards, and alerts
- `bin/incidents.js` — deterministic alert parsing for the bots in `alertBots`, and the incident card per signature
- `bin/agents.js` — agent records, their event feeds, and the Agents rows `/api/state` publishes
- `bin/area-session.js` — the standing incident-responder session per watched area: launch, one delivery per poll, restart-from-log
- `bin/standup.js` — weekday standup evidence, generation, and scheduling
- `bin/ideas.js` — daily fleet-wide Fable ideas evidence, generation, and scheduling
- `bin/landed.js` — default-branch commit detection, card annotation, and scheduling
- `bin/lint.js` — deterministic card hygiene checks and their cached result
- `bin/turn-index.js` — SQLite index of agent turns, its incremental ingest, and its queries
- `bin/turn-watcher.js` — shadow judgment of ended turns: what Owner would have typed next
- `.keep/` — machine state (lock, markers, reviewer state), gitignored
- `.keep/devices.json` — registered phones and their Expo push tokens (0600, local only)
- `.keep/push-tickets.json` — accepted Expo pushes awaiting a receipt (0600, 24 hours)
- `.keep/attention-push.json` — the waiting-session pushes' dedupe window and daily count (0600)
- `.keep/turns.sqlite` — the turn index; a derived cache, safe to delete and rebuild
- `.keep/artifacts/` — committed per-card durable artifacts, force-added like `.keep/handoffs/`
- `.keep/holds/` — quiet-window ledgers, one JSON file per hold
- `.keep/incidents/` — incident signatures and the title index (`state.json`) plus the raw event feed (`events.jsonl`)
- `.keep/agents/<name>/` — one agent's record (`record.json`), event feed (`events.jsonl`) and standing notes (`notes.md`), force-added like `.keep/artifacts/`
- `agents/<name>.md` — committed agent recipes; the tick installs `docs/agents/<name>.md` here when one is missing and never overwrites it
- `resources/` — committed shared-resource declarations, one JSON file per project basename
- `.keep/notes/` — state notes, one JSON file per project (bounded; pruned on every write)
- `.keep/unblocked/` — pending and delivered cross-card unblock records
- `steps/` — committed gated-step registries, one JSON file per project basename
- `.keep/steps/` — local step run ledgers and logs (gitignored)

## Features

Four things the daemon and the CLI do are optional, and an install that does not
want one should not run it at all. The configuration file's `features` key is an
object of booleans:

```json
{ "version": 1, "features": { "standup": false, "ideas": true, "slack": false, "discord": false } }
```

| feature | what it is |
| --- | --- |
| `standup` | weekday standup note generated from card activity |
| `ideas` | daily fleet-wide workflow-improvement pass |
| `slack` | read-only Slack polling correlated with cards |
| `discord` | Discord rendered-message polling |

Absent means on. A configuration written before this key existed — every existing
install — keeps all four, so nothing changes under an upgrade. Only an explicit
`false` switches one off. `keep init` writes the block above into a *new*
configuration, because a fresh install has no Slack workspace, no Discord tab and
no standup history to summarize.

Off means three things: the daemon starts no scheduler for it, its dashboard state
degrades to the value the module reports when it has nothing (`standup` is absent,
`slack` and `discord` are an unpolled watcher) so the console's response shape is
unchanged, and its command refuses:

```
$ keep standup
keep: feature standup is off; enable it with "features": {"standup": true} in ~/.config/keep/config.json
```

The command stays registered so that message is what you get, rather than `unknown
command`. Off does not unload the module: `landed`, `review` and the reviewer may
still call into `slack.js` as a library. `landed` itself is not switchable —
review, lint and self-repair read what it records.

`keep doctor` prints the current switches on one line
(`features: standup off, ideas on, slack off, discord off`), and `config.apply()`
projects the key into `KEEP_FEATURES` the same way it projects `scopes` into
`KEEP_SCOPES`, so a child process reads the same answer as its parent.

An unavailable Discord **reader** does not make the `discord` row in `keep health` read
as failing. The reader drives a logged-in browser tab, so it is unavailable for reasons
no daemon fix addresses — a closed tab, a restarting browser, a binary that is not
there — and that is treated as a state the scheduler tolerates: the row records a skip
detailed `reader unavailable: <message>`, marked `expected`, which clears the failure
streak and keeps `bin/lint.js` `daemon-health` from calling it late. One
`keep discord: reader unavailable: <message>` line goes to stderr on entering that
state, not one per tick. Both routes into it are covered: the `browser_reader_unavailable`
envelope `poll()` swallows into its status file, and a reader subprocess that would not
spawn, timed out after 30s, exited nonzero or printed something that is not the
envelope.

Only the reader qualifies. Everything downstream of a good envelope — a wrong guild or
channel, a classifier that refused, a decisions file that would not write, a
`KEEP_DISCORD_READER_ARGS` nobody can parse — is a real failure, records `ok: false` with
its own error, logs the ordinary `keep discord: <message>` line, and goes red on the
third one as it always did. A poll that classifies messages records a real success. One
tick writes one health record, so a broken console notification counts as this tick's
failure rather than clearing the streak first. `keep discord status` is unchanged: it
reads the watcher's own status file, not health.


## Console access

The console at `/app` is authorized three ways: a loopback peer with a loopback
`Host`, an `x-keep-token` header, or a browser session. Sessions are for a shell
that can set headers only on its top-level navigation — the Android WebView
shell, whose page scripts, fetches, EventSource and WebSocket cannot. It opens
`http://<mac>:7777/app?token=<token>` once; a matching token answers `302 /app`
with `Set-Cookie: keep-session=<32 random bytes, base64url>; Max-Age=400d;
Path=/; HttpOnly; SameSite=Strict` and `cache-control: no-store`, and the token
never appears in a body or a log. A wrong token gets the ordinary `403`.

The cookie is an opaque id, never the token itself: cookies are not isolated by
port, so a token cookie would reach every other service on the Mac and could be
replayed as `x-keep-token`. The frontend worker holds at most 32 sessions in
memory (oldest evicted, and any unused for 24 hours swept), each valid only for
the `Host` it was issued for, and forgets them all when it restarts — the app
re-runs its bootstrap. Because a cookie is not port-scoped, `/app?token=` is the
phone shell's bootstrap and should not be opened in a general-purpose browser on
a host that also serves untrusted services; `docs/ui-reliability.md` has the
detail. For the same
reason a session must carry `x-keep: 1` on everything except `GET` of `/app`,
`/app/*`, `/vendor/*`, `/api/events` and the pane socket upgrade: a page on
another port of this host is same-site, and that header is what it cannot add
without a CORS preflight nothing here answers. Loopback and header-token clients
are unaffected. The worker strips `Cookie` before the Unix hop to the daemon.

A pane socket (`/ws/pane/<id>`) additionally needs either an `Origin` whose host
equals the request's `Host`, or no `Origin` and a valid `x-keep-token` (a native
client). See `docs/ui-reliability.md` for the reasoning.

The console detects the mobile shell as `window.keepShell`
(`{ platform, version, post(message) }`, injected before page scripts) and sets
`<html class="mobile">`. Console → shell messages, all through `post()`:
`{type:'ready'}` once the console has subscribed, `{type:'badge', count}`,
`{type:'notify', title, body, key}`, `{type:'openTerminal', pane, session,
title}` from the terminal handoff panel the console shows instead of mounting
xterm, `{type:'unauthorized'}` (at most once per 10s) when a request comes back
`403`, which is how the app learns its session is gone and re-bootstraps through
`/app?token=`, and `{type:'authenticated'}` once per page load when `/api/state`
first answers `200` — the app bounds its bootstrap loop on that rather than on
`ready`, which says only that the console asked. Shell → console: the app calls
`window.keepShellReceive(message)` — defined unconditionally, since Android's
pre-load injection is best-effort — with `{type:'hello'}` when it defines
`window.keepShell` after the page has already run (the console then sets the
`mobile` class and re-posts `ready` and the last badge), `{type:'notificationClick',
key}`, which lands in the same handler the desktop shell's notification clicks
use, or `{type:'reload'}`. On the mobile shell the app owns notification
permission (always `granted`), the launcher badge, and waiting sounds.

`<html class="mobile">` is also the whole phone layout, which is the desktop
console laid out for 412 px — one markup tree, not a second UI. `web/app/mobile.js`
turns it on when the shell is present, or when `?mobile=1` asks for it — never
from a media query, because it moves DOM and rewrites stored state and a desktop
window dragged narrow must do neither; the `max-width: 480px` rules stay pure
CSS. It does only what CSS cannot: it borrows `#rail` into a
filter sheet and `#meters`/`#health` into a status sheet behind the connection
dot, appends an Alerts tab to the mode switch (which `styles.css` fixes to the
bottom of the screen, with Watch hidden), and toggles `mobile-stage-open` so a
selected queue row pushes the stage over the queue. Each sheet, the stage and the
alerts inbox push one `history.pushState({keepOverlay})` entry, so Android's back button — which the
shell routes through WebView history — unwinds them one at a time. The entry at
depth k names the k-th overlay, so arriving on a `keepOverlay` entry whose
overlay is closed (a Forward, or a leftover from a shell that went away) reopens
it, or goes straight back again: the history never holds an overlay entry with
no overlay behind it. The phone
stage carries a one-line reply composer (`.mobile-reply`), because free text on
the desktop is typed into xterm and the phone hands the terminal to the app;
Fleet rows carry a `Terminal` button that posts the same `openTerminal`. On a
desktop the module builds nothing at all.

## CLI

```
keep add "title" [--kind task|experiment|idea|chore|bug] [--file|--claim] [--tag t]… [--project p]
                 [--plan "step"…] [--check-after when] [--check "recipe"] [--on-pass done|rearm|review]
                 [--check-every +7d] [--probe "cmd"] [--status s] [-m note]
keep checkin <id> -m "state + next step" [--next "text"] [--commit <sha>]... [--step <n|next>] [--status s] [--check-after when] [--check "recipe"] [--on-pass done|rearm|review] [--check-every +7d] [--probe "cmd"] [--clear-check-after] [--handoff waiting|needs-input]
keep probe <id>
keep plan <id> [--set "step"… | --add "text" | --insert <n> "text" | --remove <n>
                | --done <n> | --start <n> | --undo <n>]
keep list [--status s]… [--tag t] [--project p] [--overdue] [--brief] [--all]
keep show <id>
keep artifact <card> [--] [<file>...] [-m "note"]
keep claim <card>
keep link <card> --session <sid> --agent claude|codex
keep wait-on <card> <upstream>[#<step>] [<upstream>...] -m "why"
keep deps [<card>]
keep done <id> [-m note] [--next "text"] [--commit <sha>]...
keep allow <id> [<action> [--amount n]] [--quiet] [--json]
keep allow <id> --grant a,b [--until when] | --revoke a,b | --clear [--as-owner]
keep reviewed <card> --commit <sha|range>... --verdict clean|findings [--by who] [--job id] [--evidence "..."] [--fallback] [-m "..."]
keep reviews <card> [--json]
keep reviewing <card> --job <id> --commit <sha|range>... [--account <codex-id>] [--by who] [-m "..."]
keep reviewing <card> [--drop <obligation-id> -m "why"] [--json]
keep review-route [--json] | --exhausted <codex-id> --until <when> [-m "..."] | --clear <codex-id>
keep land <card> [--dry-run] [--json]
keep tag <id> +a -b
keep tags
keep overdue [--brief]
keep who <project> [--json] [--scope <resource>]
keep hold <project> --for +15m -m "why" [--task <id>] [--scope <resource>]...
keep release <hold-id>
keep holds
keep resources <project> [--json]
keep resources <project> --add <name> [--title t] [--command <re>]... [--path <glob>]... [--deploy <kind:target>]... [--note-for +2h]
keep resources <project> --remove <name>
keep resources --check <project> "<command>"
keep note <project> --scope <resource> [--scope ...] -m "what is true now" --for +2h [--task <card>]
keep note --extend <id> --for +2h | --clear <id> [-m why]
keep notes [<project>] [--all] [--json]
keep steps [<project>] [--json]
keep step claim <project> <step> [--task <id>] [--for <dur>] [--wait] [--force] -m "why"
keep step run <project> <step> [--sha <sha>]
keep step done <project> <step> [--artifact <id>] [--sha <sha>] [--force] [-m note]
keep step fail <project> <step> [--force] -m "why"
keep step notify <project> <step>
keep alert -m "text" --level attention|urgent [--key k] [--card id] [--from name] [--dry]
keep quiet <duration>|off
keep alerts [--all]
keep lint [--json] [--rule <name>] [--fix-hints]
keep self-repair [--dry] [--json] [--reset <signature>] [--disable|--enable]  # what the daemon has opened on itself
keep brief [--send]
keep codex-jobs [--json] [--reap] [--dry]  # list companion jobs/brokers; optionally reap stale jobs, orphan pollers, and abandoned or idle brokers
keep leftovers [--json] [--reap] [--dry]  # list (or stop) dev servers, watchers and test runners a session left running after its pane went away
keep standup [--since "YYYY-MM-DD HH:MM"|ISO] [--dry] [--show]
keep ideas [--dry] [--model <m>]
keep landed [--dry] [--only <id>]
keep landed policy narrow|broad
keep landed dry on|off
keep landed decisions [--disagree]
keep slack poll [--dry]
keep slack status
keep slack mode log|cards|alerts
keep incidents [--json]
keep incidents parse <file|-> [--json]
keep incidents close <card-id|signature> -m "why"  # close one that will never resolve itself
keep incidents session <area> [--dry] [--json]   # one area-session tick by hand
keep agents [--json]   # agent records: lifecycle, current session, unseen events
keep agents events <name> [--unseen] [--limit N] [--json]
keep agents emit <name> --kind <k> [--card <id>] [--severity low|med|high] [--needs-you] -m "text"
keep agents seen <name>
keep verify <id>       # run a check recipe now, in its thread or a fresh session (needs keep serve)
                       # Owner-initiated: never refused by, and never counted against,
                       # the scheduler's one-open-per-card-per-day allowance
keep compact <sid>     # compact a live Claude or Codex session (needs keep serve)
keep compact [<sid> --when-idle] [-m "reason"]
                       # bare, from inside a session: ask the daemon to compact this
                       # session at its next idle moment (see Auto-compact below)
keep resume [--raw]    # post-restart: active tasks + keep open commands (--raw prints the bare CLI form)
keep setup hooks [--account <id>]  # install the Keep hooks in every managed Claude account
                       # (without --account it installs the core and recorded skill packs too)
keep setup skills [--pack <name>]… [--replace] [--list]
                       # link skill packs into ~/.claude/skills and ~/.agents/skills
keep setup --shell [--write]   # the zsh claude() that routes resumes through keep open
keep sync              # pull --rebase + push
keep hook session-start  # used by the Claude Code SessionStart hook
keep hook prompt         # used by the Claude Code UserPromptSubmit hook (compaction hint)

keep turns show <session-id|card-id> [--last N] [--json]     # indexed turns for a session or card
keep turns search "<query>" [--since when] [--project p] [--agent claude|codex] [--limit n] [--json]
keep turns stats [--since when] [--json]                     # turns, human/[keep] openers, bare nudges
keep turns ingest <file> [--agent claude|codex] [--force]    # index one transcript now
keep turns backfill [--since when] [--roots dir,dir] [--json] # walk every transcript root (default 14 days)
keep turns prune [--older-than when] [--dry] [--json]        # drop indexed sessions idle > 120 days

keep watcher run <session-id|card-id> [--turn n] [--dry] [--json]   # what would Owner type next? recorded, never sent
keep watcher ls [--since when] [--verdict v] [--limit n] [--json]   # verdicts, confidence, state lines
keep watcher replay [--since when] [--limit n] [--agent a] [--json] # score verdicts against what Owner actually typed
keep watcher stats [--since when] [--json]                          # verdict counts and shadow agreement rate
keep watcher live [on|off|<type,type>] [--force] [--json]           # which verdict types are delivered for real

keep review-queue [--limit n] [--min-score n] [--json]   # what deserves review now
keep review-bundle <id> [--budget n] [--raw]             # evidence delta since last review
keep review-note <id> --kind k --subject s -m "finding"  # attributed reviewer finding
keep review-idea "<title>" -m "<body>" [--cards a,b,c]   # fleet-wide workflow suggestion
keep review-ack <id> [-m note]                           # reviewed, nothing to flag
keep review-dismiss <id> <key> [-m why]                  # never raise this one again
keep review-budget [--json] [--model m] [--account claude-id]
                                                            # active reviewer account budget, or an explicit Claude account
keep review-tick [--force]                               # wake the reviewer (needs keep serve)
keep review-stats [--json]                               # last tick, skips, per-day counts
keep nudge <id> --session <sid> --key <k> -m "..." [--send]  # message a live agent (dry-run default)
keep tell <card|session-id|#n> -m "..." | --message-file <path> [--wait <dur>] [--dry] [--json]
                       # one session addressing another (needs keep serve)
keep move <#n|session-id> --node <name> [--force] [--dry] [--json]
keep move --recover <tx> | --abandon <tx>
                       # a Claude session to another node (needs keep serve; see "Moving a session to another node")
```

`keep claim <card>` assigns the current Claude or Codex session to an existing card.
Run it from the card's project when starting or resuming that work. Routine card
mutations preserve all existing session links and attribute their log entries to the
contributing session as `(by <agent> <full-session-id>)`; they do not claim unowned
work or move a session from its card. The reviewer uses that attribution for at most
30 minutes of transcript context preceding the entry. Later unrelated activity from
the contributor does not requeue the card.

`keep delegate <card> --step <n> -- <command...>` records an explicit worker
assignment and launches the command with its delegation id. The record lives only in
`.keep/delegations/`; it does not alter the card's owner, status, schedule, plan, or
permissions. SessionStart binds the id to the native child session from the hook input.
For launchers that cannot preserve environment variables, use `--prepare` and have the
worker run the printed `keep delegate --accept <id>` command first. A parent that already
knows the native worker id can use `--session <id> --agent claude|codex` instead.

Every record includes the parent session and an exact snapshot of the assigned plan
position, text, acceptance criterion, and fingerprint. Keep never infers delegation from
a title, current step, project, or inherited parent session id. If that position is
changed, reordered, removed, completed, or its card closes, startup and Stop report a
stale assignment and tell the worker to request reassignment. A SessionEnd tombstone is
reactivated when the same native session resumes; `keep delegate --end` is explicit and
never reactivates. An ordinary `keep add` is refused while an assignment is active or
stale, with parent context, while `--file` and default-filed ideas remain available.
A successful explicit `keep claim` ends the delegation after the claim succeeds; a
failed claim leaves it intact. Delegated workers do not auto-run parent plan steps or
consume permissions granted on the parent card. The parent records progress in Keep.

An ordinary `keep add` keeps its historical behavior and claims the new task for the
creating session. `--file` records follow-up work without moving that session. Ideas
are filed by default; pass `--claim` when starting an idea immediately. The two flags
are mutually exclusive. Filing preserves creator attribution, and a filed card with
`--check-after` still records the creating session as its scheduler. Internal callers
that pass `linkSession:false` suppress ownership, attribution, and scheduling identity.

Bare `keep needs` is a read-only list. An env-backed need auto-clears only when the
session-start hook supplies a valid session ID and that session is still linked to the
card; an env variable in an unrelated session or ordinary shell does not clear it.
`keep needs <card> --met` remains the explicit manual path.

`keep link` repairs a session's ownership metadata when work was recorded from a
different project directory. It transfers that explicit session from its old card to
the named card and does not launch, wake, or message the session. The target card's
status, schedule, activity timestamp, and body are preserved.

`keep setup hooks` merges Keep's six hook commands — `session-start`,
`session-end`, `stop`, `notification`, `pre-bash`, `post-bash` — into
`~/.claude/settings.json` and into the `settings.json` of every managed Claude
account from the accounts configuration, printing one line per account. Every
account's settings file is parsed before any of them is written, so an unreadable one
names its account and stops the run rather than leaving the fan-out half done. A
Keep hook command for the same action under a different spelling — an older checkout
path, a moved `KEEP_CONFIG` — is rewritten in place rather than left beside the new
one. A managed account whose settings file is a symlink to the source already carries
the hooks and is left byte-for-byte alone; a file it does change is backed up first.
`--account <id>` limits the run to one account and skips the shared skill links; it
accepts any Claude account id, including one whose config directory is the default
`~/.claude`. Without `--account` it also installs the `core` skill pack and every pack
recorded in the configuration's `skillPacks`, so an upgrade keeps the skills the last
`keep setup skills` chose. Codex accounts keep
their own version-dependent adapters and are never touched. `keep doctor` reports
the hooks each account is missing, with `keep setup hooks` as the fix: an account
without them has no restart guard and no raw-resume guard. For the same reason, an
account handoff refuses a target missing a hook the source has ("target account is
missing Keep hooks: …") even though hooks stay out of the portable settings digest.

`keep setup skills` links skill packs from `skills/packs.json` into
`~/.claude/skills/<skill>` and `~/.agents/skills/<skill>`. It always installs `core`,
plus every pack recorded in the configuration's `skillPacks` and every `--pack <name>`
given now; an unknown name is refused with the list of known packs. Newly named packs
are recorded in the configuration, so a later `keep setup hooks` reinstalls them (an
isolated `KEEP_DIR` run with no configuration file installs but says it recorded
nothing). The configuration is checked before anything is linked when `--pack` names a
pack — unreadable or read-only, and the run refuses with `keep setup skills changed
nothing: …` rather than installing packs it cannot remember — and the recorded list is
written by renaming a file written beside it, keeping the configuration's existing
permissions. Every destination for every pack is preflighted before anything is
written. A missing destination is linked; one that already resolves to this checkout is
left alone; a symlink that dangles, or that resolves into another keep-tool checkout (a
`package.json` naming this application two directories above the target), is repaired
in place — an older checkout path, a deleted worktree. Any other link or directory of
its own is moved to `<home>/skill-backups/<skill>.keep-backup-<timestamp>` — beside the
skills directory, never inside it, where an agent would load the backup as a second
copy of the skill — and linked when its `SKILL.md` is byte-identical to this
checkout's; otherwise the run refuses, names the path, and asks
for `--replace`, which backs it up and links: a live link into someone else's skill
collection is never replaced silently. A parent such as `~/.agents/skills` that is
itself a symlink is never modified, and when it names the same directory as
`~/.claude/skills` — whether or not that directory exists yet — the two homes are one
destination. `--list` prints each pack, its description, its skills' status (`linked`,
`missing`, `stale link`, `needs migration`) and whether it is recorded, and writes
nothing. `keep doctor` checks one line per pack, requiring every skill in both homes:
`core` and the recorded packs are required with `keep setup skills` as the fix, and the
rest print as `optional` with `keep setup skills --pack <name>`.

It then prints one line per nondefault account, reporting whether that profile’s
shared setup is in sync with its source, behind it, conflicted, or not shared at all,
with the `keep accounts setup <id> --share-from <source>` that repairs it; the check is
read-only. It compares config values and shared file links; plugin cache
differences are not reported and are refreshed at the next launch of that account.

Claude subagent lifecycle tracking uses `keep hook lifecycle` for both
`SubagentStart` and `SubagentStop` in Claude's user settings. These observation-only
hooks write bounded, content-free records under `.keep/lifecycle/<session-id>`;
they never block a turn or inject a message. The dashboard reconciles child
transcripts when completion hooks are missing and falls back to existing transcript
tracking for sessions that have not loaded the hooks. Existing Claude sessions may
need to restart/resume before newly configured hooks take effect.

An agent that needs the owner ends its turn with the question: the console shows every
pane's final turn in Waiting on you, and a reply typed there is the answer. Something
only the owner can supply, and that must outlive the session, is a `keep needs` block.

`when`: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `+15m`, `+3d`, `+12h`, `+2w`, `tomorrow`.

Statuses: `inbox → active → waiting/blocked → review/landing → done`. `waiting` requires
`check_after` or an unresolved `depends_on` entry; `review` means the ball is in the owner's
court with an artifact to look at.
Experiments (`kind: experiment`) must have a `check_after` and a `check` recipe
an agent can execute cold, or a `probe` — a shell command whose exit code decides it.

Scheduled recipes are polled every minute. `--check-after` plus a recipe records a
turn-scoped waiting handoff; add `--handoff needs-input` when scheduling and also
asking for a decision. A later turn invalidates that handoff. Card state is separate
from conversation readiness: a live session that has proposed a next step belongs in
Waiting on you even without a question. See the shared [Keep skill](../skills/keep/SKILL.md)
and [status model](session-reliability.md). `keep help` is the complete command
reference; this list is a quick overview.

Testing: `npm run test:scenarios` replays deterministic session transitions for both
agents; `npm run test:scenarios:browser` checks the isolated desktop-web UI.
See [scenario testing](session-scenarios.md) for seeds and failure replay.

`keep lint` runs advisory daily hygiene checks including `malformed-card`, scope tags,
review next steps, waiting triggers, uncited commits, stale active work, old done cards,
duplicate titles, `tmp-artifact` citations, `missing-project` (an open card whose project
is empty or does not resolve to a directory), `landing-uncited` (status `landing` with no
cited sha), `blocked-no-need` (status `blocked` with neither an open need nor a
dependency), `daemon-health` (one finding for every scheduler in `.keep/health.json` with
3+ consecutive failures whose fault still stands (the latest attempt failed or the
last failure is recent; see Health states), no successful run in 24h, or a streak on a
row that has never succeeded whose last failure is over 24h old, skipping on-demand rows and any row
whose latest record is a state its scheduler tolerates — see [self-repair](self-repair.md)),
`checkout-drift` (per project of an
open card: a dirty tree or a branch ahead of/behind its upstream, from local refs with no
fetch), `worktree-uncarded` (a worktree of any card project on a branch whose commits,
cherry-picked or squash-merged work excluded, are not on the local `origin/<default>`,
whose newest commit is over a day old, and which no card names by branch (only one that
could not be an ordinary word), worktree path or a cited commit; reviewer-idea cards do
not count, filed under `worktree:<path>`; review bundles list the
same worktrees under `## git`), `step-run-pending` (a gated step with landed commits its last run missed for over
24h), `note-expired` (a state note past its window that nobody extended or cleared,
filed under `note:<id>`), `resource-bad-matcher` (a declared resource whose regex does
not compile or whose glob is empty, filed under `resource:<project>:<name>`),
`experiment-undecided` (a `kind: experiment` card in `review` carrying a
`check result (agent)` readout nobody answered — the rule takes the oldest readout newer
than the newest decision, so a repeating check does not reset the clock, and fires when
that readout is at least `KEEP_LINT_EXPERIMENT_DECISION_DAYS` old; the default is 14, and
an unset, zero or unparseable value keeps it. A decision is a `check-in`, `done`,
`answer`, `plan`, `allow` or `needs …` entry from anyone, the reviewer included;
everything else in the log is machinery. The rule asks the question and never closes or
changes the card, because the keep-or-revert call is Owner's), and
`handoff-shadow` cards — a Codex worker's
card older than six hours with no check-ins, opened instead of checking in on the card
its parent Claude session held. It always exits successfully when findings exist, writes the latest
result to `.keep/lint.json`, and supports one-rule runs plus JSON output and fix hints.
The daemon refreshes that file every `KEEP_LINT_EVERY_MIN` (default 30) minutes by
spawning `keep lint --json` as a child process with a 90s timeout — never on its own
loop, because `checkout-drift` shells out to git per project — and records the outcome
as the `lint` scheduler in `keep health`. A review tick refreshes it once more before
waking the reviewer when it is older than that interval: the bundle splices the snapshot
in and `review-land` judges against the same file, so a stale one makes both inert.
The brief refreshes findings older than 20 hours and shows the first five.
The `unsatisfiable-wait` rule flags unresolved waits whose upstream has no live linked
session, scheduled check recipe, or log activity in 24 hours. It also flags whole-card or step waits whose reason or recent downstream check-ins
cite a commit already on the upstream's origin default branch. Hints identify the
narrower wait to use while preserving existing fact targets. Stale or missing daemon session evidence does not prove that
a linked session is gone. Reviewer bundle headers include bounded, card-specific cached
lint findings as advisory evidence — up to ten rows, each naming its rule. Lint owns
those classes outright: `review-land` refuses a note whose kind is
`wrong-status`, `stale-checkin`, `daemon-health`, `env-hygiene`, `deploy-provenance` or
`step-pending` (or `other` with a `:no-project` / `:closing-checkin` subject, a bare sha,
a `/tmp` path, or a subject naming all three of an experiment, its readout and the
decision that never came) when a lint finding from a rule
that covers it is already on record —
matched on the same card, or fleet-wide for the rules that answer for the registry
(`daemon-health`, `checkout-drift`, `step-run-pending`, which file under `daemon:<name>`,
`repo:<project>` and `step:<project>:<step>`). Nothing is refused on a `.keep/lint.json`
older than an hour, or on a card whose newest check-in is newer than the snapshot: lint
has not seen what the reviewer is describing, so its silence proves nothing. When the
snapshot is too old to refuse against, the bundle's `KEEP_LINT_FINDINGS` header says so
rather than claiming a refusal that will not happen. The refusal
names the rule and is per item: the rest of the tick still lands.
`missing-project`, `landing-uncited` and `blocked-no-need` are capped at five findings
each and `experiment-undecided` at eight, so no one rule fills the report. The
60-finding total is then filled fair-share rather than by prefix — every rule's first
finding, then every rule's second, and so on — because the rows are ordered by severity
and then rule name, and taking a prefix would evict the alphabetically-last rules
outright. `byRule` still counts what each rule found before either cap.

`keep turns` reads the turn index, a SQLite summary of Claude Code and Codex CLI
transcripts kept in `.keep/turns.sqlite`. Stop hooks and the daemon feed it
incrementally (byte offsets, so the cost is the delta, not the transcript);
`keep turns backfill` seeds it from history. `show` accepts a session id or a
card id, `search` is FTS5 over indexed messages, and `stats` reports turns,
human and `[keep]` openers, and bare nudge openers per agent and session kind.
`--since` reads backwards here: `+7d` means the last seven days. Hooks index at
most 512 KiB per turn and wait at most 250 ms for the write lock, so a backlog is
left to the daemon rather than made an agent's problem. Indexed sessions idle for
more than 120 days are pruned by the daemon once a day, or by `keep turns prune`.
The database is a derived cache and can be deleted at any time.
See [turn index](turn-index.md).

The console reads two endpoints for shadow decisions:
`GET /api/decisions?session=<id>&pending=1` lists a session's unjudged shadow
decisions (`id`, `type`, `message`, `createdAt`, `turn`), and
`POST /api/decisions/judge` with `{ id, verdict: agree|disagree|edit, message? }`
records your verdict through the same registry lock `keep decisions` uses and
returns that type's updated agreement numbers. The newest pending decision for a
session already rides along in `/api/state` as `session.pendingDecision`, beside
`session.stateLine`, `session.lastVerdict` and `session.verdictConfidence`.

`keep watcher` runs on top of that index in shadow mode: after an interactive
turn ends it decides what you would have typed next — `continue`, `needs-input`,
`drift` or `quiet` — and records it **without sending anything**. A `continue`,
`answer`, `escalate` or `drift` verdict becomes a shadow entry you mark with
`keep decisions agree|disagree|edit`; `quiet` records nothing. `--dry` prints the
model input and the rule-only verdict for free, and `keep watcher replay` scores
verdicts against what you actually typed next in history. The daemon tick is off
unless `KEEP_WATCHER=1`.

`keep watcher live` is the switch that lets a verdict actually reach a running
agent — off by default, per verdict type, and refused for a type until 30 of its
shadow decisions are graded at 90% (`--force` overrules). Delivery happens only
in the daemon, only while the turn is still the session's latest, never after a
commit, push or deploy in that turn, never twice for the same turn, and at most
once per session per 10 minutes. `keep watcher live off` stops everything
immediately. See [turn watcher](turn-watcher.md).

Mutations auto-commit. Manual terminal use also pushes best-effort in the background;
Claude and Codex sessions leave commits local unless `KEEP_ALLOW_PUSH=1` is explicitly
set after push approval.

## Card dependencies

Use `keep wait-on <your-card> <upstream> -m "why"` when one card cannot continue
until another finishes, or `<upstream>#<n>` for a specific plan step. Every new wait
requires a nonempty reason, stored with that dependency. Step numbers are positional;
re-check `keep deps` after inserting or removing upstream steps.

Prefer a target that describes the fact you actually need:

```sh
keep wait-on <card> <upstream> --commit <sha>[,<sha>] -m "need these commits on origin"
keep wait-on <card> <upstream> --deployed <sha> --target <name> -m "need this deployment"
keep wait-on <card> <upstream> --status review,landing,done -m "need a reviewable result"
```

Commit waits resolve when every SHA reaches the upstream project's origin default
branch, verified through the existing `keep landed` sweep. Deployment waits resolve
from a `deployed <sha> to <target>` entry on the upstream card, as recorded by the deploy
hook. Status waits resolve when the upstream reaches any listed status (`review`,
`landing`, or `done`). Quote a pipe-separated status list if using `|` instead of commas.

A bare whole-card wait is refused with exit code 2 when the upstream has a plan;
the error lists its steps. Select a step or fact target, or pass `--whole` to explicitly
wait for completion of the entire card. A broad wait on an upstream in `review` or
`landing`, or with kind `idea`, also warns on stderr that it may sit for days and
suggests fact targets. Warnings alone do not fail the command.

`keep wait-on` rejects missing cards and cycles and moves active or review work to
waiting. `keep deps [<card>]` shows resolved and pending targets and their reasons.
Remove an exact entry by repeating its target flags with `--remove`; for example,
`keep wait-on <card> <upstream> --commit <sha> --remove -m "no longer needed"`.
Other dependencies remain intact, and pending notices for the removed entry are cancelled.
Already submitted messages cannot be recalled.

The daemon appends satisfied dependency results to the dependent card, returns a fully
unblocked waiting card to active when no scheduled check or need remains, and sends a
fenced `[keep] unblocked` notice to its latest eligible linked session. Busy or missing
sessions are retried without delivering from the CLI.

## Plans

A card can carry an ordered checklist at the top of its body. Add one with `keep add
--plan "first" "second"`, replace it with `keep plan <id> --set ...`, or edit individual
steps with `--add`, `--insert`, `--remove`, `--start`, `--done`, and `--undo`. Existing
steps keep their state when a replacement has the same text. `keep checkin <id> --step
next -m "..."` completes the current doing step (or the first todo step) and records the
check-in in one mutation. The CLI alone maintains this section:

```markdown
## Plan
- [ ] Write the migration
- [~] Run it on staging
- [x] Design the schema
```

The next incomplete step appears in `keep list`, `keep resume`, `keep show`, session
startup context, `keep who`, and fleet-review bundles. The full checklist stays above
the newest-first card log so fresh agents and scheduled runs see the plan first.

## Session restart

Keep can resume a conversation in the same pane ID, preserving pins and history.
Conservative restarts require a verified idle prompt, no draft or unresolved
background work, and graceful process exit. Queued restarts wait until the pane
has no viewers, can be cancelled, and survive daemon restart; the fleet reviewer's
read-only pane is exempt from the viewer check. Explicit force-restart recovery has its
own durable transaction and recovery checks; it is not ordinary idle cleanup.
See the [session reliability contract](session-reliability.md) for restart proof
and the [force-restart guide](force-restart.md) for explicit recovery commands.

Resume uses the agent's saved conversation/settings; an explicit permission bypass
is carried over only when the old process used it. Other one-off CLI overrides
are not replayed. Existing sessions may need a controlled restart/resume to load
new hooks; verify hook uptake separately from isolated tests.

## Auto-continue

For interactive Claude and Codex sessions, the Stop hook blocks once when a card explicitly
linked to that session is active and has a next plan step. Headless runs
are never continued. It will not block while an `AskUserQuestion` or `ExitPlanMode`
tool is unresolved, while Claude is in plan permission mode, or when the last non-empty
assistant text asks the owner a question. It will not repeat for the same card, position,
and step text; advancing the plan enables the next reminder. A session is capped at 25
continuations. The reminder fences the card's step text as data and clips it to 200
characters rather than treating card content as instructions.
`KEEP_AUTO_CONTINUE` defaults to `1`; set it to `0` to disable the feature globally, or
add `autocontinue: off` to a card's frontmatter to opt that card out. Codex uses
`keep hook codex stop` on Stop and `keep hook codex start` on SessionStart.
Only a validated interactive root transcript may continue; child threads, pending
tools, and unanswered synchronous or asynchronous questions are protected.
The question PreToolUse matcher is `^(?:.*\.)?request_user_input(?:_async)?$`.

Automatic cleanup checks on the existing five-minute sweep. A completed scheduled
check is eligible as soon as its turn settles. A session whose linked cards are all
done is eligible after 15 idle minutes; a session durably waiting for a question,
review, scheduled check, need, or dependency after 30 minutes; and any other settled,
unviewed conversation—including a generic wait for the next instruction—after 60
minutes. Transcript and user-input timestamps measure that idle time. Terminal
redraws and saved Watch layouts do not reset or pin it.

Background ledgers, Codex companion jobs, actual command or worker children, visible
viewers, drafts, terminal question/permission/plan dialogs, session-local timers,
standing agents, and unknown activity protect the process. Known runtime and MCP
helper descendants qualify only through the same identity-checked audit used by
restart; executable names alone never qualify. `keep keep-running [<#n|session-id>]
on|off` controls a persistent process pin independent of **Pin to Watch**; the latter
only changes the console layout. The equivalent API is `POST
/api/session-keep-running` with the exact JSON body `{sessionId, keepRunning}`.

Eligible sessions use the console's guarded graceful-exit path. Only a successfully
submitted `/exit` may progress to the existing timeout-based TERM/KILL fallback;
any refusal, changed input, or safety-check race cancels force escalation. The card
and transcript keep their session link, pending attention, unread completion, and
scheduled state. The console labels the exited conversation **Paused to save memory**,
and the row carries `retirement: {automatic: true, at, reason, idleMinutes}`.
`keep open <card>`, Resume, or a reply resumes the same Claude or Codex thread. Reply
resume happens inside `/api/send`, which retains its ordinary success response and
does not duplicate the message. Explicit Close keeps its separate acknowledgement
behavior.

Managed zsh panes, including shells left after an agent exits, retain their separate
eight-hour cleanup. Shell cleanup requires a verified empty prompt and no child
processes, and rechecks identity and activity before sending EOF. Exit attempts and
refusals are recorded in `.keep/session-cleanup.json`; failures retry at most once
per hour. Set `KEEP_AUTO_CLOSE_DONE_MIN`, `KEEP_AUTO_CLOSE_ATTENTION_MIN`, and
`KEEP_AUTO_CLOSE_UNATTENDED_MIN` to change the three agent windows. Set
`KEEP_AUTO_CLOSE=0` to disable both agent and shell automatic cleanup. The existing
done-window variable and master switch are backward compatible; the attention and
unattended variables only split the additional settled-session tiers.

Automatic Codex cleanup can retire parents with completed remote children only
when the full, identity-checked descendant history proves completion and remains
unchanged before exit. Missing/legacy child evidence, yielded commands and local
child processes remain protected. The existing age, viewer, draft and task
guards still apply; explicit Close retains its separate graceful-then-force policy.

Each continuation is appended to `.keep/continues.jsonl` with its card, session, step,
text, and timestamp. Fleet-review bundles count those entries since the last review so
the reviewer can spot thrash.

## Fleet presence and quiet windows

`keep who <project>` is a deterministic snapshot: open cards, matching live sessions,
scheduled checks, running Keep jobs, active holds, gated steps, and recent/dirty git state. It never
calls a model. If the daemon is unavailable, cards, holds, and git still render while
the session section is marked unknown. Project arguments accept a repo basename,
`castle/repo`, a `~` path, or an absolute path.

Use `keep hold <project> --for +15m -m "why"` before changing shared state such as a
deploy, migration, restart, or secret. The hold is written atomically under
`.keep/holds/`, appears in `keep who`, session-start context, and reviewer bundles,
and expires automatically. Release it early with `keep release <hold-id>`.

A `device:<serial>` scope names shared hardware, such as a test phone driven from cards
in several repositories. It is the one scope that crosses projects: other projects'
device holds appear in every `keep who`, Claude session-start context, and reviewer
bundle, and `keep who <project> --scope device:<serial>` or `keep wait --no-hold
<project> --scope device:<serial>` matches them from any project. An unscoped
`keep wait --no-hold` still waits only on its own project's holds. Serials are
lowercased, so `--scope device:ABC123` and `--scope device:abc123` are the same hold.

A hold asks other sessions to wait. When you have not taken a shared resource away
but have *changed how it behaves*, write a state note instead: `keep note <project>
--scope staging -m "staging is home-only, no deck-persistence config" --for +2h`.
Notes are expiring, non-blocking, broadcast to sibling sessions in the same checkout,
and visible everywhere holds are. `keep resources <project>` lists what a project has
declared, and the watcher can notice a turn that touched one and said nothing. None
of it gates anything — see [shared state](shared-state.md).

## Alerts and the morning brief

`keep alert` adds a judged push layer in front of Keep's cards. `attention` is for
something the owner should see soon; `urgent` is for something that warrants an immediate
phone notification and speaker announcement. Every accepted or deferred alert is
appended to `.keep/alerts.jsonl`, including each attempted channel's `ok`, `suppressed`,
or `failed` outcome; `keep alerts` shows the last 24 hours and `--all`
shows the full ledger. A repeated `--key` is dropped for six hours unless its level
rises from attention to urgent. `--card` also records `alert (<level>): <text>` on the
named card without claiming its session.

| Level | Present at the Mac | Away | During `keep quiet` |
| --- | --- | --- | --- |
| attention | sound | phone push | deferred to the brief |
| urgent | phone push + speaker | phone push + speaker | unchanged |
| brief | phone push | phone push | unchanged |

“Phone push” is two channels: the `push` webhook and the `expo` channel below.
They ride together in every decision, so quiet hours, the dedupe window and the
daily caps — all decided before a channel is picked — apply to both identically.

Presence is an idle time under five minutes. Phone pushes use `KEEP_PUSH_WEBHOOK` or
`~/.config/keep/push-webhook`; channel failures never crash the caller. When no push
channel is configured at all, the brief is recorded once for the day and left in the
inbox instead of being retried every 30 minutes until the noon cutoff — nothing was
attempted, so there is nothing for a retry to reach. Urgent speaker
delivery still observes the announce service's quiet hours. `keep quiet +2h` (or any
normal Keep duration) suppresses attention alerts until that time, and `keep quiet off`
clears it.

The desktop console's bell opens a persistent notification inbox for these alerts,
separate from session questions in “Waiting on you.” It includes deferred alerts and
failed deliveries. Read/unread state lives in `.keep/notifications.json`; marking a
message read never changes its card or acknowledges a session question. Repeated
keys show their latest message, and an escalation becomes unread again. Selecting a
message shows its linked card notes; session and reviewer buttons open the relevant
console view.

With desktop notification permission enabled, new accepted attention/urgent alerts
created while present also get a visual desktop banner. Existing sound, phone and
speaker routing remains in effect. Quiet/capped alerts and daily briefs remain in the
inbox without an additional desktop banner. The running shell claims each banner
once across windows/reloads; alerts older than two minutes stay in the inbox without
replaying interruptions. A desktop banner click opens that message. Quit stops desktop
delivery until the app is reopened. `KEEP_ALERT_CHANNELS=none` also disables desktop
banners; an explicit channel list must include `desktop` to enable them.

The default daily caps are 12 attention and 4 urgent alerts, with 30 minutes between
urgent alerts. The fleet reviewer has its own allowance inside those totals: 5
attention and 2 urgent alerts per day. The corresponding `KEEP_ALERT_*` environment
variables are `KEEP_ALERT_ATTENTION_DAILY`, `KEEP_ALERT_URGENT_DAILY`,
`KEEP_ALERT_URGENT_GAP_MIN`, `KEEP_ALERT_REVIEWER_ATTENTION_DAILY`, and
`KEEP_ALERT_REVIEWER_URGENT_DAILY`. Alerts rejected by a cap are recorded as deferred
so they still appear in the next brief. `KEEP_ALERT_DEDUPE_HOURS` changes the six-hour
dedupe window; `KEEP_ALERT_CHANNELS=none` disables channel processes for isolated use.

`keep brief` prints the current brief; `keep brief --send` also routes it. The daemon
sends one each local day at `KEEP_BRIEF_AT` (default `08:00`). It covers review cards,
open needs, overdue checks, deferred alerts, recent
medium/high reviewer findings, active holds, and gated steps with pending commits. A
failed delivery retries every 30 minutes until 12:00 local, when the daemon records the
failure and gives up for that day; `keep brief --send` always sends immediately.

## Devices and push

The Keep phone app registers itself for push. `.keep/devices.json` holds the
registered phones — `{ id, expoPushToken, platform, name, appVersion,
registeredAt, lastSeenAt }` each — written 0600 through a temp file and a rename,
like the rest of `.keep/`. The Expo push token is the key: the same token
re-registering refreshes its name, version and `lastSeenAt` instead of adding a
row, and a rotated token arrives as a new device. At most 16 devices are kept;
past that the one seen longest ago loses its slot. A token must look like
`ExponentPushToken[…]` or `ExpoPushToken[…]`, and the platform must be `android`
or `ios`.

Three routes, all of them needing `x-keep: 1` on top of the ordinary
authorization:

- `POST /api/devices` with `{ expoPushToken, platform, name?, appVersion? }` →
  `{ ok: true, device, count, created }`. A bad token or platform is a `400`.
- `DELETE /api/devices` with `{ expoPushToken }` → `{ ok: true, removed, count }`.
  `removed` is false when that token was not registered.
- `GET /api/devices` → `{ ok: true, devices: [...] }`, each device carrying
  `tokenTail` (the last six characters) in place of its token. A whole push token
  is a bearer credential for that phone's notifications and never leaves the
  daemon.

The `expo` channel delivers every decision the `push` webhook gets, to every
registered phone, by posting to `https://exp.host/--/api/v2/push/send` with a
10-second timeout, at most 100 tokens per request:

```json
{ "to": ["ExponentPushToken[…]"], "title": "agent:reviewer", "body": "<the alert text>",
  "data": { "key": "alert:<alert id>", "sessionId": "" }, "badge": 3,
  "sound": "default", "channelId": "attention", "priority": "high" }
```

For an alert the title matches the desktop banner's (`Keep`, the alert's `from`,
and `· Urgent` for an urgent one). `data.key` is what the app hands back to the
console on a notification tap: `alert:<id>` opens that message in the inbox, the
same path a desktop banner click takes, and an attention key selects that row in
the queue. `badge` is the console's own count — the
attention rows it is showing plus its unread inbox messages — read from the last
state the daemon published. It is therefore approximate by design: dismissals are
browser-local, and an alert's own inbox entry is appended after delivery, so it is
not in the number that alert carries. A process with no dashboard state (the
`keep` CLI) sends no `badge` at all and the app keeps the count it has.

With no phone registered the channel is simply unavailable — nothing is attempted
and the decision stands on its other channels. An explicit `KEEP_ALERT_CHANNELS`
list must name `expo` to enable it, exactly as it must name `desktop`.
Expo answers with one ticket per token: a `DeviceNotRegistered` ticket
unregisters that device, and any other failure is logged at most once a minute
and never raised to the caller. An uninstalled app is usually reported later
still, in that push's *receipt*, so every accepted ticket is written to
`.keep/push-tickets.json` (0600, newest 500, dropped after 24 hours) and the
daemon's `push-receipts` scheduler asks for them every 15 minutes, 300 ids per
request. A receipt is a verdict: `DeviceNotRegistered` unregisters that phone and
drops its other pending tickets with it, anything else is logged once a minute,
and either way the ticket is dropped. A receipt Expo has not produced yet leaves
its ticket for the next run, and so does a request that fails — which is recorded
as a failed run, so an Expo outage shows up in `keep health` as a failing
`push-receipts` row rather than a green one.

### A session waiting on you

The phone's main case is not a `keep alert`: it is a session that started waiting.
The console raises those notifications itself (`applyStateEffects` in
`web/app/app.js`), which a phone with no console open never sees, so `bin/attention-push.js`
runs the same rule on the daemon side, once per published state, and pushes
instead. A row is pushed when its attention key is new since the previous
publication, `pri` is 0, its kind is `question`, `permission`, `plan` or `input`,
and Owner has not set it aside — health, stalled, unblocked and overdue rows are
watched in the console and never pushed. The key is the console's own
(`item.key`, else `<session/task/pane>:<since>`), so a tap selects that row; the
title is `<project> · <row title>` and the body is the row's question, else its
detail, else `Waiting for your input.`.

The first publication after the daemon starts seeds the key set and notifies for
nothing in it — a restart is not news, and that set is deliberately the one piece
of this that does not survive one. A key that leaves the attention list is
forgotten, so the same session waiting again later is a new event, subject to the
dedupe window below.

These are not alerts and do not enter the ledger: the row is already in the
console's “Waiting on you” list, so a second copy in the alert inbox is noise,
and a session's questions are not judged against the same daily budget as an
alert somebody wrote on purpose. They go straight to the phones through the Expo
sender, under their own policy, kept in `.keep/attention-push.json` (0600) so a
daemon restart cannot grant another day's worth or repeat a key it just sent:

- Quiet hours (`keep quiet`) drop the push. Nothing is queued — the row is still
  waiting when they end, and the console is where it is triaged.
- The same key is pushed at most once every six hours
  (`KEEP_ALERT_DEDUPE_HOURS`), so a row that leaves the list and comes back is
  one event, while the same session waiting on something new has a new key and
  pushes at once.
- `KEEP_ATTENTION_PUSH_DAILY` caps them, default 100 per local day, separate
  from the 12 attention alerts.

The webhook never sees them (its consumer is unknown and has only ever received
`keep alert` output), the speakers stay for urgent alerts, and the console keeps
raising its own desktop banner for the same row.

## Standup

`keep standup` overwrites `standup.md` with an at-most-three-sentence standup note
covering work since the previous weekday's generation time. `--since` overrides that
cutoff (a bare date and time is Pacific), `--dry` prints the fenced evidence and prompt
without calling a model or writing files, and `--show` prints the current note. The
daemon generates it on weekdays at `KEEP_STANDUP_AT` (default `11:30`) in
`KEEP_STANDUP_TZ` (default `America/Los_Angeles`), retries failures every 15 minutes
until 13:00 Pacific, and displays the latest note and its source cards on the dashboard.

## Daily ideas sweep

`keep ideas` runs the fleet-wide workflow-improvement pass immediately. It gives a
tool-free model seven days of fenced Keep evidence, avoids ideas already filed or
already shipped, and lands at most three `kind: idea` cards through the reviewer's
normal duplicate checks. `--dry` prints the evidence and prompt without
calling a model or writing state; `--model` overrides `KEEP_IDEAS_MODEL` (default
`fable`). When the model needs usage credits the account does not have, that sweep
runs on `opus` instead (budget-checked on the same account). The daemon runs it every day at local `KEEP_IDEAS_AT` (default `07:30`) and
retries failures every 30 minutes until noon.

The sweep spends against the account the automation policy picks for the `ideas`
purpose (`automationAccounts.ideas` while it has room, else the `automationPool`
account with the most; see [automation pool](accounts.md#automation-pool) for the
pool, the default-account exclusion, and deferral). With no pool it falls back to
`automationAccounts.claude` and then the Claude default, so no config change is needed.
A pool with no room for the model is a code-6 skip.
Its budget is read against that account: without one, a fleet with more than one Claude
account reports `reviewer account is unknown in multi-account mode` and the sweep never
runs. An exhausted window (budget code 6 or 7) is recorded as a healthy skip; a budget
that cannot be read at all (code 8) is recorded as a **failure**, so `consecutiveFailures`
climbs and the brief shows it rather than the sweep dying silently behind a green row.

Headless run logs written by Keep before scheduled checks became sessions
(`.keep/runs/*.jsonl` and `*.diff`) are orphaned: nothing reads or removes them, and they
can be deleted by hand. A headless run that was still in flight when the daemon was
upgraded is dropped — its result was never landed, and its card comes due again on the
next tick.

### Health states

`keep health` reads each scheduler row as one of:

- **failing** (red): three or more consecutive failures whose fault still stands:
  the latest attempt failed, or the last failure is recent.
- **recovered** (amber): a nonzero streak whose last failure is no longer recent,
  with only clean records since — skips with nothing due, or a state the scheduler
  tolerates. The streak is kept until a real success clears it, and the detail reads
  `last failed 21h ago (<error>) · 3 failed attempts · latest check skipped 1m ago ·
  awaiting a real run`. It is out of console attention, the review bundle's daemon
  health and the brief's daemon line. A recovered row whose scheduler then stops
  ticking still reads silent or never.
- **warning** (amber): one or two failures whose fault still stands.
- **silent** / **never** (red): no tick in twice the cadence, or none since the
  daemon started.
- **skipped**, **ok**, **disabled**.

"Recent" is the longer of an hour and two of the row's cadences, capped at a day
(`recentFailureMs` in `bin/health.js`). A skip is the scheduler finding nothing to do,
not proof its work succeeds: a scheduler whose real work comes hourly and fails every
time, with "nothing due" every minute between, is failing, not recovered. The same
rule gates `daemon-health` in `keep lint` and `sched:` signatures in self-repair.
A daily scheduler gets the full day, so a brief that gave up at noon is still red the
next morning until it tries again.

The latest attempt comes from the row's `lastResult` (`ok`, `failed` or `skipped`,
the kind of its latest record). A row written before that field existed is read from
its timestamps: a failure sets `lastErrorAt` to `lastRunAt`, and a skip moves
`lastRunAt` alone. A tick that did not try — it gave up for the day, was deferred by a
spent automation pool, found the reviewer busy or its pane locked, or is a start-up
placeholder — records `{ skipped: true, holdResult: true }`: it moves `lastRunAt`, so
the row cannot go silent, and carries a stored failure forward, so a failing row stays
failing (after anything else it is an ordinary skip). The `loop-stalls` heartbeat uses
it while a severe stall is inside its hour, `usage` while an account's failure waits
for its retry, `runs` for the rest of a day on which a check open failed for good,
`brief` after the noon give-up, `leftovers` when the host could not be asked, and
`review`, `review-compact`, `auto-compact`, `slack`, `landed`, `standup`,
`discord` and `git-pull` on their did-not-try paths. A recovered row is sent with
`displayState: 'warning'` and `state: 'recovered'`, so a console tab still running JS
from before `recovered` existed colors it amber too.

The ideas sweep, standup and Slack classification are the only model calls Keep still
makes headless (they are one-shot generators, not agents). They disable
`codex@openai-codex` by default; set `KEEP_HEADLESS_DISABLED_PLUGINS` to a
comma-separated plugin list, or empty to opt out.

## Daemon self-repair

When a daemon failure signature persists — a scheduler failing repeatedly on the
same normalized error, more than three daemon starts in an hour across two ticks,
a delivery incident unchanged for half an hour — Keep opens one card per signature
with the health record and a log excerpt attached, creates a fresh `keep-tool`
worktree out of process, and opens one interactive repair session there. At most two
cards a day, one open card per signature, a 24-hour cooldown after each resolves.

The daemon restart stays manual: `keep hook pre-bash` refuses `keep
restart-daemon` (however it is spelled, including the node wrapper and the
`/api/restart-daemon` endpoint), `keep service`, `launchctl`, git writes anywhere
under the live `~/keep-tool` checkout, force pushes and `wt land` inside a repair
run; reading that checkout with `log`, `status`, `diff`, `show` or `rev-parse`
still works. `keep self-repair`
shows what is open; `keep self-repair --dry` shows what the next tick would open.
See [daemon self-repair](self-repair.md).

## In-flight records past their max age

Operations that must survive a daemon restart leave a durable record under
`~/keep/.keep` while they wait for something, and each has a sweep that finishes the
record when that thing happens. When it never happens, the record just sits there: an
account transfer in `recovery-needed` for fourteen hours, a delivery journal retried
2,894 times over two days. So every kind has a maximum age, and the stalled sweep
(`bin/inflight.js`, once a minute) names any record past it:

| kind | record | in flight while | max age | resolved by |
|---|---|---|---|---|
| `delivery` | `delivery/<hash>.json` | in the top directory (not `settled/`) | 2 h from `createdAt` | `keep pane screen <pane>`; submit or clear the draft; re-run the byte-identical `keep tell` |
| `account-handoff` | `account-handoffs/<session>.json` | `stopping` … `delivering`, `staged`, `recovery-needed` | 30 min from `updatedAt`; 24 h if the source never stopped | `keep handoff <session> --pane <pane> --account <target>`; Abandon in the console if the source never stopped |
| `handoff-queue` | `handoff-queue/<session>.json` | `queued` | twice `KEEP_HANDOFF_QUEUE_MAX_MIN` (90 min by default) from `enqueuedAt` | the `handoff-queue` health row; cancel or retry from the console |
| `session-move` | `session-moves/mv-*.json` | `stopping` … `verifying`, `recovery-needed` | 1 h from `updatedAt` | `keep move --recover <tx>` or `--abandon <tx>` |
| `portable-transfer` | `portable-transfers/<key>.json` | `prepared`, `launching`, `ambiguous`, `awaiting-setup` | 1 h; 6 h for `awaiting-setup` | `keep transfer … --resolve-session <session>` |
| `compact-swap` | `compact/<session>.swap.json` | present | 2 h from the swap or the end of its deferral | restore the model in the session; never delete the record |
| `registry-lock` | `lock/owner.json` | present | 10 min | find the holder with `ps -p <pid>` |
| `worktree-recreation` | `worktree-recreations/<hash>.json` | present | 30 min from `startedAt` | inspect the worktree; `wt rm --force --delete <path>` if the recreation died |
| `pi-opening` | `pi-opening/<session>-<uuid>.txt` | present | 30 min (file mtime) | read it (the opening Pi never received), relaunch if the work matters, remove the file by hand |
| `node-codex-launch` | `node-codex-launches/<hash>.json` | present | 2 h from `launchedAt`; its owner drops it at 24 h, reported as expired | `keep pane screen <pane>` on the node |
| `review-obligation` | `review-obligations/<card>.json` entries | `open`, `awaiting-verdict` | 8 h from `at` / `stateAt` | `keep reviewed <card> --job <job> …` or `keep reviewing <card> --drop <id> -m why` |
| `session-restart` | `session-restarts.json` entries | `restarting`, `recovery-needed`, `queued` unless idle-mode | 2 h from `at` | `keep force-restart <session> --pane <pane> --recover` (Owner's approval) |
| `pi-job` | `pi-jobs/<id>/job.json` | `queued`, `running`, `cancelling` | 12 h from the last write | `keep pi cancel <id>` |
| `pending-checkin` | `runs/*.pending.json` | present | 1 h (file mtime) | the `pending check-in` lines in `serve.log`; `keep show <card>` |

Each maximum is well past the longest the operation legitimately takes, and past the
record's own automatic expiry where it has one, so what is left is a person's call.
Each has its own `KEEP_INFLIGHT_*_MIN` environment override, named beside it in
`bin/inflight.js`.

Age comes from the record's own timestamps, the file's mtime only when it carries
none, and never from asking a pane, a transcript or another node. A record for a
session on a node that is not answering is therefore not "stuck" for being unknowable;
it is named only once it is old by its own account. Records that expire on their own
(open-handoff routing hints, parked queue entries, review-queue items, background-job
ledgers, holds, step claims) are not tracked. Neither are unblock records: one is stamped
resolved while its card may still legitimately wait on another upstream, a
`check_after` or a need, and the unblock sweep already gives up a deliverable one after
a day. An idle-mode restart queued behind a busy session is legitimately waiting too.
A record file (or a whole directory) that cannot be read (EMFILE, EIO, EACCES) is
named on the row as unreadable, and only the records last seen in it are carried from
the last reading, for at most an hour; after that the card calls them unknown, not
stuck and not finished. A file that vanished, is half-written, or is not a record at
all (a stray file where a job directory belongs: ENOTDIR, EISDIR) is simply not one.

A record past its max age shows up three ways:

- **`keep stalled`** and the console's stalled attention, one line per record with its
  age, what it is waiting for, and the resolving command. These rows are refreshed even
  when the rest of the stalled sweep fails.
- **The `inflight` health row** fails while any record is past its max age. Its error
  names record identities only, never ages, so an acknowledged row stays acknowledged
  while the same records age. Self-repair excludes the row.
- **One Keep card**, `Keep: in-flight records past their max age` (project
  `~/keep-tool`, tags `personal`, `inflight`), naming every record. The daemon keeps
  its id in `.keep/stalled/inflight.json` and never opens a second one while it is
  open (anything but `done`: a card Owner parked as waiting, blocked or deferred still
  takes the check-ins). When the set of records changes it adds one check-in with the
  new count, the new records in full, and the ids that finished, or expired where their
  owner drops them on a timer; a record has to be absent for ten minutes before it
  counts as finished, so a blink never reads as finished-then-new. When the set empties
  it checks in once and leaves the card for Owner to close.
- Closing the card dismisses the records it named, keyed by record identity (not age,
  so a console Retry that restamps a record which then sticks again stays dismissed).
  A dismissed record is forgotten only after six hours absent. Only a record none of
  those covers opens a new card.
- A card write that throws does not repeat every tick. A card or check-in already saved
  when its commit threw (a held `index.lock`) is recognised and adopted; a daemon that
  lost its state finds its open card by title and tag instead of filing a second; any
  other failure is retried after twenty minutes. The card does not depend on
  self-repair being enabled.

This is escalation only. Keep never mutates, settles, retires or deletes a record
because it is old: each owner's retirement rules (a typed delivery journal on a live
pane is never retired automatically) stay exactly as they were.

## Landed commits

`keep landed` checks recent open cards for cited commit shas that have reached each
project's `origin` default branch. It annotates open cards and applies the close policy
in `watch/landed.json`: `narrow` requires an explicit landing-only next step, while
`broad` closes review cards unless their newest work check-in names another pending
step. Future scheduled checks always keep a card open. With `closeDry` enabled, the
daemon records and displays would-close decisions without changing status; inspect
them with `keep landed decisions [--disagree]`. `keep landed policy narrow|broad` and
`keep landed dry on|off` update the committed configuration. `--dry` prints planned
actions without changing cards or local state; `--only <id>` restricts the sweep to
one card. The daemon runs every 30 minutes by default (`KEEP_LANDED_MIN`). Ending
check-ins should cite full commit shas and finish with an unambiguous `Next:` line.

A cited sha that never reaches the default branch is matched by patch. `wt land`
rebases a worktree branch onto `origin/<default>` before pushing, so the sha a
check-in cites is not the sha that lands. When the cited commit is still in the
repository's object store, the sweep compares its `git patch-id --stable` against the
default branch's commits, and on a match records the landed sha with the cited one as
an alias — the check-in then reads `cited <cited> landed as <landed> (same patch)`,
and either spelling resolves the citation. A citation matches only a commit that
reached the branch **no more than a day before the check-in that cites it**: an
identical diff further back is older work, not this card's commit under a new sha.
The patch-id index is built once per repository per sweep, from the oldest window any
of that sweep's citations needs and at most 300 commits, and every lookup is filtered
by the citing check-in's own window. Merges and empty commits have no single patch and
are never matched, the comparison is skipped entirely when the fetch failed, and an
unmatched citation is retried every six hours and given up on a week after its
check-in; what has been tried, and what matched, is remembered per card under
`.keep/landed/<id>.json` so no sweep derives the same patch-id twice.

Patch-id cannot see a revert: a patch that landed and was then reverted still counts
as landed, so a card closed on that evidence while a revert is in flight has to be
reopened by hand.

## Reviewed commits and the implicit land grant

`keep allow <card> <action>` answers from the grants Owner wrote on the card. `land`
is the one action it can also answer from evidence — a record that an independent
review saw exactly the patches that are about to reach the default branch.

```sh
keep reviewed <card> --commit origin/master..HEAD --verdict clean --by "codex sol" --job job_abc
keep reviewed <card> --commit <sha>,<sha> --verdict findings --evidence "two real findings" -m "..."
keep reviews <card> [--json]
```

Run it from the worktree that holds the commits. A range (`origin/master..HEAD`) or a
comma-separated list of shas both work; an unknown sha, or a cwd that is not a git
repository, is refused. Each record goes to `.keep/reviews/<card>.json` as
`{id, at, by, job, jobAccountId, jobAt, verdict, evidence, commits: [{sha, patchId, subject}], bySession, message}`
and the card gets a `code-review` log entry (never a heading starting with the bare
word `review`, which the fleet reviewer's own notes own).

**What is verified.** `--by` starts with `codex`, `opus`, `claude` or `human` and may
carry any suffix. `--by human…` is Owner's own attestation and is **refused from inside
an agent session**; a record that carries a `bySession` is never read as human
testimony. `--job <codex-job-id>` is resolved against every registered Codex account's
jobs directory (`.keep/codex-companion/accounts/*/state/*/jobs/<id>.json`, plus the
legacy plugin root): a job Keep cannot find, or one whose `status` is not `completed`,
is refused, and a resolved one stores `jobAccountId` and the result file's mtime as
`jobAt`. `--evidence` is scrubbed and capped at 500 characters, and counts as a
credential only for `opus…`/`claude…` reviews (a subagent review leaves no job file)
and only at **80 characters or more** — "clean" is not evidence. A `codex…` review needs
a resolvable `--job`; evidence alone will not do. A `--verdict clean` record that
cannot meet its own bar is refused at write time; a `findings` record is never
authority, so it is recorded whatever it cites.

None of this is a security boundary. An agent that edits card files or
`.keep/reviews/*.json` directly can write anything, and Keep does not try to stop it.
It is an **audit trail with a bar in front of it**: every clean record names a reviewer
and points at something a later reader can go and check, and the cheap paths to a
self-issued land grant are closed. The remaining honest ceiling: a session can launch
its own Codex job and cite it, and Keep does not read the job's prompt. A second model
ran and its transcript is on disk; whether it was asked to review is for the fleet
reviewer and Owner to check.

The key is `git patch-id --stable`, not the sha: `wt land` rebases onto
`origin/<default>` before it pushes, so the landed sha is never the reviewed one, while
the patch is the same patch.

`keep allow <card> land` then exits 0 with `why: reviewed clean: <n> commit(s) by <by>
at <time> (record <id>)` when **all** of:

| condition | why it fails |
| --- | --- |
| auto-land is not opted out | the card's `auto_land: off`, or `watch/autoland.json` `{"enabled": false}` or listing the card in `optOut` |
| the cwd is a linked, wt-managed `wt/` worktree with a clean tree | not a worktree, no `.wt.json` (which `wt land` refuses too), a non-`wt/` branch, a detached HEAD, or uncommitted changes |
| the range is linear | `origin/<default>..HEAD` contains a merge commit, whose conflict resolution is content no review of the branch saw — rebase first |
| every commit in `origin/<default>..HEAD` has a `clean` record whose patch-id matches | a commit with no record, or one whose newest record is `findings` |
| that record clears the attestation bar | `human…` with a `bySession`; `codex…` with no verified `--job`; `opus…`/`claude…` with no verified `--job` and under 80 characters of `--evidence` |
| no review launched for these commits is still out | a pending review obligation (below) covers one of them and its verdict has not been recorded |

Anything else exits 3 and prints the condition that failed. `--json` adds `implicit:
true` and the `record` that carried the decision. `watch/autoland.json` is
`{"enabled": true, "optOut": ["<card>"]}` and is treated as enabled when absent: the
opt-out is the deliberate act, and `auto_land: off` on a card is a **string**, because
frontmatter keys Keep does not know are dropped on rewrite unless they are strings.

`keep land <card>` runs that check and, on a 0, runs `wt land` in-process and cites the
landed sha in a check-in naming the record. On a 3 it prints the `why` and lands
nothing. `--dry-run` stops before the land. For keep-tool, `wt land` fast-forwards a
ready live checkout to the landed SHA and restarts the daemon. Inspect a skipped or failed
deployment: a checkout already past this land belongs to its newer landing session; recover
only a safe failure the landing still owns, otherwise record the blocker or dependency.

## Reviews that were launched and have not answered

`keep reviewed` records that a review happened. The other half is a review that was
*expected*: a session launches a Codex review, its turn ends before the verdict comes
back, and the review evaporates — the commits end up self-verified, or sit unlandable
until somebody notices. Three cards did exactly that over 2026-09-12..15.

```sh
keep reviewing <card> --job <codex-job-id> --commit origin/master..HEAD [--account codex-secondary] [--by "codex sol"] [-m "..."]
keep reviewing <card>                              # what this card is still waiting for
keep reviewing <card> --drop <obligation-id> -m "why"
```

Open the obligation right after launching the review, from the worktree that holds the
commits. `--job` must already resolve to a Codex job Keep can find (a job that has not
finished is fine here — that is the point), and `--commit` is required: an obligation
that covers nothing cannot gate a land. Records go to
`.keep/review-obligations/<card>.json` as `{id, at, card, job, accountId, by, commits,
state, stateAt, note, session}`.

The daemon sweeps them every five minutes (`review-obligations` in `keep health`) and
settles each one from the job's own state, using the same companion snapshot the console
keeps warm:

| what Keep sees | the obligation becomes |
| --- | --- |
| a review record on the card cites this `--job` | `satisfied`, silently — `clean` and `findings` both count, because the question is whether the review came back |
| a *later* record with a verified `--job` covers every one of its patches | `satisfied` — a review re-run under a new job id has answered the same question |
| the job finished and no verdict is recorded | `awaiting-verdict`, with one `review pending` check-in naming the `keep codex … result` and `keep reviewed …` commands |
| the job ended failed, cancelled or aborted | `failed`, with one `review failed` check-in |
| the codexjobs sweep calls the job dead, or stalled for over 20 minutes | `failed` |
| no job file, on three consecutive sweeps, 15 minutes after the obligation was opened | `failed` |
| still running after six hours, or `awaiting-verdict` for six hours | `abandoned` |

"I could not look" is never evidence. Three readers can each fail to see a job: the
companion's discovery, the jobs directory, and the job file itself. A missing job has to
be missing on three **consecutive** sweeps before it fails — any answer from the job
clears the count — and it is not counted at all while the companion's discovery is
`partial` or `unknown`, while the jobs directory throws, or while the live sweep still
shows a row for that job. A live row is the strongest of the three: if the companion can
see the process, an unreadable job file says nothing about whether it is running, and
seeing it alive clears the absences counted so far. A row that says the job is *dead*, or
stalled past the threshold, decides on its own when there is no job file to read — but a
job file that says `completed` always wins over it, because the snapshot and the file are
read separately and a review that finished in between leaves a stale row beside a real
result. Only
the six-hour ceiling applies in that state, so an unreadable companion cannot block a
card forever either. A record with no readable `at` is treated as undated rather than as
just-opened, so it ages out instead of counting a miss every five minutes forever — and
so is one whose timestamps are in the future, which would otherwise make every ceiling
measure negative time and gate its commits until that date.

Two properties hold. **Nothing here ever writes a verdict**: a job that died fails the
obligation so the review is re-run, and is never mistaken for a clean one. And every
obligation reaches a terminal state on its own, so a job that died in the night cannot
block a card forever — `failed` and `abandoned` stop gating the land, and the land is
then decided by the ordinary rules above.

That second property is a deliberate trade, and it is worth being explicit about what it
costs: a card whose only clean record is an agent self-attestation with 80+ characters of
evidence *will* land once its outstanding obligation terminates. The obligation is what
stops a session self-attesting while the independent review it launched is still in
flight; it is not a second attestation bar, and keeping it forever would be exactly the
endless blocker on a dead job this mechanism exists to avoid. The card records the
`review failed` check-in either way, so the terminated obligation is visible to anyone
reading it.

The sweep writes each transition **before** it announces it, and **every** writer of the
file — the sweep, `keep reviewing`'s append, its `--drop`, and `keep reviewed`'s settle —
goes through the registry lock, re-reading and replacing only records that still look
exactly as they did when it decided. A check-in is a git commit, so a transition
announced but not written would be announced every five minutes forever; a transition
written but not announced carries an `announce` flag and is **retried on later sweeps
until the check-in lands**, so delivery is durable rather than at-most-once. The delivery —
re-read the record, re-read the card's review records, write the check-in, clear the debt
— happens inside **one** registry lock, with `checkinTask` told the lock is already held.
A verdict recorded in the meantime cancels the announcement rather than being
contradicted by it, and that check covers terminal records too.

A check-in says only what Keep observed, and so does the reason inside it, which is
interpolated verbatim. Not that no verdict was produced — a review abandoned after six
hours may have produced one nobody recorded. Not that these commits have no review
record, which is a question about the whole card that `keep reviews` answers and this
does not. And not how long the *job* ran or how long ago it finished: a daemon that was
down for a day did not watch it for that day, so every duration is how long **Keep
waited**. It reports that Keep stopped waiting, what it saw, and where to look. A record Keep cannot use is normalised on
read rather than throwing mid-sweep, and each card is settled inside its own try, so one
bad record costs its own card a tick instead of every card after it in the listing. A card that refuses the check-in a dozen times running (an archived
one always will) is given up on with an error rather than retried forever, and a record
that still owes a check-in is never pruned.

A file that exists but cannot be read is an error, never an empty list — failing open
there would let a land through as if no review were outstanding, and an append would
overwrite the history it could not read. `keep allow <card> land` then refuses naming the
store, not an imaginary obligation. Terminal records age out after 30 days; a card whose
last record ages out loses its file, and the sweep is what retires it, because nothing
else would ever write to that card again.

While an obligation is `open` or `awaiting-verdict` and covers a commit in
`origin/<default>..HEAD`, `keep allow <card> land` exits 3 naming the job. That is the
case a clean record cannot answer: a session self-attesting while the independent review
it launched is still in flight. An explicit `land` grant from Owner still wins.
`keep reviewed … --job <id>` settles the matching obligation as it writes the record;
`keep reviewing --drop` is the deliberate way to stop waiting, and it requires a reason.
`keep reviews <card>` lists the pending ones above the records.

## Which reviewer a review goes to

When every Codex account is at its usage limit, sessions improvise: one hand-runs an
Opus subagent review, another writes "both Codex accounts at usage limit until 02:00"
into a check-in, a third hand-schedules a Codex second look. Three cards did all three
independently on 2026-09-18, and none left anything a later reader could use to tell a
fallback review from an ordinary one.

```sh
keep review-route [--json]                                   # who should review, and why
keep review-route --exhausted <codex-id> --until +4h -m "weekly limit"
keep review-route --clear <codex-id>
```

This is advice, not enforcement: it launches nothing, adds no provider, and never queues
a second review — a fallback review is a review, not half of one. It answers from two
files. `watch/review-routing.json` is the policy Owner writes:

```json
{ "codex": ["codex-main", "codex-secondary"], "fallback": "opus" }
```

Both keys are optional. With no `codex` list, every registered Codex account counts; a
configured id that is not registered is dropped as a typo rather than offered as a
reviewer. `fallback` must be `opus` or `claude` — `codex` is what the fallback replaces,
and `human` is Owner, who is not something a config file routes work to. **With no
`fallback` there is none**: routing to another model is Owner's decision in this file,
not one a session makes for itself at 2am, and the answer then is the sentence the
session needs ("every Codex account is exhausted until 02:00, and no fallback reviewer is
configured") rather than a silent improvisation.

`.keep/review-routing.json` is the observed-exhaustion ledger `keep review-route
--exhausted` writes. Entries expire at their own reset time, so an account nobody
remembered to clear does not stay exhausted for a week.

`keep reviewed --fallback` stamps the record `route: fallback (codex exhausted until
<reset>)` and puts a `reviewer:` line in the card's `code-review` entry. The **session
asserts it**; it is not inferred from the ledger when the record is written. Inference
read the wrong clock in both directions: a review that ran while Codex was exhausted lost
the stamp if it was recorded after the reset, and an ordinary review picked one up if an
account happened to be exhausted by the time it was written. The ledger is still
consulted, but only to say what the exhaustion was — and only for the accounts this
install routes reviews to, phrased `as recorded` because the window it names is the one
standing when the record was written. With an empty ledger the stamp is the bare word
`fallback`. A fallback record clears the same attestation bar as any other:
an `opus`/`claude` clean record needs a verified `--job` or 80+ characters of
`--evidence`.

Writing grants is Owner's: `keep allow <card> --grant`/`--until` and `keep add
--allow`/`--until` are refused inside an agent session (`CLAUDE_CODE_SESSION_ID` or a
Codex session marker) unless `--as-owner` is passed with `KEEP_OWNER=1` in the
environment. `--revoke` and `--clear` stay open, since they only ever reduce authority.
Like the review records, this is attribution and a bar, not enforcement: a session that
edits the card file directly writes whatever frontmatter it likes.

## Resuming a session

Resume through `keep open <session-id>`, always. A raw `claude --resume` outside the
host starts a session with no pane binding, no account, no `--mcp-config`, no model and
no permissions flags, and lets ambient credentials into it; on 2026-09-09 a by-hand
resume that dropped `--dangerously-skip-permissions` left the resumed session denying
its own work.

`keep hook pre-bash` denies a Bash command that invokes `claude` or `clauded` with
`--resume`, `-r`, `--continue` or `-c` unless `KEEP_RAW_CLAUDE` is set to bypass it,
either in the environment or as an assignment on the segment that runs `claude`. It is
deliberately **not** exempt on `KEEP_PANE`: every hosted agent's Bash inherits that, so
exempting it would exempt exactly the sessions the guard exists for, and PreToolUse only
ever sees an agent's tool call, never the launcher's own exec. Plain `claude` with no
resume flag is untouched, and a mention inside `echo` or `grep` is not an invocation.

The guard reads a command, not a process tree, so it does not cover `npx claude
--resume`, a locally installed wrapper under another name, or bundled short flags
(`claude -rc`, which the parser sees as one unknown token). Those are gaps in the bar,
not holes in a boundary — the guard is a reminder that keeps the honest path honest.
The bypass is read only as a leading assignment on the segment that runs `claude`:
`KEEP_RAW_CLAUDE=1 claude --resume <id>` passes, `env KEEP_RAW_CLAUDE=1 claude
--resume <id>` is still denied.

`keep setup --shell` prints a zsh `claude()` that does the same for Owner's own typing;
`keep setup --shell --write` installs it in `~/.zshrc` between
`# >>> keep shell >>>` / `# <<< keep shell <<<` markers, replacing the block if it is
already there. It calls `command claude`, so the `clauded` alias expands to the function
and is guarded too, and `--dangerously-skip-permissions` passes straight through. The
launcher's own resume is told apart by `KEEP_LAUNCHER`, which Keep sets on the pane's
environment and which the function `unset`s before exec'ing; `bin/agent-launcher.js`
strips it again on the way into the agent process, so an agent's own shell calls never
inherit a bypass.

`keep resume` prints `keep open <id>` for every session; `keep resume --raw` prints the
bare `claude --resume` / `codex resume` form for a human who knows what it gives up.

## Bringing a node to parity

`keep node audit <name> [--json] [--all]`, run on the daemon node, compares the named
node with the daemon node: tools on the login `PATH`, each managed Claude and Codex
config directory (MCP servers, settings and hooks, `CLAUDE.md` and `AGENTS.md`, skills,
plugins), Pi, dotfiles, `~/bin`, repos and logins. It prints only what one side has and
the other lacks, and what differs; per-project memory directories, worktrees under
`~/wt` and tool locations are counted unless `--all` is given. Secrets are reported by
presence or hash only. The node's host answers the `inventory` verb
(`bin/node-inventory.js`); a host that predates it needs `git pull` and
`keep host reload` on that node. [Node provisioning](node-provisioning.md) is the
checklist for applying what the audit finds.

Parity is the node's half. The daemon's half is that every scheduler tick survives
sessions on another node: a scheduler must pass `bin/remote-node-schedulers.test.js`
before sessions of the kind it touches may move to a node. The rule and how to add a
scheduler to that suite are in
[node provisioning](node-provisioning.md#schedulers-and-sessions-on-another-node).

## Moving a session to another node

`keep move <#n|session-id> --node <name>` stops a Claude or Codex session where it runs,
carries its files to the other node, and resumes it there: the same conversation, on the
same account, with the same model and permission class. It is the fleet's way to drain a
machine (the laptop to `aws1` and back); `keep handoff` still moves a session between
accounts on one machine, and `keep transfer` is still the fresh portable continuation.

What moves is the session's own files under its account's config directory. For Claude:
the transcript `projects/<slug>/<sid>.jsonl`, its session tree `projects/<slug>/<sid>/`,
any `<sid>.superseded-*` tree under another project, and `file-history/<sid>/`. For
Codex: the root rollout `sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl` and the rollout of
every child thread whose parent chain leads back to it (from `sessions/` or
`archived_sessions/`), found by each rollout's own session_meta. What does not move for
Codex: the account's `session_index.jsonl` (thread titles), `history.jsonl`, its sqlite
state and anything else in the profile; the target keeps its own, and resuming by id
does not need them. An archived root is refused (unarchive it first). Every node
shares one home path, so they land at the same paths on the other machine. A node's host
answers the `artifacts` verb for this (`bin/session-artifacts.js`): it lists and reads a
session's files, stages what it is sent under `<configDir>/.keep-move/<tx>/` (4 MiB a
piece, verified by sha256 when whole, 2 GiB a move), and publishes by rename. A publish
never overwrites a file that differs from what the move carries unless a move put it
there or the session left it behind in an earlier move; a live transcript nobody moved
is refused, not replaced.

Before anything stops, the move refuses when:

- only one node is configured (`keep move needs another node`), or the session is
  already on the node named;
- the session is not a Claude or Codex session (a Pi session is refused by name);
- a node end's host predates the `artifacts` verb, or, for a Codex session, answers a
  version before 2 (update keep-tool there and reload its host);
- the model a Codex session runs on cannot be established: its pane's launch model, the
  `-m` its process was given, or the last `turn_context` of its rollout (read on its
  own node);
- the session's working directory does not exist on the target;
- the target does not have the session's account (its own configuration must name it
  and its directory must be there), or could not launch it: the target runs
  `prepare-launch` in its check form, which validates the shared home, the account and
  a shared setup's MCP configuration and writes nothing;
- a message to the session is still unconfirmed, an account handoff is in flight, a
  compaction has not restored its model, or a restart for it is queued, running or
  waiting for recovery; for Codex also while a compaction swap record exists for it
  (even one deferred for a rate limit) or its restart ledger tracks open background
  jobs, since both name the daemon's own files and do not follow a move;
- the session is working (its turn has not ended) and `--force` was not given;
- the session is live on a node other than the daemon's and `--force` was not given: the
  graceful stop proves background work from the transcript, which the daemon cannot
  read on another node, so a move off a node is Owner's forced stop for now. A Codex
  session on a node counts as live when its node's process table shows it (an agent
  holding its rollout open), pane or not.

A Codex session resumes on the target as `codex [flags] [-m <model>] resume <sid>`: the
permission flag its source process ran with (`--dangerously-bypass-approvals-and-sandbox`
or none; Keep's default when no process was read) and the model established above. Codex
reports its session-start only at its first turn, so the move also accepts the target's
own process evidence (the launch pane's process arguing `resume <sid>` or holding the
rollout open) and writes the pane record itself. `keep tell` to a Codex session on a
node other than the daemon's is still unsupported: open its pane, or move it back.

`--dry` prints what the move would do and changes nothing. `--force` is Owner's own move,
as with `keep handoff --force`: the source is signalled instead of being asked to exit.

The move is journalled in `.keep/session-moves/<tx>.json` through `stopping`, `copying`,
`staged`, `pinned`, `starting`, `verifying` and `done`. The source is proven stopped on
its own node before anything is carried, from that node's own process table (a table
that cannot be read proves nothing and refuses, on the daemon node too), and proven so
again before the flip and before every launch, on a recovery as on the first run. Every
step that gives a side up also lists that side's files and compares them by digest with
what the copy recorded: the flip and every launch check the source, an abandon after
the flip checks the target, and the cleanup releases the source's copy only if it is
unchanged. A side that changed since the copy refuses (`source changed since the copy;
nothing was flipped or launched`, `target changed since the copy; abandon refused`):
such a session has to be moved again with a fresh move (abandon this one first). The
session's location record
(`.keep/session-accounts/<sid>.json`) flips to the target exactly once, after the target
holds the verified bytes and before the target starts; the target is launched through
`keep open` pinned to the new record, and the move waits for its session-start. Then the
card's session link is rewritten with the new node, the stopped pane is removed, the copy
left behind is released for a later move back, and a move off a node also drops the
daemon's transcript mirror for it and the node's hook queue and cursor. A move onto a
node seeds the daemon's mirror of the target's transcript once the copy has landed, from
bytes the daemon already holds (its own file when the session leaves the daemon node,
its mirror of the source node otherwise), checked against the digest the target lists
for its copy and stamped with that copy's file generation, so the target's hooks send
only what the session appends after the move rather than the whole transcript over the
link. A seed that cannot be made is a move warning (`the daemon's mirror of <node> was
not seeded: …`), never a failed move; the target's hook client then asks the daemon
where its mirror ends before its first upload and starts there. A finished move
deletes its transaction directory on the target, `<configDir>/.keep-move/<tx>/`, and the
backups of any files its publish replaced go with it; only the provenance record
(`<configDir>/.keep-move/provenance/<sid>.json`) stays. A move that fails
is left `recovery-needed` with a message naming the node that holds the verified bytes
(the source before the flip, the target after it): `keep move --recover <tx>` continues
from the step that failed. A recovery after the launch asks the target whether it runs
the session: if nothing does, it is launched again under the same transaction; if it
does, its session-start is waited for once more, and a start that never comes is said
plainly. A pane for the session left open on the target with no agent proven in it
blocks both the recovery and the abandon, which name it: close it by hand
(`close pane <ref> on <node> first`); a pane back at its shell counts as not running. `keep move --abandon <tx>` before the flip clears the target's stage and leaves
the session where it was; after the flip it is allowed once the source is proven
stopped and the target proven not running the session, and it flips the record back to
the source (the second flip, journalled as `abandoned-back`), leaves the target's copy
released for a later move, and ends the move. While a move owns a session, `keep open`
refuses to resume it. The card's link to the session keeps its place: only its `node`
changes, committed locally without a push.

**Worktrees.** A session whose cwd is a `~/wt/` worktree needs that worktree on the
target before it can move: nothing carries a working tree, and the preflight refuses with
`cwd-missing`. Create it there from the same branch first — on the target, `wt` in the
repo's main checkout with the same slug, then check out the session's branch in it (push
the branch from the source first if it has unpushed commits) — and move the session
after.

The route is `POST /api/move-session`, for local and admin callers only; no node may ask
for a move, and the console has no button for it yet.

## Which account a fresh open lands on

`keep open <card> --fresh` with no `--account` lets Keep choose: the caller's own
account first (`KEEP_AGENT_ACCOUNT_ID`, which every launched session carries), then the
registry default, then the remaining accounts of that provider in registry order,
skipping any whose weekly or five-hour window is spent. An account nobody has a usage
reading for is usable but ranks behind one that is known to have room. The result line
names the account, and a second line says what was passed over. If every account is at
the wall the open is refused with each account's limiting bucket and reset time rather
than launching a session that could only report the limit back; an account merely under
the headroom floor is passed over for a better one but still launches when there is no
better one.

Every applicable window is judged and the worst one decides, so a comfortable week
cannot hide a five-hour window at 100%. Both providers are read: Claude's polled
`{limits, fetchedAt}` snapshot and Codex's `{windows, asOf}`, which carries the same
`week` and `5h` buckets. Their ages are judged differently — Claude's is polled, so half
an hour old means the poller is broken, while Codex's only advances when a Codex session
takes a turn, so it gets a six-hour horizon before it counts as unknown. Anything
unreadable — a missing weekly bucket, a bucket that is not a number, a snapshot that
throws — is unknown, and unknown never blocks a launch: the chooser falls back to the
registry default.

The window judged is the one the launch would actually spend. An explicit `--model`
names a per-model weekly bucket that applies to every candidate. With no `--model`, each
Claude candidate is judged against its own default model — the `model` in that account's
`settings.json`, which is the file `claude` itself reads at startup — because judging the
generic buckets alone read `claude/default` at `week 80%` as fine while a session opened
there ran on Fable, whose `Fable wk` bucket was at 100%, and could not take a turn. The
daemon resolves it per candidate (`accountBudgetModel` in `bin/serve.js`, injected into
`chooseOpenAccount`/`exhaustedWarning` as a resolver so the chooser stays pure);
unreadable settings, no `model` key, and a value `claude --model` would not take all mean
"no model", which is the generic behaviour. Codex accounts keep the generic windows.

Staleness has one exception. Usage only rises until a bucket resets, so a bucket that
read at or past 100% and whose `resetsAt` is still in the future is exhausted *now*,
however old the reading: a broken or rate-limited poller cannot have given the account
room back. That verdict applies to stale readings from both providers, with the bucket
as the reason and never as `low`. Everything else about a stale reading is unchanged — it
never proves room, and a spent bucket whose reset has already passed is unknown again.

`--account <id>` is still exactly as it was: that account, spent or not. A spent one
launches with a `warning:` line on stderr. Resumes are unaffected — a session is pinned
to its account, and `keep open <session> --account other` still refuses and asks for a
handoff. Only the CLI asks for the choice; the check scheduler, the reviewer launch,
restore, reopen and the console all name an account or take the registry default, as
before. See [agent accounts](accounts.md).

## Telling another session

`keep tell <card|session-id|#n> -m "..."` is how one agent session hands something to
another. Before it, the only routes across were `keep pane send`, which types raw
characters at whatever is on screen, and `keep nudge`, which is the reviewer's and
dry-run by default.

A card id resolves to that card's live linked session by the same candidate rule every
automated delivery uses; a card with no live linked session is refused with the
`keep open` that would start one, and a card whose sessions are all unreachable reports
the state of the most specific one rather than a count. Delivery goes through the same
send funnel as Keep's own messages — injection lock, draft and modal prechecks,
typed-text confirmation, delivery journal, transcript receipt — and every guard is
re-checked inside that lock immediately before the first character and again after the
text is on screen and before Enter, where the box must hold only this message.

A Claude session on another node has no transcript until its first prompt is submitted,
and its node answers a transcript read with `transcript-missing`. A send to such a
session (`keep open`'s opening message, `keep tell`, `keep pane send`, the console) does
not refuse on that: it judges the empty prompt from the screen and types into the
session's own live pane on its node, but only when every witness agrees the session never
had a turn (the daemon holds no mirror, no delivery journal and no turn-index rows for
it, the pane's account is the location record's and no handoff is staged), the pane is
the one a fresh listing named, nobody typed there in the last two seconds, and the box
is empty with no turn, dialog or trust screen showing. No delivery journal or receipt is
written for it, since there is no transcript to take one from, and a session with no
transcript yet ranks after every thread with turns when a card is told. A pane opened
for Owner to type into himself is refused. Any other missing transcript is still the
node's refusal.

The daemon builds the frame, so a caller cannot dress its message up as Owner or as
Keep: the recipient reads who sent it, which card they are on, and that it grants no
approval or permission. The card is validated as a card id and the text as plain
printable prose: control characters, escape sequences, DEL and bidi overrides refuse the
whole message rather than being scrubbed out of it, exactly as `bin/watcher-live.js`
refuses a watcher verdict, because a message that had to be rewritten is not the one its
sender wrote. Tabs, newlines and odd spaces are the exception and collapse to plain
spaces. Text that will not fit the 2000-character send cap, and anything passed with
`--message-file`, is committed to `.keep/handoffs/` exactly as a long `keep open -m` is,
and the pointer is sent instead. From a plain shell with no agent session the sender is
Owner's shell, with the same disclaimer.

It refuses, with a one-line reason and exit 3, a target that has exited, is waiting on
a usage limit, is mid-turn (`busy`), is waiting on Owner — a question, a plan, a
permission prompt, or a turn that ended with a question — is the reviewer or a
keep-spawned run, or is the sender itself. `--wait <duration>` re-asks every 15 seconds
while the reason is `busy` and nothing else, and exits 124 if the duration runs out.
`--dry` resolves the target, runs every guard and the brake read-only, and prints what
would be sent; it writes nothing at all, down to using a read-only session scan that
neither expires stale markers nor allocates console numbers.

A ledger at `.keep/tell.json` allows six tells per sender-recipient pair per rolling
hour and twenty into any one session per hour; Owner's shell is exempt from the pair
cap but not the per-recipient one. The slot is reserved under the registry lock before
the send and handed back only when the send failed before a single character reached
the pane. Once typing has started the reservation stands and the refusal is
`unconfirmed` — the message may be sitting in the recipient's input box or may have been
submitted with the receipt lost, so `--wait` never retries it and the tell-log line
carries `"delivery": "unconfirmed"`. Check the session before sending again. Before
giving up, the send asks the turn index (`.keep/turns.sqlite`) once: a user message in
that session's indexed transcript with the same text, recorded at or after the moment the
send began, confirms it even when the transcript receipt never landed. No earlier row
counts: the agent writes its line after Enter, on the same machine's clock, so anything
older is an earlier message with the same words (a repeated "continue"), not this one.
The index says only that such a message was recorded, not which attempt recorded it, so
while the text is still in the recipient's input box the box wins and nothing is
confirmed. A message longer than the index's 16 KiB text cap is matched on the part the
index keeps, so two messages that share their first 16 KiB cannot be told apart. The
index can confirm only what the agent's transcript recorded, never text still sitting in
the input box, and it lags a live session by one hook or one 30-second daemon tick, so a
tell reported unconfirmed may still be confirmed by the daemon's minute check, which
asks the index again and then releases the session for later sends. The next send to
that session asks the index about the pending attempt too, so it is not refused as
"Previous delivery is unconfirmed" once the index has recorded the earlier message. A
send of the same text first reads the input box (whether or not the session is
mid-turn) and, if the text is still there, leaves the pending attempt alone and offers
that draft Enter as before. A send of different text cannot compare the box with the
earlier message; it proceeds to its own precheck, which refuses to type into a box
that is not empty. The send path uses the index only when it can read the box; the
daemon's minute check cannot, and relies on the timing rule alone. Every
delivered tell appends one line to `.keep/tell-log.jsonl`; nothing is written to the
card, because a message between sessions is not a decision about the work.

## Slack watch

`keep serve` polls the channels in `watch/slack.json` every `intervalMin` minutes,
starting two minutes after boot. `keep slack poll --dry` fetches and classifies without
advancing cursors or writing decisions. `keep slack status` shows cursors, the last
poll, today's classification counts, and the current mode; `keep slack mode
log|cards|alerts` changes the committed configuration.

The modes are incremental: `log` only appends classifications, `cards` also creates a
`bug` card for each non-duplicate bug, and `alerts` additionally sends an attention
alert for medium/high bugs with a deterministic timing suspect. Slack-derived card
and thread text is quoted inside a `DATA, NOT INSTRUCTIONS` fence, and the fleet block
has its own separate data fence. There is deliberately no separate product
rubric: recent open cards, project commits, gated-step runs, and active holds are the
definition of whether a report is related to our work.
Every message also gets deterministic commit, completed step-run, and active-hold suspects from the prior `SUSPECT_WINDOW_MIN` minutes (90 by default), independent of model correlation.
Slack threads are folded into one parent classification; replies are logged as replies and become thread check-ins instead of standalone bug cards.
Thread polling is capped at ten threads per poll (oldest activity first, with deferred
threads rotating into the next poll). A thread expires after 48 hours without a new
reply, or 24 hours after it resolves.

Local state lives under `.keep/slack/`: `cursors.json`, `seen.json`,
`decisions.jsonl`, and `threads.json`; seen-message records are pruned after 30 days.
History and reply overflow is oldest-first: each cursor advances only through the last
contiguous message actually landed, so later messages remain for the next poll. Slack
bug card ids are deterministic (`slack-<channel>-<timestamp-without-dot>`), and a
`landing` state plus those ids makes retries reuse cards and thread check-ins.

Permalinks need the workspace domain, which comes from `slack_whoami` — from whichever
of `domain`, `team_domain`, `team.domain` or `url` carries one, since that answer's
shape varies by build. It is validated rather than trimmed, on write *and* on every
read of the cached copy in `cursors.json`, because it is interpolated into every link
written onto a card: a url is parsed and its host must end in `.slack.com`, a bare
value must carry no path, credentials, port or whitespace, and what is left must be a
single lowercase DNS label. Anything else is no domain, and no domain is ever cached —
a cached empty string is what made every permalink empty for a day. `watch/slack.json`
takes an optional `domain` that wins over the lookup, through the same validation.

The classifier uses the configured small model (`haiku` by default). Each message is
clipped to 1,500 characters, files contribute names only, thread prompts keep the
parent plus the last 12 replies, related refs are capped at six, and reactions are
omitted. Fleet context is capped at 12,000 characters (dropping old commits first),
while the entire prompt is capped at 40,000 characters. Whole message/thread units
that do not fit are deferred behind their cursors rather than dropped.

## Incidents

Alert posts are partitioned by **author**, not by channel. `watch/slack.json` gains an
`alertBots` map of Slack bot id to the project that bot reports for:

```json
"alertBots": { "B06PX3MFG5C": "ghost-server", "B0C1KEHNH8F": "castle-sandboxes" }
```

A message from one of those ids never reaches the classifier: its shapes are fixed, so
`bin/incidents.js` parses it deterministically and costs no model call. Every other
message keeps the Haiku classifier unchanged. Bot messages are still recorded in
`.keep/slack/decisions.jsonl` — one row per message, `kind: "alert"`, carrying
`signature`, `state`, `title` and `area` — so watcher history stays complete. Both
files are read on every poll, like `slack.json` itself; an absent `alertBots` map
(the default) leaves every message on the classifier path.

`watch/incidents.json` names the areas an alert can belong to:

```json
{
  "areas": {
    "sandboxes":  { "project": "castle-sandboxes", "match": ["^Sandbox ", "^Browser Service", "^Production sandbox"] },
    "app-server": { "project": "ghost-server", "default": true }
  },
  "quietMin": 60, "reopenHours": 24,
  "highTitles": ["Server Faults", "Sandbox Open Health", "Sandbox Host Capacity"]
}
```

`match` entries are regexes tested against the *parsed* title in file order; the first
hit wins. With no hit, the bot's project names the area; failing that the `default`
area takes it. An unparseable regex is skipped rather than thrown. `highTitles` decides
severity (`high` when a title matches, otherwise `med`; a human note is `low`). With no
file at all there is one `default` area, `quietMin` 60 and `reopenHours` 24.

Three message shapes are recognised, from the combined attachment title, attachment
text and top-level text (bot posts put their body in `attachments[0]`, ad-hoc posts in
the top-level text), with `&gt;`/`&lt;`/`&amp;` unescaped first:

- **Grafana** — a `**Firing**` or `**Resolved**` header followed by one or more blocks,
  each usually beginning `Value:` and carrying `Labels:`, `Annotations:`, `Source:` and
  `Silence:`. One Slack message can carry several alerts with different names and
  different states: `[FIRING:1, RESOLVED:1]` writes two headers with a block each, and
  `[FIRING:3]` writes one header with three blocks. Splitting happens on both, so each
  block becomes its own alert with its own labels; splitting on the header alone merged
  three separately stuck sandboxes into one signature and one card.

  Inside a section, blocks are found by their `Labels:` line, since that is what makes a
  block an alert while `Value:` is only how one usually starts. A boundary is either a
  `Value:` line whose own `Labels:` line follows within three lines and before any other
  field, or a `Labels:` line no such `Value:` line has claimed — the latter only when it
  is immediately followed by a `key = value` entry and reaches its own `Annotations:`
  line before the next field. Both halves of that rule are there because an annotation's
  text wraps onto lines of its own at column zero: a stray `Value:` or `Labels:` line in
  a description is body text, not a boundary, and would otherwise open a spurious
  label-less card or steal the labels of the block it sits in. For the same reason each
  field header is read once per block; a repeat is body text. A section with no boundary
  at all is read as one block.

  The title is the
  `alertname` label, never the Slack title, which is unusable on a grouped post. The
  signature is `grafana:<slug(alertname)>` plus every other label as sorted
  `key=value` pairs, minus `grafana_folder` and `team` — so each stuck `sandbox_id`,
  `failureReason` or `fields` instance is its own incident.
- **Internal** (ghost-server `internalAlerts.ts`) — `Alert "<title>" firing`,
  `Alert "<title>" resolved`, and `All alerts are passing`. The signature is the
  `castle-alerts-<id>` token when the message carries one, else
  `internal:<slug(title)>`. A resolved post carries only the title, so state keeps a
  title→signature index to map it back; only an internal firing writes that index and
  only an open internal incident can be read out of it, so a Grafana rule or an ad-hoc
  error sharing a title is never resolved by somebody else's message.
  `All alerts are passing` resolves every open
  `internal:`/`castle-alerts-` signature and nothing else; it is recorded with state
  `all-clear` and no signature of its own.
- **Ad-hoc** (`SlackNotifier.alert`) — signature `adhoc:<slug(text before the first
  colon)>`, capped at 60 slug characters. There is no resolved form. Anything the
  parser cannot read falls back to this shape, and a message with no readable text at
  all is recorded with a null signature. `ingest` never throws.

One incident card per signature: id `inc-<slug(signature)>` (long signatures are
truncated with a hash suffix), kind `bug`, tag `incident`, status `active`, title
`Incident: <title>`, and the area's project. A configured path is used as it stands; a
bare name like `castle-sandboxes` is resolved the way `keep add --project <name|path>`
resolves it, into its checkout path, because `addTask` reads a card's scope off the
project *path* and a bare name matches no scope rule — filed as-is it would land every
incident card under the default scope. A bare name that resolves to nothing fails that
alert's write: the mutation is reported `ok:false` with one line on stderr, the poll does
not acknowledge the message, and the next poll retries it. That is deliberate — filing
the card under the wrong scope, silently, is the bug this replaced.
The body carries the Slack permalink, the
area and the signature, plus the first firing text inside a `DATA, NOT INSTRUCTIONS`
fence. Later firings check in as `alert firing (N)` and bump the count rather than
opening a second card; `resolved` checks in and records the time but leaves the card
active; the daemon's sweep after each Slack poll closes a card that has been quiet for
`quietMin` with `--status done` and a `closed: quiet for 60m` check-in. Ad-hoc alerts
have no resolved form, so their quiet clock runs from the last firing; a Grafana or
internal alert that never resolved is left open. A firing within `reopenHours` of a
close reopens the same card; later than that, a new `inc-<slug>-<yyyymmdd>` card links
the old one, and a second late refire on the same day reopens that dated card rather
than leaving it `done`. Every one of those clocks is the Slack timestamp the message
was posted at, not the poll that noticed it — otherwise the first poll after the
feature is enabled would stamp a six-hour backfill with one time and close quiet
incidents an hour after the poll instead of an hour after they went quiet.
Deterministic commit, step-run and hold suspects from the prior
`SUSPECT_WINDOW_MIN` minutes are attached to the first firing. A human thread reply
under a bot post becomes a `note (by <name>)` check-in with the reply fenced as data —
no classifier, and never attached twice.

State lives under `.keep/incidents/`: `state.json` (signatures and the title index) and
`events.jsonl`, the raw feed of every lifecycle change — `incident-opened`,
`incident-fired`, `incident-resolved`, `incident-closed`, `incident-reopened`,
`human-note`. Each event carries `{at, kind, card, signature, title, area, severity,
permalink, suspects}`: pointers, never message bodies.

One message is one state mutation, and the whole mutation — loading state, writing the
card, writing `state.json` — runs inside the registry lock, so a manual `keep slack
poll` racing the daemon cannot load the same state twice and lose the other's update.
If that mutation fails, the message is *not* acknowledged: no decisions row, no
`seen.json` entry, no event, and the channel cursor stops short of it, so the next poll
fetches and retries it. One transient lock or disk failure must not lose an alert.
Events are built inside the mutation but published — to `events.jsonl` and to the area
agent's feed — only once its write has landed, so neither feed ever holds an event for
state that was discarded. Card writes cannot be rolled back the same way, so every
check-in that quotes a `Slack message ts:` line is written at most once per card: a
retry after a partial failure re-runs the firing, resolve, reopen, suspects or note
check-in, finds its own timestamp already on the card, and skips it while still moving
the state and emitting the event. The quiet close works the same way with an
`Incident close: <signature> opened <t> fired <t>` marker instead of a timestamp, so a
close whose state write failed is not appended to the card again by every later sweep;
a later firing is a new period with its own marker and does get its own line.

`keep incidents [--json]` lists the open signatures with their card, area, fire count
and last firing, and closes with a `pending: N incident write(s) failed at <time>:
<error>` line when the last poll could not land one (`{open, pending}` in `--json`).
That line is printed with nothing open too, since a poll that failed every write is
exactly the case with no open incident to show. The same failure fails the Slack
channel's health row for that tick — `N incident write(s) failed: <error>` — because
the message stays behind the channel cursor until the write lands, so nothing newer is
fetched meanwhile. `.keep/incidents/state.json` keeps it as `lastPoll: {at, failed,
error}`, written by the newest poll only, so a poll that started earlier and finished
later cannot clear a newer failure.

`keep incidents parse <file|-> [--json]` parses one Slack message — or
a JSON array of them — exactly as the poll would, which is how a new alert shape gets
debugged without polling.

`keep incidents close <card-id|signature> -m "why"` closes one that will never close
itself. The quiet sweep needs a `resolvedAt` to start its clock (or an `adhoc:`
signature, which has no resolved form at all), so a firing whose `resolved` message can
never match it stays open forever — which is exactly what the first live polls produced,
before Grafana blocks were split by their `Labels:` line: cards on merged signatures that
no single alert resolves. Diagnosed noise is the other case, and it is what the
responder's `keep decide close` is recommending. The target is a card id or a signature,
and an open signature wins over a closed one of the same name, so a reopened incident is
the one that closes. It is the sweep's own path: the same locked mutation, the same
`Incident close:` marker through the same `checkinOnce` (so neither a second close nor a
retry after a failed state write appends another `closed by hand` line — the card is
written before `state.json`, so that retry is a real case), `--status done` with a
`closed by hand: <why>` check-in, and the same publish, so `incident-closed` reaches the
area agent's feed. That last part is the one
place outside the daemon's poll that writes into a feed, deliberately: a hand close is a
lifecycle change like any other, and the agent's own console row is where it is read.
An unknown target and a missing `-m` are both errors, and nothing is written for either.

## Agents

An agent is a standing worker with a name, a recipe and a feed. Sessions come and go
underneath it: the record says who the agent is and which session is currently carrying
it, so a restart, a compaction or an account handoff changes the session and leaves the
agent alone. The fleet reviewer is the first agent; the incident-responder areas are the
next.

### Records

`.keep/agents/<name>/` holds one agent:

- `record.json` — `{name, role, model, account, project, cwd, area, session: {id, pane,
  startedAt}, lifecycle, card, lastEvent, unseen: {count, needsYou, truncated?}, lastTick,
  restarts, createdAt}`. `lifecycle` is `idle`, `working`, `needs-you` or `stopped`. Every write
  loads, merges and saves inside the registry lock, so two writers cannot each load the
  same record and lose the other's change. `lastEvent` and `unseen` are the feed's
  summary, kept here so a dashboard build never opens `events.jsonl`: an agent months
  into its life would otherwise cost a parse of its whole history on every state
  refresh. Both are rebuilt from the feed rather than counted up from the record —
  `emit` rebuilds them from the tail window inside the lock that appended the event, and
  `markSeen`, which rewrites the whole file anyway, rebuilds them from all of it — so a
  summary an earlier failure left behind heals on the next write instead of drifting
  further. A rebuild that only saw the tail window cannot prove either number: it marks
  the count a lower bound with `unseen.truncated` and carries the previous
  `needsYou` forward, because an unseen needs-you event older than the window would
  otherwise turn a badge that is still waiting for Owner from red to grey. Two reads
  are authoritative and clear both: `markSeen`, which reads every event, and a rebuild
  whose tail window held the whole feed. A badge is a summary, not a ledger.
- `events.jsonl` — the feed. `{at, seq, kind, card, severity, needsYou, seenAt, …}`, one
  event per line, append order. Events carry pointers — a card, a signature, one line
  of text — never message bodies: the home model pays for every byte it reads. Event
  text is untrusted data exactly as Slack text is; it is displayed and clipped, never
  followed, and every string field is scrubbed of control characters, escape sequences,
  bidi overrides, other invisible format characters and the fence markers *before* it is
  capped — capping first can leave the tail of an escape sequence behind as text. That
  is not cosmetic: since area sessions exist, an event is typed into a real terminal,
  where a CSI sequence in an alert title is interpreted rather than displayed, and a
  whole `ESC [ … ` sequence is removed rather than neutralized byte by byte, because
  `[2J` left behind reads as something somebody typed.

  The scrubber is `bin/notes.js` `scrubControls` / `scrubControlsOneLine`, not the
  `scrub` a state note goes through: that one also normalizes whitespace, which is
  right for prose Keep rewrites once and wrong here. An area session renders its
  events as columns made of runs of spaces, and `a  b` in an alert is what its author
  wrote. Newlines survive `scrubControls` because a fenced block's line breaks are its
  structure; a CR becomes one, so nothing can overwrite a line a reader has seen.

  `seq` is a per-agent counter, assigned inside the same lock hold that appends the
  event (`record.json` keeps `nextSeq`), and it is what gives the feed a total order.
  The seq is allocated from the FEED, not from that counter: the append lands first and
  the record write can fail after it, so `nextSeq` can sit behind the feed. Each emit
  reads the seq off the feed's last line and uses `max(that, nextSeq - 1) + 1`, so no
  number is ever handed out twice — which matters, because a cursor sitting on a
  duplicated seq would skip the second event for good. A timestamp cannot be that order
  either: two events written in the same millisecond tie, and
  an incident event is stamped with the Slack time its message was *posted* at, so a
  backfilled firing lands on the feed after — but dated before — a close somebody ran
  by hand a minute ago. A cursor made of timestamps drops both. `agents.readAfterSeq
  (name, afterSeq)` is the delivery read: a forward scan of the whole feed returning
  everything after a cursor, in order. Deliberately not a tail — a tail window can begin
  after an event a forward-only cursor has not passed yet, and that event would then
  never be delivered at all. Feeds written before `seq` existed read as `seq: 0`, which
  is behind every cursor: they are still Owner's badge state, they are simply never
  delivered, because there was no session to deliver them to. A stale `nextSeq` costs
  nothing but a wasted comparison: a reader that has caught up with the counter checks
  the feed itself rather than declaring it empty.

  **Seen-ness and delivered-ness are independent.** `seenAt` is Owner's badge state,
  set by `markSeen` when a row is opened. `lastDeliveredSeq` is the session's, set only
  by a confirmed send. Neither implies the other, and nothing reads one for the other. The feed is the truth and the record's summary is a cache of its end, so an
  `emit` appends before it touches the record, and the append alone decides whether the
  event happened: a summary that could not be written afterwards costs one line on
  stderr and nothing else — the event is still committed and a `needsYou` still alerts,
  because it is real either way. A read for the API, the CLI or an `emit`'s own summary
  parses only the last 256 KB, one byte before the window included so a record starting
  exactly at the window's edge is kept rather than mistaken for a cut one. A feed that
  is not there yet is empty; a feed that exists and cannot be read is an error, so
  `markSeen` fails (the route answers 500) rather than rewriting an intact feed from
  nothing. One unparseable line is skipped, not fatal.
- `notes.md` — the agent's own standing notes, owned by its recipe.

`.keep/` is otherwise ignored runtime state, so these are force-added the way
`.keep/artifacts/` is. Writes never commit on their own: they mark the agent dirty and
one flush turns a whole batch — a poll's worth of events, one `seen` sweep — into at
most one `keep: agents` commit. The prose recipe lives beside the cards, in
`agents/<name>.md`.

`.keep/agents/<name>/` is created by whatever launches the agent, and nothing else. An
event for a name with no record is dropped with one line on stderr: an event must never
be able to bring an agent into existence, or a typo in `watch/incidents.json` would
invent one.

### Events from incidents

Every incident lifecycle change is routed to the agent that owns its area:
`watch/incidents.json` `areas.<area>.agent`, defaulting to the area's own name. The
Slack poll and the quiet-close sweep both hand `bin/incidents.js` the real emitter;
everywhere else — the CLI, the tests — it stays the no-op it is by default, so only the
daemon's poll writes into a feed. Events are emitted only after the mutation that made
them real has landed, so a feed never holds an event for state that was discarded.

### Needs you

`keep agents emit <name> --needs-you` raises one alert through `bin/alerts.js`:
`level: 'attention'`, `key: agent:<name>:<card>`, `from: agent:<name>`. Quiet hours and
the per-key dedupe window are already that module's job, and nothing here adds a second
throttle. The badge in triage is a summary, not the only channel: a needs-you event both
alerts and shows up in the row.

### The Agents section in triage

`/api/state` publishes `agents: [{name, role, model, area, project, lifecycle, card,
session, lastEvent, unseen: {count, needsYou, truncated?}}]`. The `lastEvent` summary
carries the event's `seq` beside its `at`, because a reader holding a page of the feed
asks it whether that page is behind, and that is a question only `seq` answers: two
events can share a millisecond, and an incident event is stamped with the time Slack
posted it, so one written after the page in hand can be dated before it. The console's triage queue
renders an
**Agents** group under Running & waiting and above Pinned, and only when that array is
non-empty. The group is not gated on the Running toggle: collapsing the working sessions
leaves the fleet listed. One row
per agent: the name, the lifecycle (`idle` / `on <card>` / `needs you` / `stopped`), the
last event as a one-liner with its relative time, and a badge with the unseen count —
red when any unseen event asked for Owner, grey when they are only news, absent at zero.
Clicking a row opens the agent on the stage; opening is the acknowledgement, so it posts
`seen` and re-reads the feed. A pane the host still lists as alive goes on the stage
through `ctx.openReviewPane`, in the one slot the stage terminal already owns: there is
never a second view of the same PTY. An agent whose pane is gone opens as its session
instead (`ctx.openReviewSession`), where the stage shows the same transcript tail a
Running row falls back to; an agent with neither says so in a toast.

The selection then belongs to the Agents row itself. An agent's session is not a queue
item at all: `retainedSelectionItem` refuses to rebuild a retained row for a session that
is an agent's or the reviewer's (and spends the pane stand-in `openReviewPane` left
behind), so neither `triageItems()` nor the queue's own list ever carries an invisible
last item for `j`/`k` or the number keys to land on. `queueSelection` then clears the
index: the Agents row is the only row marked `.sel`, and if the same session is also
listed under Recent that row stays unmarked. With no index, `j`/`k`
start again from the top of the queue, and the stage renders `stageItem` instead of
`active[selected]`, the way focus mode renders the item it is holding.

`queueSelection` asks `selectedKey` before it asks the stage's item, and only a key a
group actually lists counts (`selectedRowItem`). That is what lets Owner leave an agent:
`j`, `k` and a click move the key and nothing else — `state.currentItem` stays the agent's
until `renderStage` replaces it — so reading the item first would detect the same agent on
the next render and clear the index again, for ever. It also settles the Recent listing of
an agent's own session: the Agents row carries it until Owner selects that row by name,
and then that row does. A key that names nothing is a row that has left, not a licence to
select its neighbour, so the agent keeps the stage. `shellProject` follows the same order
for the rail's New session button, because `renderRail` runs before the queue reconciles
the index and would otherwise bind it to the previous selection's project.
`agentForStage(ctx, item, session)` decides whose work is on the stage: it matches the
pane against `agent.session.pane` first across every agent, because that is the terminal
actually on screen and a record an in-place restart has moved on from may still name the
session, and only then falls back to the session id for an agent whose pane is gone.
`agentStageItem` rebuilds that session into the stage's item on every render, so the
heading, brief and actions are the session's own rather than a stale stand-in.

Beside that terminal, `.stage-body` is a row holding `.stage-terminal` and an `<aside
class="stage-agent-log">`: the agent's **Log** — the last 20 events, newest first — under
a head naming the agent, its lifecycle and its last event. The aside is part of the stage
skeleton and is only hidden, never added or removed, so a log appearing cannot rebuild the
host the terminal is mounted in; xterm's own `ResizeObserver` refits the terminal when the
column appears, collapses or goes away. One control in its head collapses it to that
control alone, remembered in `localStorage` under `keep-agent-log-collapsed`.

Reads all go through `readAgentFeed`, which allows one per agent at a time: a click and
the render it causes must not each post `seen` and read the feed, and two reads in flight
can land out of order. `agentFeedDue` decides when to read again — nothing in hand, every
read so far refused, or a page the row's own `lastEvent` has outrun (`agentFeedBehind`) —
and a read that brings nothing new (a refusal, the same page again, or an empty one while
the record still remembers an event) doubles the wait from five seconds up to a minute, so
an unreadable feed costs one request now and then rather than one per poll, and is never
given up on. A refused read keeps the page in hand rather than caching an empty one: an
empty log is a lie about an agent that has events.

"Behind" is decided by `seq`, falling back to `at` only for a feed written before `seq`
existed (everything in it reads as `seq: 0`). Comparing clocks would call a tied or
backdated event nothing new and leave the column a page behind for good. A page that
answers the newest read always replaces the one in hand, whatever its `seq`: a rotated or
truncated feed is the log now, and refusing a lower `seq` for ever would freeze the column
on a page that no longer exists. Ordering is settled by a read counter instead — an answer
a later read has already overtaken is dropped — so a slow response cannot roll the log
back without also refusing a rotation.

The empty-state counts
read "N running · N pinned · N agents", the last only when there is one. Agents are never
counted or dismissed as queue items, and the keyboard's own selection never lands on one:
the Agents row is marked selected only to say whose pane the stage is showing.

A session an agent is carrying is marked `session.agentName = <name>` when its id or pane
matches a record's — or when the pane's `meta.agentName` names one, which is authority for
a pane a record has not caught up with. It is deliberately not `session.agent`: on a
session, on pane meta and on a process row, `agent` already means the provider, claude or
codex, and `meta.agent` keeps saying which harness is running in the pane. `agentName`
sits beside the `session.reviewer` flag it does not replace. Both mean the
same thing for the console: an agent's session is not a working session, so it offers no
transfer, handoff, restart or relay control, and it is listed under Agents rather than
under Running & waiting.

The fleet reviewer's row, `fleet-reviewer`, is derived read-only at state-build time from
the reviewer the dashboard already computes plus that session's pane. Nothing about it is
written to disk, `.keep/reviewer/<id>` keeps owning the reviewer's own state, and the
reviewer emits no events in this slice, so it never carries a badge.

### API and CLI

- `GET /api/agents/<name>/events?limit=50[&unseen=1]` — the feed, newest first.
- `POST /api/agents/<name>/seen` — stamps `seenAt` on every unseen event at or before
  `until` (default now). A name that is not a usable agent name is a 400, never a path.
- `keep agents [--json]` lists the records with lifecycle, session and unseen count.
- `keep agents events <name> [--unseen] [--limit N] [--json]` reads one feed.
- `keep agents emit <name> --kind <k> [--card <id>] [--severity low|med|high]
  [--needs-you] -m "text"` is how an agent session writes its own feed.
- `keep agents seen <name>` marks everything seen; this is what the console posts.

## Area sessions

An area with `"session": true` in `watch/incidents.json` gets one standing
incident-responder session, kept by `bin/area-session.js`. Watching itself stays
deterministic and model-free — nothing in that module decides anything about an alert.
It keeps one session alive per area, hands it the events the parser has already
recorded, and closes it again once the area is quiet. In slice 1 only `sandboxes` is
built, and it diagnoses only: no edits, reverts, restarts, deploys or terraform, and
nothing written through the MCP.

The tick runs once about twenty seconds after the daemon starts and then on the Slack
poll's `afterPoll` hook, right after the quiet-close sweep and after the poll's events
have reached the area's feed — those are exactly what it reacts to. `afterPoll` is
synchronous and not awaited, so the tick is started and left to run: it opens panes and
types into terminals, and a poll must never wait on that. Nothing in it throws into a
poll, and each area's tick is independent of the next.

Three steps, always in this order:

**Launch.** The area's project basename is the repo, and every area's session lives in
the long-lived worktree `~/wt/<repo>/responder` — `~/wt/castle-sandboxes/responder` for
sandboxes, never the main checkout. It is created out of process through `wt new`
exactly as `self-repair.js` creates its worktrees (`wt.createWorktree` is synchronous
end to end and would stall every scheduler for ~30 s), a finished tree is reused as it
stands, and a half-built one is removed through `wt` and rebuilt — which is why the tree
is only touched when no session is live in it. `agents.ensure` then creates the record
(`role: incident-responder`, `model: opus` (the alias, so it tracks the newest Opus), the area's `account`, project, cwd, area),
because an event for a name with no record is dropped. If no session is live, one
interactive session is opened through serve.js `openSession({fresh: true, cwd, agent:
'claude', accountId, model, requestId, message: <bootstrap>})` with `launchEnv:
{KEEP_AGENT: <name>}` and `launchMeta: {agentName: <name>}` — both internal seams,
neither settable over HTTP — and `{id, pane, startedAt}` is stored on the record. The
bootstrap is three reads in order: `agents/<name>.md`, `.keep/agents/<name>/notes.md`,
`keep incidents`. It deliberately does **not** tell the session to read its unseen
events: the bootstrap is not a delivery, and treating it as one meant either
acknowledging events nothing had handed over or handing them over twice. The first tick
after the session is live delivers whatever is after the cursor, which is the one path
that acknowledges anything.

Never two sessions for one agent, which is the invariant the whole module is built
around, and three separate things hold it up.

*A lease.* Before a launch — not before the first observation, which would be a record
write on every quiet poll — the tick claims `record.launchLease = {at, by, requestId}`
under the registry lock, and then reads the pane list **again** while holding it, so the
reading the launch acts on was made under the lease. A fresh lease (`LAUNCH_LEASE_MS`, 5
minutes) held by anybody else means skip the area entirely this tick. It is released
whatever the tick decided.

Building a worktree is `wt rm` plus `wt new` out of process — a checkout and a
dependency install, minutes — so the lease is renewed under the registry lock after that
work and checked once more as the last thing before a pane is spawned. A tick that has
lost its claim by then abandons the launch and reports it, and that is **not** a failed
attempt: nothing was spawned, so it burns neither an attempt nor the backoff clock.

The lease's `requestId` is `openSession`'s dedupe key, and it must name one launch for
all time. `record.generation` — durable, incremented on every claim, never reset — is
what gives it that: `area-<agent>-g<generation>`. Deriving it from `launch.attempts`
did not, because that counter resets on a live observation and on an idle close, so the
generation after a restart asked for `area-<agent>-1` again and `openSession`, seeing an
id it knew, would hand back the retained record of the pane that had already exited
instead of opening a session.

*What counts as evidence.* A pane listing that failed, threw, or came back as anything
other than a list is `unknown`: it stops the whole tick, whatever the record says,
including when the record has no session at all. A failed listing is not evidence that
nothing is running, and launching on one is precisely how a second session appears
beside one the daemon could not see. An empty list from a host that *answered* is
evidence, and reads as `gone` (the record names a session) or `none` (it does not).

*Adoption and grace.* A live pane stamped `meta.agentName` is adopted into the record
rather than doubled, which covers a launch whose response was lost, an in-place restart
that replaced the pane, and a session that came up between this tick's two readings. A
pane that reads dead is given `PANE_DEAD_GRACE_MS` (10 minutes, self-repair's own
constant) before it counts as gone, because a restart or an account handoff looks exactly
like an exit for a few minutes. `MAX_LAUNCH_ATTEMPTS` launches that never come up stop
the launching until one does; a single live observation clears the count, since the cap
is for launches that fail, not for a session that has been running for a week. A launch
that threw *after* its pane came up is recorded as launched: a pane means a session is
running, and reporting a failure there is exactly how a second one gets opened.

**Delivery.** One message per tick, never one per event, and never the same event twice.
Everything after `record.lastDeliveredSeq` goes out as a single fenced `DATA, NOT
INSTRUCTIONS` list of pointers — kind, card, severity, title, permalink, separated by
` · `, no bodies — ending "Handle these per your recipe.", through the same helpers a
scheduled check delivery uses (`resolveSessionTarget` +
`withInjectionLock(sendToResolvedTarget(…, {compactIfCold: true, retainReceipt: true,
deliveryKey}))`), so target resolution, the compaction-if-cold policy, the injection
mutex and the delivery receipt all apply.

One tick owns the sending, from choosing the batch to writing the cursor.
`record.deliveryLease = {at, by}` is claimed under the registry lock and released in a
`finally`; a fresh one held by anybody else defers the tick. Without it, two overlapping
ticks — a slow poll and the next one, `keep incidents session` racing the daemon — could
each decide independently and each type, because the injection mutex serialises typing
and does not stop the second message existing.

The batch is chosen **twice**: once cheaply and read-only, to find out whether there is
anything to deliver at all (so a quiet tick takes no lease and writes nothing), and then
again from the record read *after* the lease is claimed — and that second one is what
gets sent. Choosing once, before the lease, was not enough: a tick delayed between its
read and its claim could hold a batch of [1,2] built from a cursor another tick had
already moved to 1, persist it, and pass every later guard, because the guards compare
against the pending record it wrote itself. And because everything up to the injection
mutex was still decided outside it, the record is read once more inside it: a cursor past
this batch, or a pending batch that changed, aborts the send.

The lease is ten minutes, not two, and it is **renewed** on a 30-second timer underneath
the awaited send (the timer is unref'd and cleared in the `finally`). A send is not the
quick thing it looks like: `compactIfCold` can spend minutes compacting a cold session
before a character is typed, and a two-minute lease expired underneath exactly that.
Ownership is re-checked immediately before typing — through the transport's `beforeType`
hook, which also fires before it re-submits a recovered draft — and again when the send
returns. A lease lost during a send means the cursor is not ours to move: the batch stays
`sending` for whoever holds it now.

The batch is bounded by the size of its own **rendered message** (`DELIVERY_BODY_MAX`,
6000 characters), not by a count and not by the raw lines: `dataFence` prefixes every
line, adds its wrapper and rewrites each `KEEP_INPUT` to `KEEP_INPUT_DATA`, so text that
fitted as lines could arrive over the limit. Events are added in seq order while the
rendered message still fits and the rest wait for the next tick. A batch is never
clipped, because a clipped batch would acknowledge an event the session was shown half
of — the fence is handed an unreachable limit, and the batch builder is what guarantees
the fit.

The batch is **persisted before a character is typed** — `record.pendingDelivery = {key,
firstSeq, lastSeq, offset, count, text, at}` — and a tick that finds one retries *that*
batch. It carries the **rendered text**, not just the seq range: the receipt is keyed on
the text, and a batch rebuilt from the feed loses the "N more events are queued"
sentence, whose count is gone by the next tick. Same range, different message, receipt
nobody can find, message typed twice.

**What a delivery is worth is our own state, not the transport's receipt.** The transport
is called with `retainReceipt: false`: its receipt store answered "did this arrive" from
outside anything we hold a lock on, and it files a *received* receipt for a delivery it
only assumed, so it could never be provenance. What it keeps either way is its journal,
which is what recovers a draft that was typed but never submitted, and that is what it is
good at.

`record.pendingDelivery.state` is the provenance instead, and it moves one way only:

- **`sending`** — written under the registry lock *before* a character is typed, together
  with the text. A tick that finds this reaches the transport again with the same text;
  the transport recognises its own journal and submits the draft rather than retyping.
- **`confirmed`** — written in the **same locked write** that advances the cursor, so no
  reader can ever see one without the other. It stays on the record afterwards as the
  record of what was last delivered, and the next batch overwrites it.

A `confirmed` batch the cursor has not passed can only mean the write that would have
moved the cursor never landed, so the cursor moves on the next tick and nothing is typed.
It is left on the record rather than cleared — it is the record of what was last
delivered — which is why the restart guard counts only a batch whose state is not
`confirmed` as outstanding work. Counting every `pendingDelivery` meant the first
successful delivery pinned the session open for good.

A `sending` batch being retried is asked about one more thing first: a send that *was*
confirmed finishes the transport's journal, so a daemon that died in the moment between
the transport returning and our state write leaves nothing for the journal to recognise —
and the transcript is the remaining witness. `transcriptShows` (`delivery.received` over
the session's transcript, shared by `area-session.js` and wired into both the daemon tick
and `keep incidents session`) is asked once per stuck batch, on a retry only, because it
scans a transcript.

That check is **not optional**. When it is missing, throws, or answers anything other
than a plain yes or no, the tick defers with one line on stderr and leaves the batch
`sending`: without an answer there is no way to tell a batch that arrived from one that
never did, and both guesses are wrong in their own way — typing doubles the message,
acknowledging loses it. A tick that could not be wired for recovery is a tick that must
not retry.

And what it matches has to be specific to one batch, which is why **every delivered
message carries its own key on its first line**: `[keep] delivery
agent:<name>:seq:<firstSeq>-<lastSeq>`. Two batches can render identically — the same
event re-emitted, a single event whose line matches one delivered an hour ago — and an
older entry in the transcript would then answer for a newer batch, acknowledging events
that were never sent. With the key in the message, a transcript entry can only ever
answer for itself. The same key is `deliveryKey`, so the transport's own journal identity
is stable across a retry.

Only a transcript-confirmed result counts as delivered. `delivery.deliver` also reports
`assumed-delivered`: its journal expired with the text known to have reached the pane and
no transcript ever confirmed it. That is a guess, so the batch stays `sending` and is
offered again. **After `ASSUMED_ATTEMPT_LIMIT` (3) of those the cursor moves past it
anyway** — the session has probably had those events three times, and retyping them
forever is its own failure — and the uncertainty becomes a `delivery-uncertain` event on
the feed (severity `med`, no card, naming the seq range). It lands after the cursor, so
the next batch carries it into the session and the agent row shows it. The queue never
wedges on one batch.

The cursor advances only on a confirmed send. A mid-turn
session (`endedTurn !== true`), a session showing a question, plan or permission prompt,
a send that throws, a send that reports only part of the message accepted, an assumed
delivery, and a lease lost mid-send all leave the batch `sending` and offer it again next
tick. A cursor write that fails after a confirmed send is reported and left to the
transcript check above. A session launched this tick is delivered nothing — it has the
bootstrap to read. No delivery ever opens a second session.

`record.lastDeliveredOffset` rides along with the cursor: the byte just past the last
delivered line, so the next forward scan starts there instead of re-parsing a feed
months long. `agents.readAfterSeq` trusts it only when it really is a line boundary —
the byte before it is a newline and it is inside the file — and falls back to a full
scan otherwise, which is what keeps a `markSeen` (it rewrites the whole feed and moves
every offset) or a truncation from silently skipping events. A bad offset costs work,
never an event.

**Restart from the log.** When **none of the agent's areas** has an open incident, the
session is live and idle (not mid-turn, not waiting on Owner) with nothing undelivered
and nothing pending, and `restartAfterIdleMin` has passed, the session is closed and
`record.session` dropped; the next tick opens a fresh one from the bootstrap. Nothing is
lost, which is the point: the incident cards, `notes.md` and the event feed are the
memory, and a fresh session reads all three.

Every area routing to the same agent counts, because an agent whose second area is on
fire is not idle however quiet its first is. Two areas that both set `session: true` and
name one agent would fight over one record — two launches, two cursors, two restart
clocks — so that is a config error: it is reported once on stderr and **both** areas are
skipped rather than half-served.

Idle is measured from real activity, not from `startedAt`: the latest of the session's
start, the last confirmed delivery, the transcript's `mtime`, and the pane's own last
input/output. A session that has been investigating for nine hours without a delivery is
not idle. The close is `closeIdleSession` and nothing behind it — graceful only, never a
signal, because nobody asked for this close — and it is handed `{automatic: true, idleMs:
restartAfterIdleMin * 60e3}` rather than zero, so its own elapsed-activity checks do
their work instead of being waived. A refusal (an unsent draft, a modal, a pending
question, a viewer who attached, recent pane input or output) is final for that tick and
the session keeps running.

**Daemon hygiene.** A tick that changed nothing writes nothing: no `lastTick`, no lease,
no commit. It does read the feed — one event's worth, starting at the saved offset, so on
a quiet tick that is a stat and an empty read at the end of the file. `nextSeq` would
have been cheaper still and is deliberately not trusted for it: it is a cache of the
feed's end, and an emit whose record write failed leaves it behind, so believing it would
declare a feed with an undelivered event in it empty. `flushCommits` is asked for exactly
once per tick that did change something, and never otherwise.

### Known limits

Two things are understood and deliberately not fixed here; they are their own card.

- **A stale feed offset can coincide with a real line boundary.** `lastDeliveredOffset`
  is validated by checking that the byte before it is a newline, which catches a
  truncated or shortened feed. It cannot catch a *rewritten* one — `markSeen` rewrites
  every line, and if the new file happens to have a line boundary at the same byte, the
  scan would start from the wrong event. The seq check still applies to everything it
  then reads, so the failure mode is skipping events whose lines moved before that
  offset, not delivering the wrong ones. A generation counter on the feed, bumped by
  every rewrite and stored beside the offset, is the fix.
- **`readAll` is unbounded and the commit is synchronous.** A forward scan from the
  cursor reads to the end of the file in one buffer, which is fine for a feed of
  one-line events and unbounded in principle; and `flushCommits` runs `git` synchronously
  on the daemon's event loop when a tick changed something. `self-repair.js` has the same
  shape, so this is a fleet-wide question rather than an area-session one.

### Configuration

`watch/incidents.json` areas take four keys beyond the parser's own:

```json
"sandboxes": {
  "project": "~/castle/castle-sandboxes",
  "match": ["^Sandbox ", "^Browser Service", "^Production sandbox"],
  "session": true,
  "account": "claude-secondary",
  "restartAfterIdleMin": 120,
  "agent": "sandboxes"
}
```

`session` defaults to `false` — watching works without a standing session and turning one
on spends a model account, so it is Owner's switch to flip, per area, and only after the
parser has run clean. `account` defaults to `claude-secondary`, `restartAfterIdleMin` to
120, and `agent` to the area's own name. Several areas may share one `agent` so their
events land in one feed, but only one of them may set `session: true`: two that do are a
config error and neither runs (see **Restart from the log**).

### The recipe

`agents/<name>.md` is registry prose, read by the session on every bootstrap and Owner's
to edit. This repo ships the version the code was written against at
`docs/agents/<name>.md`, and the tick installs it into the registry when there is none.
An existing file is never overwritten, so Owner's edits survive every later tick.
Not every recipe under `docs/agents/` is an area agent's: `redash-daily.md` is read by
the scheduled-check session a card opens every morning (its `--check` text points at the
file), keeps its memory in that card's check-ins, and has no record or feed.
`.keep/agents/<name>/notes.md` beside it is the agent's own standing notes, owned by
that recipe.

### `keep incidents session`

`keep incidents session <area> [--dry] [--json]` runs one tick for one area by hand and
prints what it launched, delivered and restarted. `--dry` performs nothing at all — no
lease, no worktree, no record, no recipe, no session opened, nothing typed, no cursor
moved and no receipt consulted (`statusForText` is not a read: when it finds a confirmed
retained entry it files the receipt and unlinks the journal, so a dry run reports the key
it *would* have checked instead) — and reports what it would have done, which is how the
switch gets checked
before it is flipped; it is also the only form that runs for an area whose `session` is
`false`, since actually opening a session for a disabled area would be flipping that
switch from the command line. Both forms get the same seams out of `serve.js` (loaded on
first use, so an area that is off costs nothing): a dry run that could not ask the
terminal host what is running would have nothing true to say, and performing nothing is
`bin/area-session.js`'s own guarantee — every write, send and close is gated on it —
rather than something withholding a dependency buys.

Asking the host what is running opens the connection `serve.js` caches, and that socket is
a live handle: the daemon wants it for its whole life, a command that prints a report and
stops does not, and left open it kept the process sitting in the event loop after the last
line was printed. The command hangs up with `serve.closeHostClient()` in a `finally`,
whether the tick returned or threw, and only when something actually reached for
`serve.js`. Not `process.exit()`: stdout to a pipe is asynchronous on macOS, so exiting
there would truncate the report it just wrote.

## Steps

Step commands run with stdin closed, so anything that prompts dies at the prompt. Write
every step to be non-interactive: Terraform saves a plan with `-input=false -out` and
applies that plan file (no approval prompt); Packer already is. The first Codex run of the
terraform step died at Terraform's "Enter a value" prompt for exactly this reason.

Gated steps serialize slow or exclusive shared build and deployment operations. A
committed `steps/<project-basename>.json` registry names the project and each step's
owned path globs, optional `ignore` globs, source policy (`landed` or `any`), command,
optional preparation and artifact pattern, follow-up instruction, default claim
duration, and—for landed steps—a dedicated sibling worktree. Local run history, waiters, and mirrored command
logs live under `.keep/steps/<project-basename>/` and are never committed.

Run `keep steps <project>` before changing a governed path. It shows the last recorded
artifact, current claim and run, waiters, and up to 20 local `origin/<default>` commits
that have not reached the last recorded run; `--json` exposes the same snapshot. Claim
with `keep step claim ... -m "why"`, add `--wait` to queue a one-time session
notification behind another holder, and release the claim by finishing with `keep
step done` or `keep step fail`. A `running` ledger record blocks a new claim even
after its hold expires; `step claim --force` explicitly abandons that run and warns.

The claim is the ownership: whoever holds it owns the lane, and `step done` or
`step fail` from another session is refused (exit 5) unless it passes `--force`.
A manual terminal has no session and is Owner at the keyboard: it is never refused,
and it releases whichever claim is on the lane.
Runs themselves are single-phase. `keep step run` records the run, executes the
command, and finishes it the moment the command exits — exit 0 marks the run `done`,
releases the claim, notifies waiters, and checks attributed cards in; a non-zero exit
marks the run `failed` (terminal, with its exit code and log path), keeps the claim so
the session can fix and re-run, and checks the claim's card in with the attempt. Only
`running` is unfinished, and `keep steps` flags a run left running for hours by a
session that has gone quiet.

`keep step done <project> <step>` records a completion by hand: with a `running` run it
refuses (exit 5) and names the owning session, since that command may still be going,
and `--force` finalizes that run as done for a session that died after it succeeded.
With nothing running it appends a completion run from `--sha` or `origin/<default>`,
releases the claim, notifies waiters, and checks cards in. `keep step fail <project>
<step> -m "why"` resolves the lane instead: it marks any `running` run failed with that
note, releases the claim, and notifies waiters that the step failed; with no running
run, no claim, and no waiters there is nothing to fail and it says so.

`keep step run` mirrors the command's output live and into the local run log. A
failed step prints its log path; read it before re-running. A
`from: any` step runs only in the project or one of its linked worktrees and records
HEAD plus dirty state; `--sha` there is an assertion, refused when HEAD is not that
revision, since the step cannot pin a checkout it does not own. A `from: landed` step first fetches `origin`, refuses a revision
that is not an ancestor of `origin/<default>`, and creates or cleanly re-pins the
registry's detached worktree to that exact SHA. This matters for build scripts that
copy the working tree: the recorded artifact is then provably built from the pinned,
landed revision instead of whatever happened to be in another checkout. Successful
runs release the claim, notify waiters, and check attributed cards in with the
artifact and registry `next` instruction.
Failed waiter deliveries stay queued with their latest error and retry count. The
next `step done` or `step fail` retries them, and `keep step notify <project> <step>`
retries the last completed run's notification without rerunning the step.

Example registry entry:

```json
{
  "project": "~/work/example",
  "steps": {
    "image": {
      "title": "Build the image",
      "paths": ["packer/**", "host-agent/**"],
      "from": "landed",
      "worktree": "~/work/example.step-image",
      "prepare": "yarn install --frozen-lockfile",
      "command": "cd packer && ./build.sh",
      "artifactPattern": "ami-[0-9a-f]{8,}",
      "next": "update the affected pin and follow the canary procedure",
      "defaultHold": "+2h"
    },
    "terraform": {
      "title": "Apply the infrastructure",
      "paths": ["terraform/**"],
      "ignore": ["terraform/terraform.tfstate", "terraform/terraform.tfstate.backup"],
      "from": "landed",
      "worktree": "~/work/example.step-terraform",
      "command": "cd terraform && terraform apply -input=false plan",
      "defaultHold": "+1h"
    }
  }
}
```

`paths` decides which landed commits count as work the step has not picked up yet, and
`ignore` (same glob semantics) takes them back out: a commit whose only matching files
are ignored does not count as pending, is not part of the range a completed run is
credited with, and contributes nothing to the touched directories in `keep steps`. This
is for state a run writes back itself — the tfstate commit that follows every Terraform
apply is the reason the flag exists.

`"since": "daemon"` measures pending work from the commit the running Keep daemon
loaded (recorded in `health.json` at start, shown by `keep health` as `code <sha>`)
instead of from the step's last recorded run, so a deploy by `wt land` or by hand clears
it as well. A run of such a step is recorded at the main checkout's HEAD after the
command, since the command is what moved it. `"guard": false` keeps the claim as a lane
to queue in without the pre-bash guard refusing the command outside it. keep-tool's own
deploy is registered this way on a host (`~/keep/steps/keep-tool.json`):

```json
{
  "project": "~/castle/keep-tool",
  "steps": {
    "deploy": {
      "title": "Deploy keep-tool to the running daemon",
      "from": "any",
      "since": "daemon",
      "guard": false,
      "command": "git -C ~/castle/keep-tool pull --ff-only && keep restart-daemon",
      "defaultHold": "+15m"
    }
  }
}
```

`keep steps keep-tool` and every session start in the checkout then say how far behind
origin the running daemon is and who holds the deploy. A self-repair session may not
`keep step run`: the command runs out of its guard's sight.

Long messages injected into sessions are typed in paced chunks and, for Claude
sessions, verified against the transcript after submit; truncated delivery is logged.

## Scheduled checks

Nothing in Keep runs a model headless. When a scheduled check becomes due, Keep first
sends its recipe into the most recent eligible linked Claude or Codex thread; when there
is none, it opens a fresh interactive Claude session on the card and types the same
instruction into it. A successful delivery — to a thread or to a session Keep opened — is
recorded in `.keep/runs/<taskId>.delivered.json` for that exact `check_after`, so daemon
restarts do not redeliver it; the recipient must check in with `--clear-check-after` or
reschedule it. An open linked thread remains eligible even after hours of inactivity. A
thread that is mid-turn or waiting on the owner defers the check for 120 scheduler ticks
(about two hours) by default (`KEEP_DELIVER_MAX_DEFERRALS`) before Keep opens a session
instead; if no linked pane is open, Keep opens one immediately.

A stamp written for a session Keep opened carries a two-hour TTL, unlike a thread
delivery stamp, which stands until the schedule moves: a thread has Owner watching it,
while a session Keep opened by itself has nobody to notice that it died. When the TTL
passes with no result, the stamp is discarded and the card is simply due again.

Keep opens at most one scheduler session per card per local day and three per scheduler
tick. That bookkeeping is persisted to `.keep/runs/scheduler-state.json`, so a daemon
restart does not hand every card a second pane. The account it spends is the automation
pool's pick for the `checks` purpose (`docs/accounts.md`, **Automation pool**;
`automationAccounts.checks` is a preference), and a spent pool names its best member
so the deferral below runs against a pool account rather than the owner's default. It
opens none at all while that account is out of budget for the check model — its week,
its 5h window or the model's own weekly bucket under the headroom minimum: that records one `check deferred`
check-in per card per day (at most three *written* notices a tick; a card already
noticed today costs nothing, and the rest are logged only),
changes neither the status nor the schedule, and leaves the card overdue for the tick
after the reset. An *unreadable* usage snapshot is not treated as no budget — that would
stop every card on the board.

A deferral is correct on its own and invisible in aggregate, so it has a ceiling. The
scheduler keys a deferral streak on the card's current `check_after` (rescheduling the
card starts a new one) and counts deferred *days*, not ticks. On the second deferred day,
or 24 hours after the first deferral, the streak escalates exactly once:

- If an explicitly configured `checks-fallback` automation account exists — a Claude
  account that is not the `checks` account itself — the check is opened on it, the card
  records which account ran it, and the streak ends. An unset purpose is not a fallback:
  `automationFor` would answer with the agent default, which is the account that just
  refused.
- Otherwise the card records one `check stalled` check-in naming how long it has been
  deferred and what to do about it (`keep verify`, reschedule, or configure a fallback),
  and `keep overdue` marks the card `check stalled on the account budget` from then on.

After escalating, the card stops writing the daily `check deferred` note — the stalled
record and the `keep overdue` annotation carry it. A refusal that is the scheduler's own
bookkeeping (the per-day open, the per-tick cap) does not latch the escalation; it is
retried on a later tick, and so is a transient launch failure — but only three times, so
a host that has been "temporarily" unavailable for three escalations running still gets
the card its stalled record. The per-tick open allowance is reserved before the open
rather than counted after it, and a refund belongs to the tick that made the
reservation. Escalations share the per-tick notice ceiling, and one held back
by it keeps its unlatched streak for the next tick. The streak lives in the `deferred`
bucket of `.keep/runs/scheduler-state.json` and is pruned a fortnight after its last
deferred day — never after its first, which would retire the streaks the ceiling exists
for. A `lastDay` Keep cannot read, or one in the future, is repaired to today rather
than trusted or ignored: ignoring it handed retention back to the streak's start and
pruned live streaks, trusting it let a dead one claim to be from 9999. `KEEP_CHECK_MODEL`, when set, is both the model the opened
session is launched with and the model the budget is classified against, so the window
Keep checks is the window Keep spends; unset, the session takes the model in
settings.json and the budget is read against the reviewer's model as a proxy.

Sessions Keep opens this way are marked `ephemeral: check` on their host pane. A sweep in
the same scheduler tick closes such a pane once its session has ended its turn and the
card carries a check-in from that session since the launch, or after 60 minutes with no
check-in at all. A session mid-turn is never closed. The close runs through the
unattended-retirement path with `{ automatic: true, ephemeral: true, idleMs: 0 }`: every
automatic guard applies — an unsent draft, a modal prompt, a pending question, unverified
background work, a viewer who attached, recent pane input or output, a pinned pane, a
session that changed under the sweep, or a pane that stopped carrying `ephemeral` all
refuse the close outright, and the pane is left alone and reconsidered next tick rather
than signalled anyway. `ephemeral` only excuses the card's own `check_after`, `needs` and
`depends_on` from pinning the pane (the session Keep opened is the one that just re-armed
that schedule), and `idleMs: 0` is what lets a pane that has just finished its check close
now instead of in eight hours. The signals that do follow a successful `/exit` are guarded
by pid, session id and input/output counts. A pane the sweep closed is then removed from
the terminal host so a dead one is not re-decided every minute; if the host refuses to
remove it — usually because it is alive again — the pane is not reported closed and its
card is left exactly as it was. Restarting such a pane, or moving it to another account,
drops the `ephemeral` mark: it becomes an ordinary session that nothing reaps.

An older terminal host that does not advertise `guardedKill` refuses the guarded signals,
so a check pane that will not exit gracefully on such a host is never force-closed and
accumulates. That is deliberate — an unguarded kill is how the wrong process dies — and
the fix is to restart the host, not to drop the guard.

If a scheduler-opened session is reaped without having written anything to its card, and
the delivery stamp on that card is still the one that session wrote, Keep clears the
stamp, records one `check session <id8> ended without recording a result` check-in, and
grants that card one extra open for the day, so a crashed session can never make a check
disappear until tomorrow. If the card was rescheduled and re-delivered to somebody else
in the meantime, that newer stamp stands and nothing is released.

If transcript verification shows that a scheduled-check prompt arrived truncated,
Keep still stamps it as delivered to avoid typing the prompt twice, then adds a
`delivery warning` check-in naming the session and received/expected character counts;
the full recipe remains available through `keep show <id>`.

The session that runs a check records the outcome itself with `keep checkin`, so what a
PASS means is a matter of what the card told it. `check_on_pass`: `done` means check in
with `--status done --clear-check-after`, `rearm` means check in with `--check-after
<check_every>` and the status unchanged (relative grammar, minimum `+10m`, set with
`--check-every`, which implies `--on-pass rearm`), and `review` — or no declaration at
all, which is every older card — means Owner review with the schedule cleared. The
delivered message spells the card's own declaration out. Re-arming from a relative
interval is measured from now, not from the missed date, so a daemon outage cannot queue
a catch-up storm.

A card may also carry a `probe`: a one-line read-only shell command (≤ 400 chars) run
with `$SHELL -c` in the card's project, `KEEP_PROBE=1`, and a `KEEP_PROBE_TIMEOUT_MS`
(default 120000) budget. When such a card comes due the daemon runs the probe
asynchronously instead of spending a model session: exit 0 lands a `probe result`
check-in and applies the on-pass action directly, and a non-zero exit or timeout
escalates to the check recipe (the run is told what the probe saw) or, if the card has
no recipe, lands the failure for Owner review. An escalation opens a session on the card
and its message begins with what the probe already saw (exit code and a 300-character
output tail) so the recipe starts from the failure. The same schedule is not re-probed
more often than every ten minutes, and a card whose fingerprint changed while the probe
ran keeps its status and schedule. An escalation spends from the same allowance as the
scheduler — the per-card daily open, the per-tick cap and the account budget — so a
probe failing every ten minutes is not a way around any of them. Run one by hand with
`keep probe <id>` — same execution semantics, no check-in, no daemon, exit 1 when it
fails.

Cards that skip thread delivery entirely: anything with a `probe`, and any recurring
(`check_on_pass: rearm`) recipe card. Both go straight to a session Keep opens, because
neither needs the scheduling thread's context and a thread cannot be relied on to re-arm
an interval by hand.

Before delivering to a cold, large thread, Keep runs `/compact` and waits for its
transcript marker or Claude Code's on-screen completion line and returned prompt.
After screen confirmation and model restore, it gives Claude Code ten seconds to
flush the marker for diagnostics. The gate is configured by `KEEP_CACHE_TTL_MIN` (default 60),
`KEEP_COMPACT_MIN_TOKENS` (default 80000), and `KEEP_COMPACT_TIMEOUT_MS` (default
240000). Run compaction directly with `keep compact <sid>` or
`POST /api/compact { "sessionId": "<sid>" }`.

Reopening a stopped Claude or Codex session also compacts when its last context is at
least `KEEP_AUTO_COMPACT_MIN_TOKENS` (default 100000). Keep snapshots context and cache
usage before launching the resumed agent, then compacts the ready pane before an opening
message. A live pane that is merely focused is left alone. Reopen uses the current model
when the last usage suggests its cache is still warm; a missing usage time is cold.
For cold premium models, it temporarily selects the cheaper model and restores the exact
original model afterwards. `KEEP_REOPEN_COMPACT_PREMIUM_MODELS` is a comma-separated
family list (default `fable,astra`); other models compact on their current model.
Reopening on another account treats the target as cold and compacts only after the
handoff reaches its target pane. Claude swap records retain the account settings path so
interrupted restore and shutdown repair that profile. If model restoration is unconfirmed,
Keep keeps the pane available for inspection and does not deliver the opening message.

Cold Claude compactions whose transcript model matches `KEEP_AUTO_COMPACT_MODELS` (a
comma-separated family list, default `fable`) first switch the session to
`KEEP_COMPACT_VIA_MODEL` (default `opus`, the latest Opus; set it to `off` to disable the
swap). `opus` resolves to the newest `claude-opus-<major>[-<minor>]` id a transcript under
the same Claude account has reported, kept per account config dir in
`.keep/latest-opus.json` across restarts, and never lower than `claude-opus-5-5`; a new
Opus release is picked up on an account once one of its sessions has run it. The switch types that full id, with `[1m]` appended when the session's
restore model carries the 1M window, so the transcript names a model a handoff can
reproduce. Any other value is typed as set and never upgraded.
Auto-compact skips that switch when it can submit before the current model's prompt
cache expires. Direct `keep compact` calls and compact-before-deliver retain the
existing swap behavior.
Prompt caches are per model, so the Opus summary is uncached regardless of timing,
while this avoids spending scarce Fable quota on summarization. Typed `/model`
commands also persist the saved default in Claude's `settings.json`, so Keep records
the exact settings value before switching. Claude Code's expected `Switch model?`
cache-warning dialog is confirmed automatically. Keep restores the session by
reissuing that exact value (including `[1m]`) when the session was using the configured
model, or by reissuing the transcript model ID otherwise; it then repairs the `model`
key in `settings.json` to its original value, including removing the key when it was absent.
While compaction is running—typically one to three minutes—new Claude sessions would
therefore start on Opus. Keep writes `.keep/compact/<sessionId>.swap.json` before
switching and removes it only after a confirmed session restore. A retained file and
`MODEL RESTORE UNCONFIRMED` in the daemon log mean both the session and `settings.json`
may need a manual fix. Direct `keep compact <sid>` calls and compact-before-deliver
use this swap too; on startup, a `PENDING MODEL SWAP` line reports each retained swap
file for manual inspection.

A retained record blocks messages to its session (`model restore is pending`) and daemon
restarts, and the pending-swap pass retries the restore every
`KEEP_COMPACT_RESTORE_RETRY_MIN` (default 10) minutes. Two exceptions keep a spent model
from wedging a session. When the compaction took the fallback because the original
model's window was spent (`cold-fallback (model-exhausted)`), or the restore's `/model`
came back with a rate-limit API error under its echo, Keep does not keep typing it: the
record gets `restoreDeferredReason` (`model-exhausted` or `rate-limited`) and
`restoreDeferredUntil`. That is the model's reset from the exhaustion decision or the
account usage snapshot (plus two minutes) when one is known, else a backoff of
`KEEP_COMPACT_RESTORE_BACKOFF_MIN` (default 60) minutes doubling per deferral up to
`KEEP_COMPACT_RESTORE_BACKOFF_MAX_MIN` (default 360). `settings.json` is still repaired at
once. A deferred record does not block delivery or daemon restarts, since the session is
deliberately left on the compaction model, and it expires 24 hours after it comes due
rather than after the swap. The log says `MODEL RESTORE DEFERRED`. When the deferral comes
due the restore is typed under the injection lock as usual (the record blocks again for
that attempt, though its expiry keeps counting from the deferral) and is either
confirmed, deferred again, or left unconfirmed. No key this pass sends is
unguarded. It reads the pane's input counter first, then proves the session idle under
it: no "esc to interrupt", no live dialog, no local command still finishing (read from the whole screen, with the
phrase allowed to wrap across rows, so a spinner far above the box still counts; an idle
answer in view that quotes the phrase delays the restore until it scrolls away), and an empty
box (the prompt-suggestion probe's comma and Backspace are themselves conditional on the
counter). The counter must have been quiet for `KEEP_COMPACT_RESTORE_INPUT_QUIET_MS` (default
2000) by the host's `lastInputAt`, and the idle screen is read only after a
`KEEP_COMPACT_RESTORE_SETTLE_MS` (default 1500) window with the count unchanged, so a
submit accepted just before the count has time to render. A turn submitted after the
count moves it, so the host drops the restore's keys; any screen read while the restore
is typed that shows "esc to interrupt" takes the draft back instead of pressing Enter,
and Enter is pressed only when the box holds exactly the command. A restore whose first
key the host refused typed nothing: it is not counted as an attempt, a deferred record
keeps its deferral, and `settings.json` is left alone. The pass writes a
record's pre-swap model back to `settings.json` only by compare-and-swap: the file must
hold exactly the id that record's own compaction typed, no other pending restore may share
the file, and no live session whose transcript moved since the swap may show a model chosen
by hand since. Otherwise it logs `left settings.json as-is`. That covers an interrupted
compaction whose session is gone as well as one whose restore is typed; a typed restore's
own `/model` (which Claude Code saves as the default) is otherwise undone back to exactly
what the file held just before it, so a person's value there stays theirs. If a key lands between the probe's comma and its Backspace, the comma
is left with the person's key, the refusal is logged, and the record waits
`KEEP_COMPACT_RESTORE_RETRY_MIN` before probing that session again. The hand-picked-model check below
runs again under the lock right before typing. Second, if the
transcript shows a model someone chose by hand after the swap (a confirmed `/model` other
than the daemon's own switch and restore rows, compared as exact ids so dropping the
`[1m]` window counts; each Enter the daemon sends for the swap is journalled on the
record as `daemonTyped` (`{ at, model }`, taken at the Enter itself), and each entry
accounts for exactly one row — the first `/model` of exactly that id at or after that
moment, within 15 seconds, whether or not the API accepted it, and even when the scan
only reports rows from a later moment — so a hand pick of any id near a daemon Enter, a second row of
the same id, a restore id the daemon never typed, and a row with no timestamp all count; or an assistant turn on a third model), the
pass retires the record without typing the restore or repairing `settings.json`, and logs
`retired model restore record … not restoring … over it`. The scan reads the last 8 MiB of a
transcript; when that does not reach back to the swap (or the earliest daemon Enter), it
cannot prove there was no hand choice, and it is treated as one: the record is retired
with "the transcript is too long to verify no hand choice since the swap", and another
session's unverifiable transcript likewise leaves `settings.json` as-is.

Auto-compact targets large eligible Claude sessions and Codex sessions running exactly
`gpt-6-astra`. Claude eligibility still follows `KEEP_AUTO_COMPACT_MODELS` (default
`fable`); that setting does not opt other Codex models in. It measures cache age from
the last model-usage record rather than the transcript file timestamp. For Claude it
uses the cache-creation metadata to infer a five-minute or one-hour lifetime (mixed
metadata uses five minutes), falling back to `KEEP_AUTO_COMPACT_CLAUDE_TTL_MIN`, then
`KEEP_CACHE_TTL_MIN` (default 60). For Codex the default lifetime is 30 minutes.

For a one-hour Claude cache, the daemon first tries the current model at minute 50. For
Codex it tries the current model at minute 20. Configure these with
`KEEP_AUTO_COMPACT_CLAUDE_TARGET_MIN` and `KEEP_AUTO_COMPACT_CODEX_TARGET_MIN`; configure
the Codex lifetime with `KEEP_AUTO_COMPACT_CODEX_TTL_MIN`. A detected five-minute Claude
cache follows a separate policy: Keep waits until one hour after the last usage record,
then compacts through the existing Opus swap instead of attempting the current model.
Warm attempts are prioritized by approaching cache deadline. After the normal cache
deadline, Claude uses its Opus swap and Codex uses
`KEEP_AUTO_COMPACT_CODEX_FALLBACK_MODEL` (default `gpt-5.6-sol`), with durable model and
reasoning-effort restoration. Busy locks, visible questions, background work, active
turns, exited sessions, and missing live panes remain ineligible.

Set
`KEEP_AUTO_COMPACT=off|dry|on` (default `off`); the context gate is
`KEEP_AUTO_COMPACT_MIN_TOKENS` (default 100000). Decisions are stamped once per idle
period in `.keep/compact/<sessionId>.json` and appended to
`.keep/compact/_log.jsonl`. Each record includes cache age and lifetime, original and
compaction models, the warm or fallback path, attempt stage, and request-level usage
when the transcript exposes it. Codex usage is accepted only when the compacted record's
`latest_token_usage_record.response_id` matches its `compaction_response_id`; Claude
streaming duplicates are deduplicated by request and message ID. Missing usage is
recorded as `null`, while Claude's compact-boundary pre/post token counts and duration
are retained separately. A compacted session is not re-compacted until it grows past
the token floor again. A busy or precheck failure remains retryable; a submitted timeout
is stamped so the daemon cannot start a duplicate compaction.
Run `dry` for a day and review that log before enabling `on`.

An agent can say when it is at a stopping point, which the daemon cannot see from
outside: bare `keep compact` inside a session (or `POST /api/compact-request`
with `{ sessionId }`) writes `.keep/compact/<sessionId>.request.json` and returns
without compacting. The request has its own path so that a daemon older than the CLI
answers 404 (the CLI then says it needs a restart) instead of compacting at once. The
next tick (every 30 seconds) treats a requested session as a candidate once it has been
idle `KEEP_COMPACT_REQUEST_IDLE_MIN` (default 1) minutes and holds at least
`KEEP_COMPACT_REQUEST_MIN_TOKENS` (default 30000), skipping the cache-target wait: a
warm cache compacts on the current model at once, and a cold or five-minute cache takes
the fallback at once. A request works on any Claude or Codex model: one outside the
sweep's families (`KEEP_AUTO_COMPACT_MODELS`, `gpt-6-astra`) has no fallback, so it
compacts on its own model whatever the cache age, even with no usage record, unless
that model's window is spent, when the request waits. Everything else still applies —
busy and waiting sessions, live panes, other nodes, the per-mtime stamp — and requested
sessions go first. A session with a pending model-swap record (`.swap.json`) is not
compacted on request until the record clears; the request stays. A request expires
after `KEEP_COMPACT_REQUEST_TTL_MIN` (default 30) minutes, is spent by any attempt (a
retryable skip keeps it), and is refused for Pi and reviewer sessions and for a session
on another node. A new Claude prompt voids it: `keep hook prompt` deletes the request,
because new work arrived before the idle moment and the agent can ask again at the end
of that turn; a Stop block that sends the agent on with more work voids it the same
way. Codex has no prompt hook, so a Codex request is voided only by expiry, an
attempt, or a Stop block. Requests are honoured even with `KEEP_AUTO_COMPACT=off`, where the tick
considers requested sessions only; `dry` logs them as `would`. Their stamps and
`_log.jsonl` entries carry `requested: true` with `requestBy` (`agent` or `api`) and
`requestReason`. When the context is above `KEEP_COMPACT_HINT_MIN_TOKENS` (default
150000), Keep suggests `keep compact` to the model once per two hours per session: from
the Claude `UserPromptSubmit` hook (`keep hook prompt`) as additional context at the
start of a turn, or appended to a reason the Stop hook already blocks with (Claude or
Codex). It never blocks a prompt or a stop on its own, and says nothing while a request
is pending.

## wt — worktrees

`wt` gives agent work an isolated linked worktree while leaving the shared main
checkout untouched. Managed trees live at `~/wt/<repo>/<name>` on `wt/<name>`.

```sh
wt new <repo> [<name>] [--no-install] [--base <ref>]
wt ls [<repo>]
wt path <repo> <name>
wt main [<path>]
wt rm <path | repo/name> [--force] [--delete]
wt gc [--dry-run] [--days N] [--keep-free N] [<repo>]
wt land [<path>] [--dry-run] [--no-push] [--ignore-main] [--no-deploy] [--no-health-wait]
wt guard [on|off|status]
```

Commit freely in the worktree. To land it, run `wt land`: it fetches and rebases
onto `origin/<default>`, shows the commits, then pushes `HEAD:<default>` without
checking out or changing the main checkout. After landing, `wt rm` recycles the
tree for the next agent; use `--delete` to remove it instead.

For a repo whose main checkout is a live deployment rather than another copy of the
code, landing to origin is only half the job. `DEPLOY_AFTER_LAND` in `bin/wt.js`
names those repos — today just `keep-tool`, the tree the launchd-supervised
`keep serve` daemon runs — and after a successful push `wt land` fast-forwards that
checkout and runs the repo's restart, `keep restart-daemon`.

It merges the sha this land pushed, not `origin/<default>`: a concurrent land that
moved that ref on in the meantime is the other session's to deploy. For the same
reason a checkout already *past* this land is left alone, restart included — this
land's commits are in there either way, and the session that put the newer ones
there is the one that should decide to start running them. `--ff-only` is what
makes the advance safe: it can only move the branch forward, never rewrite it. The
checkout is left alone entirely when it is on another branch, has an unfinished
merge, cherry-pick, revert or rebase, or has uncommitted changes. Those skips, a merge that is not
a fast-forward, and a refused restart are all reported rather than raised: the land
already happened, so they are things to say, not failures. The branch and status
checks are policy, not a lock; a checkout being mutated concurrently is only
protected by `--ff-only` itself. `--no-deploy` lands without touching the checkout,
`WT_NO_DEPLOY=1` disables the step for a whole process (the test harness sets it),
and `keep land <card>` inherits all of this.

A restart that happened is then checked, because a reviewed, tested commit can still
leave a scheduler failing every minute on the live daemon. Before restarting,
`wt land` takes a `keep health` snapshot; afterwards it polls health for up to 90
seconds (`WT_HEALTH_WAIT=<seconds>`, `0` or `--no-health-wait` skips it). A row
counts when it was healthy before the restart (enabled, ok or skipped, a zero streak)
or had never run then (a scheduler the deploy added, shown as `(new row)`; the snapshot
is read after the fast-forward, so the new code already lists it, unrun), and has
recorded failures since the new start. Two in a row is a `DEPLOY REGRESSION` and ends
the watch; a single failure is reported as "failed once since the restart" with no
revert, because one failure right after a restart is as often the restart itself
(delivery, handoff-queue and auto-compact while the terminal host reattaches). A
daemon that never records a start on the new code, or starts again in the window
without anyone asking (a crash loop, which ends the watch at once; a start another
session's land or `keep restart-daemon` requested does not count), is a
`DEPLOY FAILURE`. Regressions and failures print the range
that went live and the revert to run in a fresh worktree — `git revert --no-edit
<from>..<sha>`, then review and land it as usual. The range starts at the commit the
old daemon was running (or, when that is unknown or not an ancestor, the checkout's
HEAD before the fast-forward), so it can include other sessions' landed commits that
had not been deployed yet; the output says so. It never reverts or pushes anything
itself. When nothing regressed it says so in one line. Give a `wt land` or `keep land`
of keep-tool a command timeout of at least five minutes, so the report is not cut off.
`keep land` records its check-in before the deploy, so the wait never holds the
citation. A land from a pane-only node, which asks the daemon to deploy itself
(`/api/deploy-self`), does not wait; the daemon's own watch below still covers it.

The daemon keeps watching after that process is gone. A daemon start on a commit
different from the last one known arms a deploy watch in `health.json`
(`daemon.deployWatch`: the commit, the one it replaced, the rows healthy at start and
every row the store held). A start whose `git rev-parse` failed records no commit, so
`daemon.lastKnownCommit` carries the last one forward for the next comparison. For 30
minutes — longer for slower rows, cadence plus 15 minutes, capped at two hours, so an
hourly row's first run counts — a failure on a row healthy at start, or on a row that
did not exist then, is charged to the deploy on the `deploy` health row, for example
`review-compact started failing after deploy 7f8affa (was 738b569)` (an added row
reads `(new)`). A deploy that starts inside an earlier deploy's 30-minute window keeps
that one's base, so the label names the whole range. The row reads what the rows it
blames read: its streak is the worst among charged rows whose fault still stands
(`faultStands`), so it turns failing on the same three-in-a-row as the scheduler's own
row; when a charged row has only skipped past its fault window it reads recovered with
it; its failure time is the charged rows' last real failure, never a skip's; and it
goes back to ok (naming what recovered) once every charged row succeeds;
a charged row that is disabled, retired or removed stops counting, and so does a row
the deploy added that the running code stopped writing (the revert went out): one with
no `CADENCES` entry that has not recorded since the current daemon started, once that
start is older than 30 minutes and two of the row's cadences. A crash restart on the
same code keeps the charge of a row that is still there. It is written
inside `health.record`, on the store that call already reads and writes, behind a
try/catch so the scheduler's own record always lands, and is on demand, so
self-repair opens its card on the failing scheduler, not on `deploy`. A same-commit
restart (a crash, or a restart with nothing landed) keeps the watch the deploy armed.
Neither half charges a deploy with `runs`, `lint`, `git-pull`, `loop-stalls`,
`account-budget` or `inflight` (`health.DEPLOY_UNWATCHED`): what fails those is the
machine, the registry, a durable record outliving its max age or the restart itself —
the new daemon's startup can stall the loop — so they would call every deploy a
regression.

`wt gc` fetches each repository, then recycles only clean, fully landed worktrees
whose directory contains no live agent cwd. It keeps two safe recycled trees per
repository and deletes older extras; `--days` and `--keep-free` change those
defaults.

The default grace is one day, not three. Three outlived the trees it governed —
keep-tool turns over roughly nine worktrees a day, so none was ever old enough to
collect, the pool stayed empty, and every `wt new` built a directory and
reinstalled from scratch. Supply only has to beat the pool cap, so a day is
plenty, and it leaves a real window: "unused" means no live `claude` or `codex`
process has its cwd in the tree, which a shell, an editor, a dev server or a build
sitting in a finished tree will not trip, and recycling takes that tree's ignored
files and its landed branch with it. `--days N` sets a longer grace.

A sweep never both frees a tree and deletes it. A newly recycled tree goes into
the pool and becomes eligible for deletion only on a later sweep, so the directory
outlives its branch by a cycle. `--keep-free 0` asks for no pool at all, and there
a freed tree has nothing to survive into, so it is removed at once. `--dry-run` prints the same action
table without changing anything. `keep serve` runs this sweep daily; set
`KEEP_WT_GC=0` to disable it.

## Exited-pane retention

The terminal host keeps a pane after its process exits, so its screen can still be
read and the session reopened in place. It keeps it until something removes it, and
for agent panes nothing used to: one morning the host held 264 panes with 18 alive,
144 of them exited a week or two earlier, and every daemon state build resolves every
pane, dead ones included.

`keep serve` now sweeps them, ten minutes after it starts and hourly after that. A
pane is a candidate when it has exited, it is on this machine (another node's panes
are that node's to keep), and it is a `claude`, `codex`, `pi` or shell pane — a
pane launched with no agent counts as a shell. A candidate is removed when it exited
more than `KEEP_PANE_RETENTION_DAYS` days ago (default 7), or when there are more
than `KEEP_PANE_RETENTION_MAX` exited candidates (default 60), oldest first down to
the cap. Nothing that exited within the last hour is removed, whichever limit asked:
that can be a restart between stopping the agent and relaunching it. A sweep removes at most
`KEEP_PANE_RETENTION_BATCH` panes (default 25), one host request at a time, and
leaves the rest for the next hour; a remove the host refuses is logged and decided
again next time.

It never removes a pane that something still needs: a session marked keep-running,
an account handoff that has not reached `done` or `failed` (a handoff resumes into
the exited pane itself), a queued transfer, an unfinished restart (a force restart
waiting in recovery-needed for Recover, which needs that exact pane), a pending
compaction swap, or an unsent delivery journal for that pane (the send path settles
those). Nor a pane someone has on screen. A graceful Claude exit turns its pane into
a shell with no session, so only the guards that name the pane itself protect it:
handoffs, queued transfers, restarts and delivery journals match by pane as well as
by session; keep-running and compaction swaps match by session only. If any of those
records cannot be read, the sweep removes nothing and its health row turns red,
naming the record. The `pane-retention` row reads like `removed 3 of 41 exited
(aged 2, over cap 1), kept 5 (handoff 1, keep-running 4)`.

`keep pane gc --dry-run` prints the same decisions against the live pane list —
`remove <pane> <agent> exited <date> <reason>` or `keep <pane> <reason>` — without
removing anything; without `--dry-run` it removes them all at once, with no batch
limit. `--days N` and `--max N` override the two limits for that run. It runs only
on the daemon node, whose registry holds the records the guards read. Set
`KEEP_PANE_RETENTION=0` to disable the sweep.

## Event loop stalls

`keep serve` runs every scheduler tick and every HTTP route on one event loop, so
one tick that does a long synchronous walk or spawns a child synchronously holds up
everything else, host requests included. A one-second probe timer measures how late
it lands. When it is more than 500 ms late, the probe writes to `~/keep/.keep/serve.log`:

    keep serve: event loop stalled 2400ms during handoff-queue

The probe measures on the monotonic clock that Node's timers run on
(`performance.now()`), so time the machine spends asleep is not a stall. A lag over
five minutes on that clock is logged as `keep serve: clock jumped Nms (suspend?)`
and never counted as a stall.

The `during <name>` part comes from `bin/loop-hold.js`. These run inside a hold:

- the interval ticks in `bin/serve.js` and `bin/serve/schedulers.js`: `handoff-queue`,
  `auto-compact`, `brief`, `wt-gc`, `card-usage`, `fleet-usage` and `git-pull`,
  named after their health rows, plus `background-jobs`, `session-restart`,
  `live-sessions`, `stalled` and `turn-ticks` (the turn index and the watcher,
  one hold for the pair), named after their tick;
- every HTTP route, named `<method> <path>`.

The feature modules' own schedulers are not wrapped: review, landed, lint,
self-repair, runs, delivery, limit-resume, pane-retention, session-cleanup,
review-obligations, slack, discord, the receipts poller and the area-session tick.
A stall one of them causes is reported under the plain message, or under a guess.

The probe first names a hold measured to have held the loop into the late window,
as `during <name>`. Failing that, it guesses. The first guess is an async tick or
route that was open across the window. The second is the latest hold entered before
the probe was due that was not measured or settled short. A guess is written
`during likely <name>`. A route waiting on a lock is open too, so a guess can be
wrong. When nothing applies, the line ends at the duration.

Each wrapped tick also times its own synchronous entry, plus the continuations it
started before the loop next reached its check phase. That second measure only
counts while no other wrapped hold has started, and never past the moment the tick
settled. Over 500 ms, the tick writes one line:

    keep serve: turn-ticks held the loop 900ms

That catches a hold even when the probe's timer happened to land inside it and saw
no lateness.

The `loop-stalls` health row summarizes the last hour, for example `3 stalls in the
last hour, worst 7200ms during handoff-queue`. Only a measured holder is named there,
never a guess. The row is unhealthy exactly while a stall over 5 s is inside that
hour, because 5 s is where CLI and host requests to the daemon start timing out. A
stall under 5 s appears only in the detail.

A severe stall records a failure, at most one every ten minutes: a continuous storm
is rate limited, not merged into one. A heartbeat every five minutes records a skip
while a severe stall is still inside the hour, so the streak stays but does not
grow; the skip holds the result (`holdResult`), so the row does not read as
recovered while the stall is still in the hour. The first heartbeat after a clean hour records ok. The row warns at one
failure and reads failing at three, which puts it in console attention. It never
opens a self-repair card: `bin/self-repair.js` excludes it, because a stall from
sleep, swap or a loaded machine, blamed by a heuristic, is not something a
daemon-code fix addresses. A restarted daemon starts with an empty window.

The `node-hook-queue` health row is written by the node-stats poller after each round,
from every node's `hookQueue` sample (`{ depth, cap, oldestAt }`, the node's
`~/.keep-node/hook-queue` as its host's `stats` verb reads it; absent from a node that
never queued a hook, and from the daemon node, which runs no hook client). It fails while
any node's queue is at its cap (200 entries, where the oldest events are being dropped) or
holds an event older than ten minutes (a queue that is not draining), naming each such
node: `aws1: 200 hook events queued (at cap), oldest 2h 3m`. Stale samples are left out:
with remote nodes configured but no fresh sample reporting a queue the row reads ok
(`no fresh node sample reports a hook queue`), with no remote nodes at all nothing is
written except once to clear a failure an earlier daemon left behind (`no remote
nodes`), and the row is rewritten only when its result changes. Self-repair excludes the row: a
repair session on the daemon cannot drain a node's queue, which empties on its own once
the node reaches the daemon again.
A stall in the probe's first minute is logged as `keep serve: event loop stalled
7200ms during startup` (with ` (<name>)` when a holder was measured, and
` (likely <name>)` when it is a guess) and only counted in
the detail, as `1 startup stall, ...`: module loading and cold caches hold the loop
once on every start, so it never records a failure or holds the row in skip.

The rule for daemon code: no synchronous file-system walks and no synchronous
process spawns on a tick or route path. Read sessions through the transcript index
(`periodicSessionScan`) and reuse cached answers such as `bin/landed.js`'s memos
rather than asking again. Anything that must run a process uses `execFile` or
`spawn` with a callback, or a worker or child. `bin/landed.js` itself still spawns
git synchronously on a cache miss, which is known debt.
`bin/daemon-sync-guard.test.js` fails on any `execFileSync`, `spawnSync` or
`execSync` that is not on its allowlist. It checks `bin/serve.js`,
`bin/serve/routes.js`, `bin/serve/schedulers.js`, `bin/handoff-queue.js`, and the
in-process scheduler modules `bin/landed.js`, `bin/lint.js`, `bin/review.js` and
`bin/self-repair.js`. The one intended entry is the registry rebase in
`createRegistryPull`, which runs under the registry lock on purpose and only after
an asynchronous fetch found new commits. The rest are listed as debt: landed.js's
git seam, lint.js's checkout status and git reads, review.js's git reads and
transcript grep, and self-repair.js's patch-id.

## Fleet reviewer

### Running it

```
keep-reviewer            # latest fable (default)
keep-reviewer <model>    # override with a model available to your Claude installation
```

Open it in its own terminal tab and **leave it idle** — it is not a session you drive.
`keep serve` wakes it with a one-line `[keep] review tick` message when the fleet has
produced something worth reviewing (every 10 min at most, 20 min minimum between
sends), and it runs the `fleet-review` skill against the named cards. No activity
means no tick, so an idle machine costs nothing. `keep review-tick --force` sends one
now; `keep review-stats` shows the last tick, why the last one was skipped, and what
the reviewer has cost against the weekly window.

Systemic suggestions belong in `keep review-idea`, rather than on an individual card:
it creates an inbox `idea` card tagged `reviewer-idea`, deduplicates normalized titles,
and can use `--cards a,b,c` to leave linked reviewer check-ins on the evidence cards.
The message should name the observed pattern, cite the cards, sessions, or commits that
demonstrate it, and propose the workflow or Keep change.

The model argument is passed to `claude --model` verbatim. Model aliases resolve
according to your Claude installation and account access.
Do not substitute a pinned id unless you mean to freeze the version. Only the family
name is derived from it, for the budget governor (which matches the `Fable wk` usage
limit by label prefix) and for the `review (fable)` heading findings land under.

Switching models means restarting the session: the model is fixed at launch, and the
governor reads it from the `.keep/reviewer/<id>` marker written at startup.

`keep review-budget` checks the account and model of the active fleet reviewer. It
validates that account against the session's durable authority, or uniquely discovered
legacy transcript ownership, and never inherits an unrelated caller's account. Use
`--account <claude-id>` for a deterministic account check; `--model` overrides the
active reviewer model. Exit codes are 0 for available, 6 for the weekly ceiling, 7 for
the short window, and 8 when identity or usage is unavailable.

Every live Claude or Codex session has a **Restart** in its actions (Watch and Triage),
and the Fleet reviewer header has one beside `Tick now` and `Stats`. A click is Owner's
own restart, so it is forced: `/api/restart-session` with `mode: 'now', ownerForce: true`
asks for no idle prompt, stops the session's captured process tree (a turn in progress is
interrupted, nothing is typed into it) and resumes the same conversation on the same
account. A retry also stops any process an earlier forced restart of that session
captured and left running. The reviewer's button is disabled when there is no live
reviewer pane. Because `claude --resume` inherits none
of the launch environment, both restart transactions (the guarded one and the explicit
force/recover path) rebuild the reviewer's flags (`--model`, the prompt-suggestion
settings) and env (`KEEP_REVIEWER`, `KEEP_DIR`, `BASH_MAX_OUTPUT_LENGTH`) from the
`.keep/reviewer` marker plus the pane meta the launcher recorded — so a deliberately
pinned model id and a `KEEP_REVIEWER_BASH_OUTPUT` override come back as launched, not
as the family and the daemon's own environment. The pane keeps `meta.reviewer`, and the
resumed process's session-start hook un-tombstones the marker so ticks resume against
the same session id.

### Trust boundary — accepted risk

The reviewer runs as an ordinary agent session with the permissions supplied at
launch. Review bundles include untrusted transcript content. The bundled procedure
is guidance, not an operating-system sandbox; choose permissions appropriate for
your environment. Keep's deterministic guards and audit logs supplement those
permissions. Do not treat model instructions as access control.

### How it works

A separate agent session reviews the *other* agents' work and reports problems back
onto their cards. Evidence gathering is deterministic Node (`bin/review.js`): it reads
each linked Claude and Codex transcript from a stored byte offset, extracts what the
agent actually did (tools, files, commands, failures) without ever emitting a file
body, and renders it inside a token budget.

Two invariants the code enforces:

- **A reviewer entry never claims a card's resume link.** `checkinTask` takes
  `linkSession: false`, and contribution/claim recording returns early for a reviewer session
  (`KEEP_REVIEWER=1`, or a `.keep/reviewer/<id>` marker the daemon can also see).
  This holds for a reviewer `keep done` or `--status` change too.
- **Reading never advances committed offsets.** `review-bundle` stages pending
  offsets; only `review-note` / `review-ack` promote them, so a crashed tick re-reads
  its evidence instead of silently skipping it.
- A registered reviewer remains eligible in the `recent` state after more than an hour idle; the existing running and mid-turn guards still apply.
- Log entries written by Keep's own headless generators count as weak evidence, and cards with no non-reviewer, non-spawned linked session have their evidence score halved.
- Each tick includes at most one card per numeric-suffix-stripped title stem, leaving sibling cohort cards eligible for later ticks.
- `KEEP_REVIEW_TICK_LIMIT` controls the per-tick candidate limit and defaults to 5.
- `KEEP_REVIEW_CADENCE` chooses when the reviewer is woken. `events` (the default)
  ticks on a drift verdict from the turn watcher and once a day for the cross-workstream
  sweep; `clock` is the original tick every `KEEP_REVIEW_TICK_MIN` (default 10) minutes.
  A drift wake leads with the drifting card, the watcher's state line and its reason,
  bypasses `KEEP_REVIEW_MIN_GAP_MIN` but never the budget or the live-reviewer gates,
  is limited to one per session per `KEEP_REVIEW_DRIFT_GAP_MIN` (default 30) minutes,
  and is sent at most once per turn (the last 200 turn keys live in
  `.keep/review/_meta.json`, so a daemon restart cannot repeat one). The daily sweep
  runs at local `KEEP_REVIEW_SWEEP_AT` (default `07:45`, after the ideas sweep), carries
  the ranked queue plus the sweep clause, and retries every 10 minutes until noon. A
  drift that arrives while the reviewer is mid-turn, over budget or not yet running is
  parked in `.keep/review/_meta.json` (one per session, 20 at most) and retried from the
  per-minute checker until it is sent or two hours old — a refusal about the drift
  itself, such as the per-turn dedupe, is not retried. A fallback tick covers a watcher
  that records nothing: `KEEP_WATCHER=1` says the tick is enabled, not that its model
  works, so the fallback asks the turn index for the newest `verdict_at` and sends only
  when no verdict and no tick has landed within `KEEP_REVIEW_FALLBACK_TICK_MIN`
  (default 120) minutes. Its own attempt stamp lives in `.keep/review/_meta.json`, so a
  quiet fleet costs one evaluation per interval rather than a queue scan a minute, and a
  minute with nothing due records no health at all. That interval is also the `review`
  row's health cadence in events mode, so a genuinely silent reviewer still goes red. The daemon logs the active mode
  and why at startup. An unparseable `KEEP_REVIEW_SWEEP_AT`, or one at or after 12:00
  (the retry window closes at noon), falls back to `07:45` and warns rather than removing
  the sweep. `POST /api/reviewtick` and `keep review-tick --force` work in both
  modes, as does reviewer compaction.
- A tick's budget is read against the reviewer session's own account when the daemon
  knows it, otherwise against `accounts.automationFor('claude', 'reviewer')`, and only
  then against `KEEP_AGENT_ACCOUNT_ID`. The env var describes whichever session spawned
  the process — for the daemon, not the reviewer's account — so the configured purpose
  deliberately outranks it. `keep review-stats` prints the mode, the next sweep
  and the last drift wake, and the per-day counters include drift wakes.
- A batch bundle (`review-bundle a b c` or `--queue`) prints the safety envelope, health,
  time-zone and evidence guidance once ahead of every card; a by-hand single-card bundle
  still carries them itself. Uncommitted diffs appear as per-file added/removed counts
  plus the first hunk header, never as bodies, and routine queue-audit/archival log
  entries are counted rather than printed. Each card's git section carries the tree
  state, ahead/behind for the checked-out branch, whether each cited sha is on origin's
  default branch (local refs, no fetch), and the other sessions live in the same
  checkout, so the reviewer needs no git or `keep who` calls of its own.
- The reviewer pane is launched with `BASH_MAX_OUTPUT_LENGTH=200000`
  (`KEEP_REVIEWER_BASH_OUTPUT` overrides it) so a five-card bundle lands in one Bash
  result instead of being re-read in chunks. Each tick message ends with the previous
  tick's assistant-message count against the target of 3; `review-stats` prints the
  same number as `last tick cost`.

Findings dedupe on `sha1(task, kind, normalized subject)` — never on the prose, which
varies every tick — and go quiet for 24h unless the status or HEAD moves.

### The reviewer may change a card directly

The reviewer is not limited to suggesting. It makes ordinary card changes — status,
`keep done`, plan steps, `wait-on`, `needs`, `check-after` — like any other session,
when the evidence is conclusive and the change is what a careful owner would do. It
was previously refused with exit 4 and told to file a `wrong-status` finding instead;
that rule is gone. Two things did not change: it never becomes a card's linked/resume
session, and every entry it writes names it. A reviewer check-in is headed
`check-in (reviewer fable) → done`, a closure `done (reviewer fable)`, alongside the
`review (fable)` heading its findings already use.

When the owning session is live and mid-turn, prefer a `wrong-status` finding with
`--suggest-status` so the owner decides.

`keep review-land` carries a `statuses` array beside `acks`, `notes`, `ideas`, and
`dismiss`, so a status change lands in the same one-commit tick:

```json
{"statuses": [{"id": "some-card", "bundle": "b1", "status": "done",
               "message": "Superseded by the landed change in abc1234."}]}
```

`status` must be a normal Keep status, `message` is required, and a bundle built
before the card moved is refused exactly as an ack is. It lands through the same
`keep checkin --status` code path, so the blocked/landing/waiting guards apply
unchanged, and it prints as a `status` row in the result table. Each change is counted
in the review ledger as `statuses`, shown by `keep review-stats` and in the console's
"actions today".

## Per-card model usage

`keep usage <card> [--json]` shows local Claude and Codex token usage by model, and
ends with the unassigned total across all cards. `keep usage` with no card prints
fleet totals instead — attributed tokens, unassigned tokens and events, the start
time, and whether collection is still catching up (`--json` gives the same fields).
The card detail and console session header show the same expandable breakdown; the
header also shows what the open session itself has spent, so moving a session to a
fresh card does not read as a usage reset. That session figure is the session's own
total with its subagents and Codex delegates, whatever card it is linked to now.
`keep serve` collects every 30 seconds in a separate process; the first collection
sets a durable start time. There is no historical backfill. Old transcript records
are read only to establish counter baselines and suppress copied responses.

Input, cache reads, cache writes, and output are disjoint buckets. Reasoning tokens
are available in JSON and already included in output. These are reported tokens,
not subscription charges or dollar estimates. `calls` counts distinct Claude
responses and positive Codex usage deltas; a Codex delta can cover multiple calls
if the transcript omitted intermediate usage events.

A session claim records an accounting ownership transition independently of its
movable resume link. Usage belongs to the card linked when the first usage record
for that response was timestamped; later chunks update that response on the same
card. Usage a session produced before its first link goes to the card it first
links to, once it links — including usage a previous collection had already
recorded as unassigned. A release (unlinking without relinking) still ends
attribution: usage after it stays unassigned. Child sessions inherit the parent's
card at spawn and retain it when the parent changes cards; a child spawned before
the parent's first link inherits that first card. Claude subagent paths, Codex
parent metadata, and Keep's explicit Claude-to-Codex parent records provide those
relationships. Sessions never linked to a card remain unassigned instead of being
guessed from a project.

The local `.keep/card-usage/` directory contains the ownership timeline, a durable
ledger of deduplicated usage records and byte checkpoints, and a dashboard summary.
Keep's existing cross-process lock serializes collection and ownership changes;
atomic replacement commits counts and checkpoints together. Totals survive
restarts, card closure, and source transcript removal. Preserve this directory to
preserve accounting; it is not synced through Git. Missing/corrupt evidence is
reported as incomplete or as a `card-usage` health error, never silently reset.
Only transcripts available on this machine can be measured.

## Reviewer evidence quality, repeated probes, and outcomes

Treat a bundle as a delta, not a complete authorization or test history. Label each
finding `observed`, `inferred`, or `needs-verification` using `basis` in landing JSON
(or `--basis` for review-note). An observed finding also requires `evidence` with
specific references and `checked` describing what you actually verified. Before
alleging missing authorization, tests, or unsafe action, inspect the relevant earlier
human instruction and owning/parent session or cited test result. If you cannot,
state the uncertainty and the next verification step. Unverified findings cannot
trigger live nudges or speaker announcements. Absence from the delta is not proof.

A bundle may identify complete identical scheduled probes. Only after inspecting the
exact tool inputs and verifying that they are read-only and results are clean, add
`"probeSafe": true` to that card's ack (or `review-ack --probe-safe`). Generic browser
JavaScript needs inspection too. This approves only that exact fingerprint. After
two clean reviews, unchanged probes back off from one hour to two hours to a four-hour
cap; changed prompts, calls, results, errors, human activity, card or repository work
bypass that backoff. Skipped probes do not advance evidence cursors. Unknown transcript
formats stay reviewable. Use `keep review-replay <card> [--session <id>] [--since ISO]`
for a read-only historical estimate; it cannot reconstruct external Git/card changes.

Owners and working sessions record explicit outcomes with
`keep review-outcome <card> <key> <status> -m "reason" --evidence "check-in/commit reference"`.
Statuses are `fixed`, `confirmed-deferred`, `incorrect`, `superseded`, and `unresolved`.
The reviewer does not grade its own findings. Silence is unresolved, not agreement.
Use `keep review-outcome [card] --json` to read outcomes; stats report all-time counts.
Incorrect and superseded findings stay suppressed, including forced repetitions.
Fixed/deferred findings may re-enter when source or status changes. If new evidence
invalidates a correction, ask the owner/working session to reopen it explicitly.
During compaction preserve the correction, evidence reference and resulting lesson;
bundles also carry recent incorrect findings so a fresh session can recover them.

Before posting or acknowledging, Keep checks that the card still matches the evidence
snapshot. A newer owner check-in, status, plan, schedule, need, dependency or session
link invalidates it; `--force` does not bypass this. On a freshness refusal, rebuild
that card's bundle and reconsider the finding. Other cards in the batch may still land.

Bundles include at most four related-work leads: explicit dependencies/successors and
specific topic matches in the same project, including completed/archived cards and
recorded outcomes. Before claiming unfinished or unowned work, read relevant leads.
A match is not proof that every defect is fixed: an OOM fix does not settle teardown
re-entry or lost failure reasons. Check the current phase before recommending a
project change; CLI implementation and image deployment can belong to different repos.

For uncertain notes supply `question` (the verification question) and `unknown`
(the evidence still missing), using `--question`/`--unknown` in review-note. The public
report opens with that question and quotes the message as an unverified hypothesis.
Use the same wording in your final tick summary. Do not put a confident accusation
under a needs-verification label. Unverified notes cannot apply status changes;
observed notes still require evidence references and verification performed.

### Offline reviewer evaluation

`keep review-eval --run [--model fable] [--skill candidate.md] --json` evaluates
frozen, sanitized cases without live findings or registry changes. Save the JSON and
pass `--compare baseline.json` on later runs of the same corpus. `--prompt` previews
the label-free input; `--predictions result.json` scores saved output without a model
call. Results are informational and never gate pushes or restarts. See
[Reviewer evaluation](reviewer-evaluation.md) for metrics, corpus limitations and
custom suite format.

The stalled daemon sweep and `keep codex-jobs --reap` also inspect orphaned
interactive Codex and Claude processes. This check uses **PPID 1 and missing live
pane/session ownership**, never process age or transcript idle time. Known session
PIDs, explicit resume IDs, child processes, open conversation files, and running
companion work protect a process. Unknown host, process, or companion evidence
refuses cleanup. Only the current user's recognized interactive agent executables
qualify; shell wrappers, headless commands, and unknown arguments are excluded.
The reaper refreshes identity and safety evidence before SIGTERM. Use
`keep codex-jobs --reap --dry` to inspect planned actions without sending signals.

Everything else a session starts in the background — a dev server, a watcher, a
test runner — is swept by the daemon every five minutes (`leftovers` in
`keep health`). A process tree is a leftover when its root's parent is
init/launchd, it belongs to the current user, the root is a dev tool (node, a
package runner, python, ruby, go, make, a shell, or a `node_modules` binary), it
inherited `KEEP_PANE`, and that pane is exited or closed. The tree must also
look like a server or watcher (a `dev`/`start`/`serve` package script, `next dev`,
vite, metro, expo, a `--watch` mode, a Python or Rails dev server, an orphaned
vitest or jest worker) or have a node, deno or bun process listening on a TCP
port (debugger ports excluded); a one-off job that is still working, including a
finite test run, is never stopped. It is kept while any
live pane runs the same session (Claude, Codex or Pi id) or the same card, while
an account transfer for it is in flight, and for `KEEP_LEFTOVER_GRACE_MIN`
(default 15) after the pane went away; a closed pane's grace is counted from the
sweep's first sighting, so a one-off `keep leftovers --reap` never stops it.
The whole tree is spared if any member is an application or system binary, a
shared helper (adb, watchman, an ssh master, tmux, a Gradle or Kotlin daemon,
database servers), an agent, a Keep process, started with `KEEP_PERSIST=1`, or
matched by the `KEEP_LEFTOVER_EXCLUDE` regex. A due tree gets SIGTERM root first,
then SIGKILL after five seconds, each signal checked against the pid's start time
and command, and only after a second look confirms nothing changed. The sweep
only runs on the daemon node, against its own host's panes; an unreachable host
skips it. Stops are logged to serve.log; `KEEP_LEFTOVER_SWEEP=0` turns the sweep
off, and `keep leftovers --reap --dry` shows what it would do.
