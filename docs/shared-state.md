# Shared state: declarations, notes, observation

Two sessions in the same checkout share more than the files. They share a staging
environment, a Terraform state file, a pool of sandbox hosts, a phone. Keep already
had one tool for that — a **hold**, which asks everyone else to wait — and the hold
is the wrong shape for the most common case: *I did not take the thing away from
you, I changed how it behaves.*

On 2026-09-11 one session put staging into home-only mode with no deck-persistence
config. It was not asking anyone to wait, so it took no hold, and its check-in went
onto its own card. A sibling session spent the next afternoon validating through the
staging UI against behaviour nobody had told it about. Nothing was blocked. The
information simply had nowhere to go.

This page describes the three pieces that give it somewhere to go. **None of them
gate anything.** There is no new wait, no refusal in `keep step claim`, and no
delivery that is not already behind the watcher's own switch.

## 1. Resource declarations

A project declares, by hand, the shared things it has. The registry lives beside the
gated-step registry, one file per project basename, committed to git:

`~/keep/resources/<project-basename>.json`

```json
{ "project": "~/castle/castle-sandboxes",
  "resources": {
    "staging": { "title": "staging sandbox environment",
                 "commands": ["terraform apply", "heroku .* --remote staging", "--app castle-staging"],
                 "paths": ["terraform/main.tf", "terraform/staging/**"],
                 "deploys": ["heroku:staging"],
                 "noteFor": "+2h" } } }
```

- Names are **hold scopes** (`/^[a-z0-9][a-z0-9:-]{0,63}$/`), so `keep hold --scope
  staging` and `keep note --scope staging` name the same thing.
- `commands` are case-insensitive regexes, matched against each command the turn
  actually ran — normalized by `bin/steps.js`, so `bash -lc "terraform apply"` is
  `terraform apply`. The normalized form is one shell-quoted line, so an unanchored
  pattern can match inside a quoted argument; the only cost of a false match is one
  advisory nudge.
- `paths` are globs matched against the turn's files, absolute or project-relative.
- `deploys` are `<kind>:<target substring>` matched against `deployCommand()`'s
  result, or a bare `<kind>`.
- `noteFor` is the default window a note on this resource gets.

A regex that does not compile disables **that matcher only** — never the declaration,
never by throwing — and lint's `resource-bad-matcher` reports it, because an
uncompilable matcher is otherwise silent by construction.

```
keep resources <project>
keep resources <project> --add <name> [--title t] [--command <re>]… [--path <glob>]… [--deploy <kind:target>]… [--note-for +2h]
keep resources <project> --remove <name>
keep resources --check <project> "<command>"
```

`--check` answers "which declarations would this command touch?", so a declaration
can be tested by hand rather than discovered by a watcher nudge. Declared names are
listed in the session-start block.

## 2. State notes

```
keep note <project> --scope <resource> [--scope ...] -m "what is true now" --for +2h [--task <card>]
keep note --extend <id> --for +2h
keep note --clear <id> [-m why]
keep notes [<project>] [--all] [--json]
```

