#!/usr/bin/env python3
"""Disposable installed-Claude cross-profile resume proof using a local mock API."""
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import uuid

root = pathlib.Path(tempfile.mkdtemp(prefix="keep-resume-proof-"))
project = root / "project_with_under.score"
source = root / "source"
target = root / "target"
project.mkdir(); source.mkdir(); target.mkdir()
sid = str(uuid.uuid4())
requests = []

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "{}")
        if "/messages" not in self.path:
            self.send_response(200); self.end_headers(); self.wfile.write(b"{}"); return
        requests.append(body)
        message = {"id": "msg_proof", "type": "message", "role": "assistant", "model": body.get("model", "haiku"),
                   "content": [{"type": "text", "text": "Local proof acknowledged."}], "stop_reason": "end_turn",
                   "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 5}}
        self.send_response(200)
        if body.get("stream"):
            self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            events = [
                ("message_start", {"message": dict(message, content=[], stop_reason=None)}),
                ("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "Local proof acknowledged."}}),
                ("content_block_stop", {"index": 0}),
                ("message_delta", {"delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}}),
                ("message_stop", {}),
            ]
            for name, event in events:
                self.wfile.write(("event: " + name + "\ndata: " + json.dumps(dict(event, type=name)) + "\n\n").encode())
        else:
            self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(message).encode())

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {key: value for key, value in os.environ.items() if not key.startswith(("ANTHROPIC_", "CLAUDE_", "CLAUDECODE", "KEEP_"))}
env.update(ANTHROPIC_API_KEY="local-fixture-only", ANTHROPIC_BASE_URL=f"http://127.0.0.1:{server.server_port}",
           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
base = ["claude", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--model", "haiku", "--output-format", "json", "-p"]
try:
    first = subprocess.run(base + ["--session-id", sid, "Remember fixture marker KEEP_RESUME_SENTINEL_83."],
                           cwd=project, env=dict(env, CLAUDE_CONFIG_DIR=str(source)), capture_output=True, text=True, timeout=50)
    files = list((source / "projects").glob("*/*.jsonl")) if (source / "projects").exists() else []
    if first.returncode or not files:
        raise RuntimeError("source run failed: " + (first.stderr + first.stdout)[-800:])
    shutil.copytree(source / "projects", target / "projects")
    before = len(requests)
    second = subprocess.run(base + ["--resume", sid, "State what happened previously."], cwd=project,
                            env=dict(env, CLAUDE_CONFIG_DIR=str(target)), capture_output=True, text=True, timeout=50)
    payload = json.dumps(requests[before:])
    result = json.loads(second.stdout) if second.returncode == 0 else {}
    checks = {"sourceExit": first.returncode, "targetExit": second.returncode,
              "priorUserPresent": "KEEP_RESUME_SENTINEL_83" in payload,
              "priorAssistantPresent": "Local proof acknowledged." in payload,
              "sameSessionId": result.get("session_id") == sid}
    print(json.dumps(checks, indent=2))
    if second.returncode or not all(checks[key] for key in ("priorUserPresent", "priorAssistantPresent", "sameSessionId")):
        raise SystemExit(1)
finally:
    server.shutdown()
    shutil.rmtree(root)
