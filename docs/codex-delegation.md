# Delegated Codex jobs

`keep codex` runs the installed Codex companion through a registered Codex account. It selects that account's `CODEX_HOME`, prepares its shared capabilities, and gives the companion a state and broker namespace tied to both the account id and the physical profile directory. It does not copy authentication data.

Run every command for one job from the same workspace directory. Resolve the account once, then keep passing that explicit id for resume lookup, launch, status, result, and cancellation. This prevents a later default-account change from moving a job to another profile.

```sh
cd /path/to/worktree

keep codex --account codex-secondary context --json
keep codex --account codex-secondary task-resume-candidate --json
keep codex --account codex-secondary task --background --write \
  --model gpt-5.6-sol --effort high \
  "Implement the requested change and report the tests."
keep codex --account codex-secondary status <job-id> --json
keep codex --account codex-secondary result <job-id> --json
keep codex --account codex-secondary cancel <job-id> --json
```

Omit `--account` only when starting a new lifecycle that should use Keep's configured default Codex account. `context --json` resolves that default without creating account state, preparing the profile, or starting a process. Its output contains the safe account id and label, workspace, companion script, state directory, and jobs directory. It contains no environment variables, profile directory, or authentication data.

The wrapper forwards companion task arguments unchanged, including `--background`, `--write`, `--fresh`, resume controls, `--model`, and `--effort`. Keep supports the companion lifecycle commands `task`, `task-resume-candidate`, `status`, `result`, and `cancel`. Review automation should use `task` with a read-only review prompt so its requested model, effort, and access remain explicit; the wrapper does not expose the companion's direct review shortcuts.

The selected profile gets a separate companion state tree and broker endpoint. A profile-directory change for the same account id creates a new namespace, while saved manifests keep old jobs discoverable by `keep codex-jobs`, `keep codex-jobs --reap`, and `keep stalled`. Cleanup invokes `cancel` with the exact namespace and profile that owns each saved job. Legacy companion state remains discoverable and is not moved or rewritten.

The wrapper preserves the parent Claude session id, transcript path, and Claude configuration directory so companion jobs remain attributable to their originating Claude session. It removes inherited Codex broker endpoints, pane identity, client tokens, and another account's Keep marker before applying the selected Codex profile.

Unknown account ids and Claude accounts fail before profile setup or process creation. Launching a Claude companion from Codex is not supported.
