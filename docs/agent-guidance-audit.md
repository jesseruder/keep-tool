# Agent-facing guidance audit — 2026-09-09

Scope: Keep's instructions delivered to working Claude/Codex sessions, scheduled
runs and the fleet reviewer. This is not a review of every unrelated personal skill
or third-party plugin installed on the machine.

## Surfaces checked

| Surface | Result |
| --- | --- |
| `skills/keep/SKILL.md` | Added turn-scoped handoffs, one-minute cadence, card/conversation distinction, cron lifetime, dismiss/close/restart distinctions. |
| Claude and Codex Keep skill links | Both resolve to this repository's canonical skill, not divergent copies. |
| `keep help`, `keep checkin --help`, README | Added missing recipe/handoff flags and semantics; documented lifecycle command and current scope/ask flags. |
| SessionStart context | Points both agents at the same skill file; no Claude-only `/keep` instruction. Includes a short scheduling/readiness reminder and warns against duplicating daemon-scheduled checks. |
| Stop enforcement reminder | Says an unattended question may be missed, not that it is invisible; explicit input is already represented in the UI. |
| In-thread scheduled delivery | Read-only scope, clear/reschedule recipe, and `--handoff needs-input` override are explicit. Message-size test preserves the full card lookup. |
| Headless check prompt | Already read-only, fences historical context, requires `VERDICT:`; daemon lands its result. Deliberately not the same check-in workflow as interactive delivery. |
| Dependency unblocks | Already fence upstream evidence as data and explicitly deny new deploy authority. |
| Fleet review skill / compaction prompt | Preserve cross-day patterns; no per-tick compaction. Corrected batch count, nothing-new omissions, partial landing failures and exact scoped holds in the installed fleet-review skill. |
| Global Claude/Codex instructions | Keep and review obligations remain compatible; tool-specific review mechanisms intentionally differ. Neither global file changed. |

## Installed Keep hook coverage (read-only inspection)

- Claude: lifecycle observers on UserPromptSubmit, PermissionRequest,
  PostToolUseFailure, SubagentStart/Stop, SessionStart/End, Pre/PostToolUse and Stop;
  separate startup context, stop enforcement, notification, pre/post Bash and exit
  handlers are present.
- Codex: lifecycle observers on UserPromptSubmit, PermissionRequest,
  SubagentStart/Stop, SessionStart/End, Pre/PostToolUse, Stop and Interrupt;
  separate startup/stop, approval, question and pre/post-tool handlers are present.
  The question matcher matches both bare and qualified synchronous/async input tools.
- No hook configuration or trust setting was changed by this audit (the separate
  `clean-up-agent-hooks-for-keep-app` task owns obsolete cmux hook cleanup). Installed definitions do not
  prove that every already-running client has loaded them. Transcript fallback and
  the existing adapter tests remain necessary; do not restart agents merely for this audit.

The fleet-review skill is the repository's `skills/fleet-review/SKILL.md`; the
installed copy at `~/.claude/skills/fleet-review` is a symlink to it (as
`~/.claude/skills/keep` already was), so `bin/review-eval.js` and the live reviewer
read the same file. Its procedure is two normal tool calls (bundle and land), treats
a further call as a bundle deficiency to report rather than a habit, omits unchanged
cards, preserves successful siblings when an individual landing fails, and checks
resource scope overlap before reporting a hold violation. The two copies had drifted
(Jesse-specific wording and newer sections only in the installed copy) until they
were unified on 2026-09-10.

## Drift prevention and limits

`bin/agent-guidance.test.js` checks the scheduling contract across the shared skill,
README and emitted CLI help. Scheduler and message-bound tests check the runtime
cadence and injected instructions; scenario tests check the corresponding behavior.
These are targeted contracts, not a claim that prose completeness can be proved
automatically. New commands or behavior changes should update the canonical skill,
CLI help, relevant injected messages and a regression scenario together.
