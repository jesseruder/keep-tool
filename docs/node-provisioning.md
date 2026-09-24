# Bringing a node to parity

A node runs sessions for the daemon, and a session there only behaves like one on the
daemon node when the machine is set up the same way: the same skills, MCP servers,
plugins, hooks, instructions, tools, repos and logins. This page is the checklist for a
machine joining the fleet, and `keep node audit` is how you find out what is still
missing, before a session finds out for you.

Start from `keep nodes add` and `keep node init` (see `keep help`), which put the host on
the node and connect it to the daemon. Everything below is what makes that host's
sessions useful.

## What `keep node audit` covers

```sh
keep node audit <name>           # grouped report: only on the daemon node, only on the node, differing
keep node audit <name> --all     # also every per-project memory dir, worktree and tool location
keep node audit <name> --json    # the structured diff
```

Run it on the daemon node. It collects the daemon node's inventory locally and asks the
named node's host for its own (the host's `inventory` verb, `bin/node-inventory.js`),
both over the same directories: each managed Claude and Codex account's config
directory, as `~/...`, and the repos under `~` and `~/wt`. It then prints, section by
section, what exists only on one side and what differs. It is a report, not a gate: it
exits 0 whatever it finds.

The sections:

- `system`, `env`: platform, node and nvm versions, time zone, and what an interactive
  login shell sets (`PATH`, `ANDROID_HOME`, `JAVA_HOME` and a few others).
- `tool`, `tool-version`, `tool-path`: which common CLIs are on that login `PATH`, and the
  versions of the ones that matter most. Tools that exist only on one platform (`brew`,
  `apt`, `xcodebuild` and so on) and where a tool lives are counted, not listed, unless
  you pass `--all`.
- `claude:<dir>`, one per Claude config directory: user- and project-scope MCP servers,
  `settings.json` and `settings.local.json` keys and hooks, `CLAUDE.md`, skills (by
  content hash), commands, agents, output styles, installed plugins and marketplaces,
  whether credentials are present, the logged-in account, and per-project memory
  directories (counted by default).
- `codex:<dir>`, one per Codex profile: top-level model defaults, MCP server and profile
  names, `AGENTS.md`, skills, prompts, and whether `auth.json` is present.
- `pi`, `agents-shared`: Pi's `AGENTS.md`, settings, skills and extensions, and the shared
  `~/.agents/skills` directory.
- `dotfile`, `gitconfig`, `ssh`, `bin`, `misc`: shell rc files and other dotfiles by
  content hash, git identity and settings, ssh key and config file names, every entry in
  `~/bin`, and the presence of CLI config directories.
- `repo`: every checkout under `~` and `~/wt` (two levels down), with branch, head,
  origin, whether it is dirty, which `.env*` files it has (names only) and whether its
  dependencies are installed. Worktrees under `~/wt` are counted by default.
- `login`: who each CLI is logged in as (GitHub, AWS, Heroku, npm, EAS, Docker,
  Tailscale, 1Password) and whether ssh reaches GitHub.
- `keep`, `android`: the Keep checkout and its commit, the registry directory, the node
  token, and the Android SDK pieces.

What leaves each machine follows fixed rules, so it can be read without exposing a
credential:

- Credential files (`.credentials.json`, `auth.json`, `.netrc`, `~/.aws/credentials`)
  are reported as present or absent. Other files (dotfiles, `~/bin` scripts, skills,
  `CLAUDE.md`, `config.toml`) are reported by a short content hash, never their content.
- Command lines (hooks, MCP servers, the status line) go through an allowlist. Only
  the executable, bare flags, shell operators and words or paths made of plain name
  characters are shown. A `NAME=value` word shows as `NAME=***`, or `***` when the name
  says secret. The word after a credential flag (`-u`, `-p`, `-H`, `--pass`, `--token`
  and the like) is `***`, and every other word is `***` too. The line ends with a hash
  of the whole line, so two machines still compare exactly.
- URLs keep their scheme, host and plain path segments. User info, query values and
  `;` parameters are dropped, and long or random-looking segments become `*<hash>`
  markers.
- Names (skills, servers, settings keys, config tables and their keys) are shown.
  Values of settings, environment variables and top-level config keys are scrubbed:
  a secret-named value is `set`, and header values, credential flags, token shapes and
  embedded URLs are masked. Objects and config tables are reported by their key names
  and a hash, never their values.
- Logins are reported by the identity each CLI prints, such as an account name or an
  ARN.

