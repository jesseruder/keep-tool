# Explicit force restart and recovery

Normal queued restarts remain conservative: an unviewed idle prompt, no pending
input, and verified background-job/helper safety. Force restart is a separate
operator action, never an automatic-cleanup fallback. Obtain explicit approval
to interrupt the exact conversation and its local child processes first.

Use `/api/state` to resolve the exact session and pane IDs, then:

```
keep force-restart <session-id> --pane <pane-id>
```

This queues a daemon-owned transaction (normally picked up within ten seconds),
so the requesting terminal can exit without killing the recovery coordinator.
It attempts graceful Close before escalating termination. Captured process
identities are PID plus start time, not mutable command text. The same pane and
conversation are resumed, preserving the observed explicit permission-bypass
flag. This does not preserve in-memory jobs, remote work, or arbitrary launch
arguments. Detached jobs that escaped the observable process tree are not proven
stopped. Do not use force restart to correct a status label.

Check `/api/state`'s `restarts` entries for the outcome. `done` means the resumed
agent was observed in the pane, not that startup hooks or scheduled polling were
restored. Verify those separately. No force buttons are added to the console.

If interrupted after preparation, the private restart journal retains the original
pane, process identities, phase, and replacement token with `recovery-needed`.
Inspect that entry and the live pane before explicitly retrying:

```
keep force-restart <session-id> --pane <pane-id> --recover
```

Recovery recognizes its own replacement if the host reply was lost, refuses to
kill reused PIDs, and will not launch over a changed pane or another live instance.
It does not automatically repeat a failed destructive transaction after a daemon
restart. A different pending restart must be cancelled before requesting force;
an interrupted recovery journal cannot be discarded through Cancel.
