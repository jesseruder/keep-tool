# Codex plugin broker ownership patch

`1.0.6-broker-ownership.patch` targets the installed OpenAI Codex Claude Code plugin
1.0.6 sources, including an existing LOCAL PATCH guard; this is an optional, version-specific patch. It records
broker session ownership, cwd, and creation time; checks process identity before
killing an unresponsive recorded broker; exports the state root; and cleans up all
brokers owned by an ending session, preserving the foreign-live-job guard.
SessionEnd uses a 700 ms socket cap per phase and runs the workspace sweep in
parallel (about 1.4 seconds of socket waits across both phases).

Apply manually from this repository:

```sh
patches/codex-plugin/apply.sh
# Or supply a different cache directory:
patches/codex-plugin/apply.sh /path/to/codex/1.0.6
```

The script skips an already-applied patch and fails if neither forward nor reverse
application works. The unified diff also applies with `patch -p1` from the cache
directory. Existing LOCAL PATCH guidance remains in place.

**Plugin cache updates overwrite local patches. Re-run `apply.sh` after updates**;
if the new version differs, inspect and refresh the patch rather than forcing it.
This repo only delivers the patch; it does not apply it automatically.

Existing brokers have no owner until replaced. Keep's independent reaper handles
those via `keep codex-jobs --reap --dry` (preview), then `keep codex-jobs --reap`.
It also reaps abandoned brokers during the daemon's stalled sweep. Live job workers
protect a broker; otherwise missing workspaces/owners, orphan processes, stale
records, and six hours of inactivity qualify for cleanup.
