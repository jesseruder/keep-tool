#!/usr/bin/env python3
"""Isolated Codex rollout-only account-transfer smoke test.

The script uses temporary CODEX_HOME directories, a local fake Responses API,
and fake bearer tokens. It never reads a user's Codex configuration or auth.
"""

import argparse
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    requests = []
    response_number = 0

    def log_message(self, *_args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        body = json.loads(raw)
        type(self).response_number += 1
        number = type(self).response_number
        type(self).requests.append({
            "body": body,
            "auth": self.headers.get("Authorization"),
        })
        text = f"FIXTURE_ASSISTANT_{number}"
        item = {
            "id": f"msg_fixture_{number}",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": text,
                "annotations": [],
            }],
        }
        response = {
            "id": f"resp_fixture_{number}",
            "object": "response",
            "created_at": 1789200000 + number,
            "status": "completed",
            "model": "gpt-5.6-sol",
            "output": [item],
            "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        }
        events = [
            ("response.created", {"response": dict(response, status="in_progress", output=[])}),
            ("response.output_item.added", {"output_index": 0, "item": dict(item, status="in_progress", content=[])}),
            ("response.output_text.delta", {
                "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text,
            }),
            ("response.output_item.done", {"output_index": 0, "item": item}),
            ("response.completed", {"response": response}),
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event_type, extra in events:
            event = {"type": event_type, **extra}
            self.wfile.write(
                f"event: {event_type}\ndata: {json.dumps(event)}\n\n".encode()
            )


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def sqlite_snapshot(profile):
    return {
        str(file.relative_to(profile)): sha256(file)
        for file in sorted(profile.glob("state*.sqlite*"))
        if file.is_file()
    }


def configure(profile, port, conflicting_defaults=False):
    profile.mkdir()
    (profile / "config.toml").write_text(
        f'model="{"gpt-5.5" if conflicting_defaults else "gpt-5.6-sol"}"\n'
        'model_provider="fixture"\n'
        f'model_reasoning_effort="{"high" if conflicting_defaults else "low"}"\n'
        f'sandbox_mode="{"read-only" if conflicting_defaults else "workspace-write"}"\n'
        '[model_providers.fixture]\n'
        'name="fixture"\n'
        f'base_url="http://127.0.0.1:{port}/v1"\n'
        'wire_api="responses"\n'
        'env_key="KEEP_TEST_TOKEN"\n'
        'requires_openai_auth=false\n',
        encoding="utf-8",
    )


def run_codex(binary, project, clean_env, profile, token, args, global_args=()):
    result = subprocess.run(
        [binary, *global_args, "exec", *args, "--skip-git-repo-check", "--json"],
        cwd=project,
        env={**clean_env, "CODEX_HOME": str(profile), "KEEP_TEST_TOKEN": token},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr + result.stdout)[-2000:])
    return [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]


def read_resume_spec(repo, rollout, sid):
    script = "process.stdout.write(JSON.stringify(require(process.argv[1]).readResumeSpec(process.argv[2], process.argv[3])))"
    result = subprocess.run(
        ["node", "-e", script, str(repo / "bin" / "codex-handoff-support.js"), str(rollout), sid],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr + result.stdout)[-2000:])
    return json.loads(result.stdout)


def run_resume(binary, project, clean_env, profile, token, spec, prompt):
    argv = spec["argv"][1:]
    resume_index = argv.index("resume")
    return run_codex(
        binary, project, clean_env, profile, token,
        [*argv[resume_index:], prompt], argv[:resume_index],
    )


def latest_turn_context(rollout):
    contexts = [
        row["payload"] for row in (
            json.loads(line) for line in rollout.read_text(encoding="utf-8").splitlines() if line
        )
        if row.get("type") == "turn_context"
    ]
    assert contexts
    return contexts[-1]


def transfer(repo, registry, sid, source_id, source, target_id, target, transaction):
    payload = {
        "module": str(repo / "bin" / "codex-account-artifacts.js"),
        "jobs": str(repo / "bin" / "background-jobs.js"),
        "root": str(registry),
        "sid": sid,
        "source": {"id": source_id, "agent": "codex", "configDir": str(source)},
        "target": {"id": target_id, "agent": "codex", "configDir": str(target)},
        "transaction": transaction,
    }
    script = r"""
const input = JSON.parse(process.argv[1]);
const artifacts = require(input.module);
const jobs = require(input.jobs);
const sourceFiles = [...require('node:fs').readdirSync(input.source.configDir + '/sessions', { recursive: true })]
  .filter(name => String(name).endsWith('-' + input.sid + '.jsonl'))
  .map(name => require('node:path').join(input.source.configDir, 'sessions', String(name)));
if (sourceFiles.length !== 1) throw new Error('smoke source rollout is ambiguous');
jobs.sync({ root: input.root, agent: 'codex', sid: input.sid, file: sourceFiles[0], now: Date.now() });
const options = { root: input.root, sourceStopVerifiedAt: Date.now() };
const preview = artifacts.preflight(input.sid, input.source, input.target, options);
const copied = artifacts.copyCodexArtifacts(input.sid, input.source, input.target, input.transaction, options);
const rebound = artifacts.rebindLedger(input.sid, input.source, input.target, input.transaction, options);
process.stdout.write(JSON.stringify({ preview, copied, rebound }));
"""
    result = subprocess.run(
        ["node", "-e", script, json.dumps(payload)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr + result.stdout)[-2000:])
    return json.loads(result.stdout)


