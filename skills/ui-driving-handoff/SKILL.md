---
name: ui-driving-handoff
description: Route routine browser and mobile UI flows to cheaper models and keep automated browser runs from disrupting the Mac desktop. Use for multi-step UI navigation, forms, screenshots, device QA, and headless browser tests or captures (including Playwright/Puppeteer). Skip single quick UI actions and API-only work.
---

# UI driving handoff

Spend the primary model on the goal, test plan, and interpreting findings. Hand a
complete, bounded UI flow to one cheaper worker, rather than handing off each click.
Owner has authorized this routing without a model-choice question. Honor explicit
user model choices. Single quick actions can stay in the primary when a handoff
would cost more than it saves.

## Browser Bridge for interactive checks

For an interactive UI smoke check without a user-selected browser, first look for
the `browser` MCP tools and call `tabs_context_mcp`. Use a disposable app fixture
when the check would otherwise change live state. Before reporting browser
verification unavailable, check whether Browser Bridge can perform the check.
The Linux headless requirement below applies to standalone automated browser
tests and captures, not Browser Bridge checks.

Browser Bridge drives Jesse's Edge through `~/keep-tool/browser-bridge`. Use its
`navigate`, `computer`, `read_page`, `find`, `form_input`, and other tools after
`tabs_context_mcp`. Each session gets its own tab group; tab-scoped tools refuse
tabs from other groups. A subagent shares its parent's MCP connection, so give a UI
worker the tab id from `tabs_context_mcp`, not a URL to reopen. Claude in Chrome
and the Codex Chrome plugin should stay off beside Browser Bridge.

## Headless browser tests on the Mac

Run routine automated browser tests and captures in an existing Linux container or
remote browser environment, using a dedicated headless browser such as
`chromium_headless_shell`. Launching the installed macOS Chrome with `--headless`
can briefly show an app in the Dock on every launch. Do not silently fall back to
`/Applications/Google Chrome.app` when the headless environment is unavailable;
report the missing prerequisite instead.

Use local Chrome when Mac-specific rendering is explicitly part of the requested
check. Preserve a user's chosen browser and existing interactive sessions; this
rule applies to standalone automated runs. Browser test scripts alone do not
require a UI-driving handoff; apply the worker routing below to interactive flows.

## Choose the worker for this harness

- **Claude Code:** use an `Agent` subagent with `model: "sonnet"` and a general-purpose
  role that can access the required UI tools. Keep UI work within Claude; do not
  send it to Codex. Use medium effort if the harness exposes a supported per-agent
  effort control; otherwise use the model default, without inventing tool arguments.
  Escalate ambiguous screens, subtle visual bugs, or a substantive failure Sonnet
  cannot resolve to an Opus subagent (`model: "opus"`). The Fable primary continues
  to own planning and interpretation.
- **Codex with an Astra primary:** use `spawn_agent` with `agent_type: "worker"`,
  `model: "gpt-5.6-terra"`, `reasoning_effort: "medium"`, and `fork_turns: "none"`.
  Give it a self-contained brief; full-history forks cannot take model overrides.
  Bring ambiguous visual findings or a substantive failure Terra cannot resolve
  back to the Astra primary for diagnosis and the difficult portion of the flow.
- **Already-cheaper primary or assigned UI worker:** perform the assigned flow
  directly. Do not recursively delegate. A Claude Opus primary may delegate routine
  flows to Sonnet; Sonnet/Haiku primaries and non-Astra Codex primaries stay direct
  unless Owner asks otherwise.

In Claude Code, hand off the bounded flow and wait when there is no independent
work for the primary. In Codex, respect the active harness's spawning constraints:
if it requires useful independent work alongside a worker, delegate only when such
work exists (for example, preparing acceptance checks or examining related code).
Do not manufacture parallel work or duplicate UI actions to justify spawning.
If the harness does not permit delegation, continue in the primary and briefly
explain why.

## Preserve access and ownership

Confirm that the worker can access the required browser or device through its
available tools. Do not assume that browser handles, REPL variables, native-app
access, or authenticated sessions transfer between agents. Give stable identifiers
such as a tab URL/id, device serial, and working directory where available; the
worker must select the target using its own documented tool entry points.
If access cannot be shared or established through supported tools, return to the
primary and drive there. Do not create a new login/session or switch tool backends
merely to obtain a cheaper model without considering the user's specified target.

One agent owns a browser tab or device at a time. The primary can do independent
work while the worker drives; it must not also click, type, navigate, or rotate
that same target. On escalation, have the worker stop and return the current state
before another agent takes control. Reuse the worker for related follow-ups.

## Handoff and results

Supply the objective, starting state, target browser/device, required flow,
acceptance criteria, and evidence to return. Include existing authorization and
stop conditions for consequential actions; delegation grants no new permission.
For Android, when those skills are installed, the driver must read
`android-device-qa` before adb/device actions and `android-remote-build` when
building or running QA. Preserve other relevant skills
and repository instructions. Prefer existing purpose-built APIs or CLIs when those
already satisfy the task without UI automation.

Name an evidence directory in the brief and require every screenshot, flow file,
recording and debug dump to land there: the session scratchpad in Claude Code, or a
fresh `/tmp/<card-or-task>/` directory for a Codex worker. Nothing goes under a
project root, even a worktree; shared checkouts are read by other sessions and any
`git add -A` there commits the files. Tools that write relative to the process
working directory need the worker to `cd` into the evidence directory first.
Maestro is the known offender: `takeScreenshot: <name>` saves `<name>.png` into
the cwd, not next to the flow file or under `--debug-output`. Keep the raw run
in scratch; copy only the shots a check-in cites with `keep artifact <card>`, since
artifacts are committed to the registry for good.

The worker returns completed steps, screenshots or other evidence, observed
failures, remaining uncertainty, and final UI state. It reports what it observed
without claiming unverified success. It does not expand a test flow into code fixes,
launch an independent code review, or update the parent's Keep card.

Escalate a substantive blocker after reasonable recovery; do not repeatedly retry
an unchanged failing interaction. The primary assesses evidence and completes any
missing checks, avoiding repetition of already-successful UI flows. Pure UI work
does not require a code reviewer; code changes follow the existing review rules.
