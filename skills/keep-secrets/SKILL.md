---
name: keep-secrets
description: Get a secret, API key, token, password or credential file from Owner without it passing through the conversation - keep secret request writes it straight to a file on this machine after Owner pastes it in the Keep console. Use whenever a task needs a secret you do not have, instead of asking Owner to paste it into chat or handing him a one-off shell snippet to run.
---

# Keep — secret handoff

When work needs a secret you do not have (an API key, a token, a password, a service
account JSON, a private key), ask for it with `keep secret request`. Owner pastes it into
a panel the Keep console shows on **this session**, and it is written straight to a file
on the machine this session runs on (the Mac or a node such as aws1), mode 0600. The value
never appears in your transcript, the terminal, a card, a log or git.

Never do any of these instead:

- ask Owner to paste a secret into the chat or into your terminal prompt;
- hand him a one-off command (`read -s X; echo "$X" > file`, `pbpaste > …`, an `ssh … cat`)
  to run himself;
- copy a credential from another machine, another agent's files, browser state or a
  signed-in CLI. Each machine gets its own copy, requested on that machine.

## Asking

```
keep secret request GITHUB_TOKEN --to ~/castle/castle-www/.env --key GITHUB_TOKEN \
  -m "Fine-grained PAT, contents:read on castle-www, for scripts/release.sh"
```

- `<NAME>` is a label Owner sees. `-m` says what it is and where he gets it: which
  account, which scopes, which dashboard. Be specific; he acts on this line alone.
- `--to <path>` is where it lands, under your home directory. With `--key VAR` the file is
  a dotenv file and the line `VAR=value` is added or replaced, leaving the other lines
  alone (an `export ` prefix is kept if the file uses one). Without `--key`, the whole
  file is the value. Pass `--multiline` for PEM keys, JSON files and the like.
- `--replace` overwrites an existing file or key. Without it, a destination that already
  holds a value is refused. Check first; if it is there, you probably do not need to ask.
- `--card <id>` names the card the secret is for.

The CLI refuses a destination outside your home directory, anything under `~/keep`, a
symlink, and a file inside a git repository that is not gitignored. Add the path to
`.gitignore` (and commit that) before asking, rather than choosing somewhere odd.

Then **end your turn**. Say in your final message what you asked for and why, in a
sentence: the console shows the request as a panel above your terminal when Owner opens
this session. There is no notification, so your message is how he learns of it. When it
is written, a `[keep] secret NAME written to …` message arrives in this session. If
he declines, the message says so with his reason; do not ask again without a new one.

`keep secret status` lists this session's requests. `keep secret wait <id> --for 10m`
blocks until one is answered, for the rare case where you must stay mid-turn. Requests
expire unanswered after 24 hours.

When you no longer need a secret you asked for (you got it another way, the plan
changed), take the request back with `keep secret cancel <id> -m "why"` rather than
telling Owner to ignore or decline it: its panel keeps covering your terminal in the
console until it is answered. Asking again for the same file and key reuses the open
request (or, with a different `--replace` or `--multiline`, replaces it); it never adds a
second panel.

## Using it

The file is the only copy you get. Use it without printing it:

- dotenv file: `set -a; . ~/castle/castle-www/.env; set +a; ./scripts/release.sh`, or the
  tool's own env-file flag (`--env-file`, `dotenv -e`).
- whole file: pass the path (`GOOGLE_APPLICATION_CREDENTIALS=~/.config/x/sa.json`,
  `gh auth login --with-token < ~/.config/x/token`).
- to check it is there: `test -s <file>`, or `grep -c '^VAR=' <file>`. Never `cat`,
  `echo`, `head` or `grep` it without `-c`/`-q`, and never put it in a command line, a
  commit, a check-in, an artifact or a message.

If a secret ends up somewhere it should not (a log, a transcript, a commit), stop and tell
Owner so he can rotate it. Do not try to scrub it silently.
