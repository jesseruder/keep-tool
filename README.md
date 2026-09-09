# Keep

A local work registry and console for Claude Code and Codex. Keep tracks tasks,
experiments, agent sessions, dependencies, and work that needs your attention.
Each person runs their own Keep and owns their own private, Git-backed registry.
This repository contains application source, never your cards or session history.

The full automation suite is included: fleet reviews, scheduled checks, dependency
notifications, usage-limit recovery, compaction, session cleanup, and daily ideas.
The first distribution targets macOS. The browser console and terminal host ship
with the CLI; the optional desktop shell is in `desktop/`. The mobile app is not
part of this initial source distribution.

## Screenshots

The console shared by Keep Desktop and the browser, shown with synthetic demo
projects and terminal output. No private cards or sessions are pictured.

**Triage:** see which sessions need your input and respond beside their terminal.

![Keep Triage view with an agent question and its terminal](docs/images/triage.png)

**Watch:** pin sessions side by side to follow work across projects.

![Keep Watch view with two pinned agent terminals](docs/images/watch.png)

## Install

Prerequisites: Node 22+, Git with a configured name/email, and an authenticated
Claude Code installation for reviewer and headless automation. Codex is optional.

```sh
git clone https://github.com/jesseruder/keep-tool.git
cd keep-tool
npm ci
npm link
keep init
keep setup hooks
keep doctor
keep service install
keep service start
```

Open `http://localhost:7777/app`. Launch `keep-reviewer` in an interactive terminal
to create a host-owned reviewer pane for review ticks. The terminal attaches to that
pane; the reviewer also appears in the console. Both agent skills are bundled; the reviewer
registers through its Claude SessionStart hook. Existing hook settings and skills
are preserved: setup backs up settings and refuses to replace another skill.
See [agent integration](docs/agent-hooks.md) for Codex event adapters.

`keep init` creates an empty registry at `~/keep`; use `--dir /path/to/private-data`
to choose another location. It refuses nonempty directories. It does not configure
a remote, upload anything, launch an agent, or start background services.

## Desktop app (macOS)

Keep Desktop adds a native window, Dock badge, and desktop notifications to the
console. Complete the CLI setup above first: the app connects to
`http://localhost:7777/app` and requires the Keep daemon to be running.

To build it, install Rust with Cargo and the Xcode Command Line Tools (or Xcode),
as described in the [Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos).
Then run these commands from the `keep-tool` checkout:

```sh
npm ci --prefix desktop
npm run desktop:build
open desktop/src-tauri/target/release/bundle/macos/Keep.app
```

To install the built app for everyday use, copy `Keep.app` from that folder into
Applications using Finder. The build also produces a DMG under
`desktop/src-tauri/target/release/bundle/dmg/`.

For development, use `npm run desktop:dev` instead of the build command. Closing
the window hides the app; Quit exits it. Enable notifications from the bell inbox
when prompted. If the launcher stays on its waiting screen, check
`keep service status` and confirm the daemon is listening on port 7777.

The app uses the local console, so most CLI and web changes need no native rebuild.
Rebuild it when the desktop shell changes. See [desktop details](desktop/README.md).

## Configuration

`~/.config/keep/config.json` selects your private registry and environment defaults:

```json
{
  "version": 1,
  "dataDir": "~/keep",
  "env": {
    "KEEP_NO_PUSH": "1",
    "KEEP_SYNC": "0",
    "KEEP_HOST": "127.0.0.1",
    "KEEP_REVIEWER_MODEL": "fable",
    "KEEP_IDEAS_MODEL": "fable",
    "KEEP_OPEN_CLAUDE_FLAGS": "",
    "KEEP_OPEN_CODEX_FLAGS": ""
  }
}
```

Environment variables override configuration. `KEEP_CONFIG` selects another file.
An explicit `KEEP_DIR` without `KEEP_CONFIG` selects an isolated registry without
loading the default configuration. Model settings name models available to your
Claude installation; `keep doctor` checks executables, not model entitlements.

Starting the daemon enables the automation schedulers. Model-backed work uses your
agent account. Scheduled recipes run in agents, and the reviewer is an ordinary
interactive agent with the permissions you give it. Set launch permission flags
explicitly if your workflow needs unattended privileged actions. Compaction keeps
its existing `KEEP_AUTO_COMPACT` control; see the [command reference](docs/reference.md).

Remote access requires setting `KEEP_HOST` explicitly; the default binds only to
loopback. Remote API requests use the private registry's `.keep/token`.
Keep that token and the registry private.

Git commits stay local by default after initialization. To sync a registry, add a
**private** Git remote, set the branch's upstream, set `KEEP_SYNC=1`, and remove
`KEEP_NO_PUSH` to restore background pushes outside agent sessions. Agent pushes
still require session authorization (`KEEP_ALLOW_PUSH=1`). The code repository
and registry must have separate remotes. Never point a registry at keep-tool.

Slack polling activates only when `watch/slack.json` in your private registry names
channels. Its adapter currently requires a compatible MCP CLI configured through
`KEEP_JESSE_MCP` (legacy variable name); it is not a standalone Slack integration.
Phone pushes use `KEEP_PUSH_WEBHOOK`; speaker notifications require an `announce`
command. Credentials belong in the local environment/configuration, never source.

Some legacy schema and command names remain for compatibility: `castle`/`personal`
scope tags, `keep ask --jesse` (the registry owner), and model-family budget rules.
These do not indicate a shared registry. Broader customization is follow-up work.

## Develop and update

Develop in this code checkout. `npm link` points the CLI at it, so edits take effect
on the next command. `keep service restart` restarts only the daemon, preserving
host-owned terminals. Host changes use `keep host reload`; stop/start affects all
hosted sessions. Rebuild the desktop shell only when its native code changes.

```sh
git pull --ff-only
npm ci
npm test
keep service restart
```

For an existing registry, select it with `KEEP_DIR` or write the configuration above
instead of running `keep init`. Keep its Git history intact. Existing services and
skills require a deliberate migration; setup will not overwrite them.

## Public source checks

Run `npm run check:public` before committing or publishing. It checks the staged
file paths and scans tracked source for credential-shaped strings. `npm pack` also
runs that check. Run an independent secret scanner before the first public push:

```sh
gitleaks dir . --redact --no-banner
gitleaks git . --redact --no-banner
```

The source extraction has fresh history. Cards, archives, digests, reviews, watch
configuration, gated-step registries, runtime state, private reports, and machine
service files are excluded. Tests use synthetic fixtures. Updates should be made
here rather than by copying whole private checkouts back into this repository.

See the [full command reference](docs/reference.md), [Keep skill](skills/keep/SKILL.md),
[fleet reviewer procedure](skills/fleet-review/SKILL.md), and [desktop README](desktop/README.md).
