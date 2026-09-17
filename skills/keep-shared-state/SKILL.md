---
name: keep-shared-state
description: Coordinate with other sessions before touching shared state - keep who, keep hold/release, keep note, keep resources, and gated steps (keep steps, keep step claim/run/done/fail). Use before a deploy, migration, restart, secret rotation, terraform run, shared test device, or any change to how a shared resource behaves for other sessions.
---

# Keep — shared state

Several sessions work in the same projects at once. Before a deploy, migration, restart,
secret rotation, or anything else that touches shared state, look, then say what you are
doing. All of this is advisory coordination: it is not permission (`keep allow` is), and
it does not replace a gated-step claim.

## Look first

`keep who <project>` lists the live sessions, holds and notes in a project;
`--scope <resource>` filters holds only. `keep holds` and `keep notes` list everything.

## Holds ask people to wait

Claim a quiet window with `keep hold <project> --for +15m -m "why"`, and
`keep release <id>` as soon as it is safe. Holds are visible to every session that starts
in that project and to the fleet reviewer.

- Scope narrow holds: `--scope sandbox-hosts`, `--scope browser-hosts`, `--scope terraform`
  (repeat the flag for every resource touched). Scopes are exact project-local labels, not
  aliases or inferred from prose.
- Match the actual next action: a host hold does not block unrelated browser work, but
  both actions using shared Terraform must include `terraform`.
- Shared hardware is the exception to project-local labels: `--scope device:<serial>` (for
  example a test phone) is seen from every project, so hold the device under your own
  card's project and check it with `--scope device:<serial>`.
- Omitted scopes, including legacy holds, remain project-wide. Do not reinterpret or
  release someone else's hold.
- Wait for one to clear with `keep wait --no-hold <project> --scope <resource> --for 8h`
  as a background command.

## Notes say what is true now

When you change how a shared resource *behaves* for other sessions — staging in home-only
mode, a feature flag flipped, a service pointed somewhere else, an infra value raised for
a canary — write `keep note <project> --scope staging -m "what is true now" --for +2h`.
It is broadcast to sibling sessions in this checkout, shows at their session start and in
`keep who`, and expires on its own. Extend it with `keep note --extend <id> --for +2h` or
end it early with `keep note --clear <id>`. Notes never block anything and are not a
substitute for a hold when you genuinely need a quiet window.

`keep resources <project>` lists the resources this project has declared and the scope
names a note may use; `keep resources --check <project> "<command>"` says which resource a
command touches.

## Gated steps

Before changing paths owned by a gated step, run `keep steps <project>`, claim it with
`keep step claim <project> <step> -m "why"`, and run it through `keep step run` so a
`landed` step uses a pinned revision in a clean worktree.

- A failed step prints its log path and is recorded as a failed run; your claim stays with
  you, so fix it and run it again — there is no bookkeeping to settle first.
- Use `keep step done` after running it by hand, and `keep step fail -m "why"` to give up
  the lane.
- If someone else holds the step, pass `--wait`; Keep will tell the session when that run
  lands and its queued claim is next.
- `keep step help` prints the step commands.