A note is an expiring, non-blocking sentence about a shared resource. Storage is
`~/keep/.keep/notes/<project-key>.json`, one file per project, written atomically;
entries cleared or expired more than seven days ago are dropped on every write, so
the store stays bounded (holds do not — they are GC'd opportunistically instead).
The message is capped at 300 characters and sanitized the way reviewer-bundle fields
are: control characters stripped, `<<<`/`>>>` neutralized.

A scope must be declared on the project once the project declares anything; a
project with no declarations accepts any well-formed resource label. A scope that is
neither is refused with the list of declared names.

Notes are visible wherever holds are:

- the session-start block (`State notes on this project:`),
- `keep who <project>`, in their own section after holds,
- the morning brief (`State notes`, with expired-unconfirmed ones flagged),
- the reviewer bundle, inside the safety envelope beside holds,
- the daemon's `who` snapshot, so the console can render them.

They are also broadcast. After a create, extend, or clear, the CLI asks the daemon
(`POST /api/notes/announce {id}`) to tell the sibling live sessions in the same
checkout. The daemon derives *which* event it is from the note's own state rather
than from the request — a caller cannot announce a live note as cleared — and
records it on the note, so a replayed request is refused with 409 instead of typing
the same line into every sibling a second time. Recipients are —
the author excluded, reviewer and spawned sessions excluded, mid-turn sessions
skipped. The message says what changed and then says `Information only; nothing is
blocked.` If the daemon is down, the CLI prints one line and exits 0: the note is
still recorded and still shows at the next session start.

### Expiry

A per-minute daemon sweep finds notes past `until` that were neither extended nor
cleared, and **nags the author once, ever**. If the author's session is live and
ready it gets the nag in its terminal. If the session has exited the note is marked
as Owner's at once and left to the brief and to lint's `note-expired`. If the
session is merely busy — mid-turn, a question on screen, a tool running — the nag is
*deferred* and retried on later sweeps, up to six attempts, after which it becomes
Owner's too. Nothing blocks on an expired note, and no nag is ever sent twice.

`keep note --extend` deliberately rewinds that: extending is asserting the note
again, so its nag state and attempt count are reset and the author owes an answer
at the new expiry. `keep note --clear` works from any session — if you are not the
author, Keep prints who wrote it and clears it anyway, because whoever can see that
a statement is no longer true should be able to say so.

`keep wait --no-hold` does not see notes at all. There is a test that says so.

## 3. Watcher observation

When a turn touched a declared resource and ran no `keep note`, `keep checkin` or
`keep hold`, the watcher records an observation. It is rule-based: no model call, a
few milliseconds, driven entirely by the declarations. Resources this session already
has an active note on are dropped.

Delivery is a new watcher-live type, `resource`. It reuses every existing gate — the
per-type switch, `sessionReady` (which excludes the reviewer), the carve-outs,
freshness, `safeDeliveryText`, the per-turn reservation and the shared rate windows —
and skips only the confidence gate, because there is nothing to be unsure about. The
reservation is **per turn across all types**, so an observation on a turn a verdict
already claimed is skipped and says why.

Off by default. In shadow mode it records a decision of type `resource` carrying the
exact text that would have been sent, so it earns its way live on its own graded
record like every other type: `keep watcher live resource` after 30 decisions at 90%
**on the current judge prompt** — grades given on an older prompt still show in
`keep decisions stats`, under their own hash, but do not graduate the new one.

Two kinds of reason not to deliver, graded differently. A reviewer session, or a
turn that pushed, paused, or asked Owner something irreversible, is never nudged
whatever happens — nothing is recorded for those, because a decision Owner grades
should be one that would have been acted on. A session that is merely mid-turn,
has exited since, or is on a card that is not active right now *is* recorded, with
a `deferredReason` saying what stopped it: grading only the turns whose author
happened to be idle would graduate the type on a sample that is not the fleet.
One session may add at most three resource observations to the ledger per hour, so
an afternoon spent in one declared resource cannot fill the grading queue with the
same sentence.

The message:

```
[keep watcher] this turn touched staging (command terraform apply -auto-approve) and left no state note.
If it changed how staging behaves for other sessions, run:
keep note castle-sandboxes --scope staging -m "<what is true now>" --for +2h
```

Active notes and holds are also fed into the judge's context (`STATE NOTES` and
`HOLDS` blocks, five and three rows, each clipped to 160 characters), and the prompt
says that a turn contradicting one is drift. So the same information that tells a
sibling session what is true also becomes the standard the watcher judges against.

## What is and is not gated

| | Blocks anyone? |
|---|---|
| Hold | Only `keep wait --no-hold` waits on it, and only deliberately. Advisory otherwise. |
| Resource declaration | No. It is a matcher list, not authorization. |
| State note | No. Not a wait, not a refusal, not a precondition anywhere. |
| Expired note | No. One nag to its author, one line in the brief, one lint finding. |
| Watcher observation | No. Shadow by default; live delivery is one message behind the same switch every other type is behind. |

## Lint

- `note-expired` — a note past its window, neither extended nor cleared, an hour
  later. Fleet rule, id `note:<id>`.
- `resource-bad-matcher` — a declaration whose regex does not compile or whose glob
  is empty. Fleet rule, id `resource:<project>:<name>`.