When either side hit its deadline (about fifty seconds), the report starts with a
warning naming the sections it cut short. Their rows are summarised rather than
listed, because what is missing from them is not a real difference; run the audit
again. Rows of a file one side could not read (too large, unparseable or unreadable)
are summarised the same way.

A node whose host predates the `inventory` verb is refused with a message saying so:
on that node, `git pull` in Keep's checkout and run `keep host reload`. The reload keeps
running sessions.

## What to apply on the node

Work down the audit's report. Each item names where it lives, so apply it once per
config directory where that is the unit.

- **Global instructions.** Copy the global `CLAUDE.md` into every managed Claude config
  directory (the default one and each secondary account's), `~/.codex/AGENTS.md` into
  every Codex profile that reads it, and Pi's `AGENTS.md`.
- **Personal skills.** Copy or link your own skills directories into each Claude config
  directory's `skills/`, into `~/.agents/skills` for the agents that share it, and into
  Codex and Pi where you use them.
- **Keep's own setup.** Run `keep setup hooks` (hooks and the core skill pack in every
  managed Claude account), `keep setup skills` with the packs you use, and
  `keep setup --shell --write` for the shell wrapper.
- **The skill packs in every config directory.** `keep setup skills` links the packs into
  `~/.claude/skills` and `~/.agents/skills` only. A secondary Claude config directory
  does not get them from that command, which is the usual reason the audit shows the
  pack on the daemon node's secondary accounts and not on the node's. On the daemon node
  a secondary account shares the default one's `CLAUDE.md`, `skills`, `rules`,
  `commands`, `agents` and credential-free settings through
  `keep accounts setup <id> --share-from <source>` ([account setup](account-setup.md));
  the audit's `entry:<name>` rows show which entries are links and to where. A pane-only
  node refuses registry commands, so make the same links there by hand, or link the
  pack directories into each secondary directory's `skills/`.
- **Claude plugins, per config directory.** For each directory, with
  `CLAUDE_CONFIG_DIR` pointing at it: `claude plugin marketplace add <source>` for each
  marketplace, then `claude plugin install <plugin>@<marketplace>`. Plugins and
  `enabledPlugins` are per directory.
- **MCP servers, per config directory.** User-scope servers with `claude mcp add --scope
  user ...` under each `CLAUDE_CONFIG_DIR`; project-scope servers from inside each
  project with `--scope project` or `--scope local`, as the audit's
  `mcp:project:<project>:<name>` rows show them. Put credentials in them on the node
  itself (see below), never by copying the file that holds them.
- **Settings.** `settings.json` keys, hooks and permissions per config directory; the
  audit compares them key by key.
- **Codex.** `config.toml` model defaults, MCP servers and profiles, `AGENTS.md` and
  skills, in each Codex profile directory.
- **Pi.** `settings.json`, `models.json` (without its keys), skills and extensions.
- **`~/bin` scripts and dotfiles.** The scripts your sessions call, and the shell rc lines
  that set `PATH` and the SDK variables.
- **CLI tools.** Whatever the `tool` section shows missing, from the platform's package
  manager.
- **Repos.** Clone the checkouts sessions work in to the same paths (every node shares
  one home path), then install their dependencies. Worktrees are made per task and need
  not be mirrored.

## What only the owner can do

Every login and every credential is created on the node itself, by the owner. Credential
files are never copied between machines: not `.credentials.json`, `auth.json`,
`~/.aws/credentials`, `.netrc`, `.npmrc` tokens, `.env` files or ssh private keys. A
copied token is a second holder of one secret, and some of them are bound to a device
anyway.

- Claude accounts: log in to each account in its own config directory (`claude` with
  `CLAUDE_CONFIG_DIR` set, then `/login`).
- Codex accounts: `codex login` with `CODEX_HOME` set to each profile directory.
- MCP servers that use OAuth: `claude mcp login <name> --no-browser` in each config
  directory that has them, and any company gateway tokens your servers need.
- GitHub: `gh auth login`, and an ssh key for git over ssh, added to the account.
- AWS: an instance profile on a cloud machine, or `aws configure` / SSO on anything else.
- Heroku, npm, EAS, Docker and any other CLI the audit's `login` section shows logged in
  on the daemon node.
- Per-project `.env` files: recreate them from the source of truth for each project.

## After applying

Sessions already running on the node keep the MCP servers, skills and settings they
started with. Restart them (or open fresh ones) to pick up what changed. Run
`keep node audit <name>` again; what remains should be only what is meant to differ.