def archived_refusal(repo, registry, sid, source, target):
    payload = {
        "module": str(repo / "bin" / "codex-account-artifacts.js"),
        "root": str(registry),
        "sid": sid,
        "source": {"id": "archived", "agent": "codex", "configDir": str(source)},
        "target": {"id": "unused", "agent": "codex", "configDir": str(target)},
    }
    script = r"""
const input = JSON.parse(process.argv[1]);
try {
  require(input.module).preflight(input.sid, input.source, input.target, { root: input.root });
  throw new Error('archived root was unexpectedly accepted');
} catch (error) {
  if (error.code !== 'KEEP_CODEX_ARTIFACT_ARCHIVED') throw error;
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}
"""
    result = subprocess.run(
        ["node", "-e", script, json.dumps(payload)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr + result.stdout)[-2000:])
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--context-proof", action="store_true",
                        help="append synthetic tool and compaction rows and require them in resumed context")
    args = parser.parse_args()

    root = pathlib.Path(tempfile.mkdtemp(prefix="keep-codex-account-smoke-"))
    project = root / "project"
    project.mkdir()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    repo = pathlib.Path(__file__).resolve().parents[1]
    profiles = {name: root / name for name in ["source", "target", "archived", "unused"]}
    for name, profile in profiles.items():
        configure(profile, server.server_port, conflicting_defaults=name == "target")
    clean_env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("OPENAI_", "CODEX_", "KEEP_", "ANTHROPIC_", "CLAUDE_"))
    }
    clean_env["RUST_LOG"] = "error"

    try:
        first = run_codex(
            args.codex_bin, project, clean_env, profiles["source"], "fixture-source",
            ["Remember FIXTURE_USER_SOURCE"],
            ["--sandbox", "workspace-write", "--ask-for-approval", "never",
             "-c", 'approvals_reviewer="user"', "-m", "gpt-5.6-sol",
             "-c", 'model_reasoning_effort="medium"'],
        )
        sid = next(row["thread_id"] for row in first if row.get("type") == "thread.started")
        source_rollouts = list((profiles["source"] / "sessions").rglob(f"*-{sid}.jsonl"))
        assert len(source_rollouts) == 1
        source_rollout = source_rollouts[0]
        if args.context_proof:
            with source_rollout.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps({
                    "type": "response_item",
                    "payload": {"type": "function_call_output", "call_id": "fixture-tool",
                                "output": "FIXTURE_TOOL_CONTEXT"},
                }) + "\n")
                stream.write(json.dumps({
                    "type": "compacted",
                    "payload": {"replacement_history": [{
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "FIXTURE_COMPACTION_CONTEXT"}],
                    }]},
                }) + "\n")
        source_blob = source_rollout.read_bytes()
        source_digest = sha256(source_rollout)
        assert any(profiles["source"].glob("state*.sqlite"))
        policy_fields = [
            "sandbox_policy", "permission_profile", "active_permission_profile",
            "approval_policy", "approvals_reviewer", "model", "effort", "cwd", "workspace_roots",
        ]
        source_context = latest_turn_context(source_rollout)
        assert source_context["sandbox_policy"]["type"] == "workspace-write"
        assert source_context["approval_policy"] == "never"
        assert source_context.get("approvals_reviewer", "user") == "user"
        assert source_context["model"] == "gpt-5.6-sol"
        assert source_context["effort"] == "medium"
        assert source_context["cwd"] == str(project.resolve())

        registry_one = root / "registry-one"
        registry_one.mkdir()
        first_copy = transfer(
            repo, registry_one, sid, "source", profiles["source"],
            "target", profiles["target"], "smoke-source-target",
        )
        target_rollout = profiles["target"] / source_rollout.relative_to(profiles["source"])
        assert target_rollout.read_bytes() == source_blob
        assert not any(profiles["target"].glob("state*.sqlite"))
        assert not (profiles["target"] / "auth.json").exists()
        assert first_copy["copied"]["artifacts"][0]["sessionId"] == sid

        first_resume_spec = read_resume_spec(repo, target_rollout, sid)
        assert first_resume_spec["cwd"] == str(project.resolve())
        assert first_resume_spec["model"] == "gpt-5.6-sol"
        assert first_resume_spec["effort"] == "medium"
        before = len(FixtureHandler.requests)
        second = run_resume(
            args.codex_bin, project, clean_env, profiles["target"], "fixture-target",
            first_resume_spec, "Continue with FIXTURE_USER_TARGET",
        )
        target_requests = FixtureHandler.requests[before:]
        target_payload = json.dumps(target_requests)
        assert any(row.get("thread_id") == sid for row in second)
        assert "FIXTURE_USER_SOURCE" in target_payload
        assert "FIXTURE_ASSISTANT_1" in target_payload
        assert target_requests and all(row["auth"] == "Bearer fixture-target" for row in target_requests)
        source_preserved_until_return = source_rollout.read_bytes() == source_blob
        assert source_preserved_until_return
        assert target_rollout.stat().st_size > len(source_blob)
        target_context = latest_turn_context(target_rollout)
        assert all(target_context.get(field) == source_context.get(field) for field in policy_fields), {
            field: [source_context.get(field), target_context.get(field)]
            for field in policy_fields if source_context.get(field) != target_context.get(field)
        }
        if args.context_proof:
            assert b"FIXTURE_TOOL_CONTEXT" in source_blob
            assert b"FIXTURE_COMPACTION_CONTEXT" in source_blob

        target_blob = target_rollout.read_bytes()
        source_database_before_return = sqlite_snapshot(profiles["source"])
        assert source_database_before_return
        second_copy = transfer(
            repo, registry_one, sid, "target", profiles["target"],
            "source", profiles["source"], "smoke-target-source",
        )
        assert source_rollout.read_bytes() == target_blob
        source_database_preserved = sqlite_snapshot(profiles["source"]) == source_database_before_return
        assert source_database_preserved
        if args.context_proof:
            assert b"FIXTURE_TOOL_CONTEXT" in target_blob
            assert b"FIXTURE_COMPACTION_CONTEXT" in target_blob
        assert second_copy["copied"]["artifacts"][0]["sessionId"] == sid

        second_resume_spec = read_resume_spec(repo, source_rollout, sid)
        assert second_resume_spec["argv"] == first_resume_spec["argv"]
        before = len(FixtureHandler.requests)
        third = run_resume(
            args.codex_bin, project, clean_env, profiles["source"], "fixture-source-return",
            second_resume_spec, "Continue with FIXTURE_USER_SOURCE_RETURN",
        )
        source_return_requests = FixtureHandler.requests[before:]
        source_return_payload = json.dumps(source_return_requests)
        assert any(row.get("thread_id") == sid for row in third)
        assert "FIXTURE_USER_SOURCE" in source_return_payload
        assert "FIXTURE_USER_TARGET" in source_return_payload
        assert source_return_requests and all(
            row["auth"] == "Bearer fixture-source-return" for row in source_return_requests
        )
        target_unchanged_after_return = target_rollout.read_bytes() == target_blob
        assert target_unchanged_after_return
        assert source_rollout.stat().st_size > len(target_blob)
        source_return_context = latest_turn_context(source_rollout)
        assert all(source_return_context.get(field) == source_context.get(field) for field in policy_fields), {
            field: [source_context.get(field), source_return_context.get(field)]
            for field in policy_fields if source_context.get(field) != source_return_context.get(field)
        }

        archived_rollout = profiles["archived"] / "archived_sessions" / source_rollout.name
        archived_rollout.parent.mkdir()
        archived_rollout.write_bytes(source_blob)
        refusal = archived_refusal(repo, root / "registry-archive", sid, profiles["archived"], profiles["unused"])
        assert "unarchive" in refusal["message"]

        checks = {
            "sameThreadAfterSourceTargetSource": True,
            "priorUserAndAssistantRetained": True,
            "targetCredentialsIsolated": True,
            "effectiveResumePolicyPreserved": True,
            "sourcePreservedUntilReturn": source_preserved_until_return and source_digest == hashlib.sha256(source_blob).hexdigest(),
            "sourceDatabasePreservedByReturnCopy": source_database_preserved,
            "targetUnchangedAfterReturn": target_unchanged_after_return,
            "roundTripAppendContinuity": source_rollout.stat().st_size > len(target_blob),
            "rolloutBytesCopiedExactlyBeforeResume": True,
            "noDatabaseOrAuthCopied": True,
            "archivedRootRefused": refusal["code"] == "KEEP_CODEX_ARTIFACT_ARCHIVED",
            "toolAndCompactionRowsCopiedUnchanged": args.context_proof,
        }
        print(json.dumps(checks, indent=2))
        if args.keep_temp:
            print(f"smokeRoot {root}")
    finally:
        server.shutdown()
        server.server_close()
        if not args.keep_temp:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
