// The headless Edge wrapper without Edge: the pipe framing on its own, and the supervisor
// against a fake child process and a fake clock. Nothing here spawns a browser.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DEFAULT_EDGE,
  FrameDecoder,
  GPU_ARGS,
  MAX_FRAME_BYTES,
  createSupervisor,
  edgeArgs,
  encodeMessage,
  loadUnpackedMessage,
  parseArgs,
  prepareProfileDir,
} from "../bin/headless-edge.js";
import { EXTENSION_ID } from "../host/protocol.js";

// --- framing --------------------------------------------------------------

test("a message is its JSON followed by one NUL byte", () => {
  const bytes = encodeMessage(loadUnpackedMessage("/srv/bb/extension"));
  assert.equal(bytes.at(-1), 0);
  assert.equal(bytes.indexOf(0), bytes.length - 1, "no NUL inside the JSON");
  assert.deepEqual(JSON.parse(bytes.subarray(0, -1).toString("utf8")), {
    id: 1,
    method: "Extensions.loadUnpacked",
    params: { path: "/srv/bb/extension" },
  });
});

test("the decoder holds a partial message until its terminator arrives", () => {
  const decoder = new FrameDecoder();
  const bytes = encodeMessage({ id: 1, result: { id: EXTENSION_ID } });
  assert.deepEqual(decoder.push(bytes.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(bytes.subarray(5, 20)), []);
  assert.deepEqual(decoder.push(bytes.subarray(20)), [JSON.stringify({ id: 1, result: { id: EXTENSION_ID } })]);
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
});

test("the decoder splits several messages in one chunk, and a tail that runs into the next", () => {
  const decoder = new FrameDecoder();
  const a = encodeMessage({ id: 1 });
  const b = encodeMessage({ id: 2 });
  const c = encodeMessage({ id: 3 });
  const chunk = Buffer.concat([a, b, c.subarray(0, 4)]);
  assert.deepEqual(decoder.push(chunk), ['{"id":1}', '{"id":2}']);
  assert.deepEqual(decoder.push(c.subarray(4)), ['{"id":3}']);
  // A terminator on its own ends an empty frame, which the caller will fail to parse and skip.
  assert.deepEqual(decoder.push(Buffer.from([0])), [""]);
});

test("a multibyte character split across reads comes out whole", () => {
  const decoder = new FrameDecoder();
  const bytes = encodeMessage({ text: "héllo ✓" });
  const cut = bytes.indexOf(Buffer.from("✓")) + 1; // inside the three bytes of the check mark
  assert.deepEqual(decoder.push(bytes.subarray(0, cut)), []);
  assert.deepEqual(decoder.push(bytes.subarray(cut)).map((frame) => JSON.parse(frame).text), ["héllo ✓"]);
});

test("the decoder does not keep a chunk's memory it was only lent", () => {
  const decoder = new FrameDecoder();
  const chunk = Buffer.from('{"id":7');
  decoder.push(chunk);
  chunk.fill(0x20); // a stream may reuse its buffer once the handler returns
  assert.deepEqual(decoder.push(Buffer.from("}\0")), ['{"id":7}']);
});

test("a message with no terminator past the cap is an error, and the decoder starts over", () => {
  const decoder = new FrameDecoder();
  decoder.push(Buffer.alloc(MAX_FRAME_BYTES, 0x61));
  assert.throws(() => decoder.push(Buffer.from("a")), /without a terminator/);
  assert.deepEqual(decoder.push(Buffer.from('{"id":1}\0')), ['{"id":1}']);
});

// --- arguments ------------------------------------------------------------

test("Edge runs headless on the pipe with extension debugging, on the given profile", () => {
  const args = edgeArgs("/home/test/.local/state/browser-bridge/edge-profile");
  for (const flag of [
    "--headless=new",
    "--user-data-dir=/home/test/.local/state/browser-bridge/edge-profile",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
  ]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args.at(-1), "about:blank");
  assert.ok(args.includes("--disable-gpu"));
  for (const flag of GPU_ARGS) assert.ok(!args.includes(flag), flag);
});

test("with gpu, Edge gets ANGLE over EGL in place of --disable-gpu", () => {
  const args = edgeArgs("/home/test/p", { gpu: true });
  assert.ok(!args.includes("--disable-gpu"));
  for (const flag of ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.equal(args.at(-1), "about:blank");
});

test("the Edge path and the profile come from flags, then the environment, then defaults", () => {
  const env = { HOME: "/home/test", BROWSER_BRIDGE_RUNTIME_DIR: "/home/test/rt" };
  const defaults = parseArgs([], env);
  assert.equal(defaults.edgePath, DEFAULT_EDGE);
  assert.equal(defaults.profileDir, "/home/test/rt/edge-profile");
  assert.equal(defaults.extensionPath, path.resolve(import.meta.dirname, "../extension"));

  const fromEnv = parseArgs([], { ...env, BROWSER_BRIDGE_EDGE: "/opt/edge", BROWSER_BRIDGE_EDGE_PROFILE: "/home/test/p" });
  assert.equal(fromEnv.edgePath, "/opt/edge");
  assert.equal(fromEnv.profileDir, "/home/test/p");

  const fromFlags = parseArgs(["--edge", "/opt/other", "--user-data-dir", "/home/test/q", "--extension", "/srv/ext"], {
    ...env,
    BROWSER_BRIDGE_EDGE: "/opt/edge",
  });
  assert.deepEqual(fromFlags, { edgePath: "/opt/other", profileDir: "/home/test/q", extensionPath: "/srv/ext", gpu: false });
  assert.equal(defaults.gpu, false);
  assert.equal(parseArgs(["--gpu"], env).gpu, true);
  assert.equal(parseArgs(["--gpu", "--edge", "/opt/e"], env).edgePath, "/opt/e");
  assert.equal(parseArgs([], { ...env, BROWSER_BRIDGE_EDGE_GPU: "1" }).gpu, true);
  assert.throws(() => parseArgs(["--edge"], env), /needs a value/);
  assert.throws(() => parseArgs(["--wat"], env), /Unknown argument/);
});

test("the profile is private on every start, even one that already existed open", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fresh = path.join(root, "fresh", "edge-profile");
  prepareProfileDir(fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);

  // The installer's recursive mkdir for the manifest copy can get there first, at 0755.
  const existing = path.join(root, "existing");
  fs.mkdirSync(path.join(existing, "NativeMessagingHosts"), { recursive: true });
  fs.chmodSync(existing, 0o755);
  prepareProfileDir(existing);
  assert.equal(fs.statSync(existing).mode & 0o777, 0o700);
});

// --- the supervisor -------------------------------------------------------

/** A child process as much as the supervisor sees of one: fds 3 and 4, kill, exit. */
class FakeChild extends EventEmitter {
  constructor({ pid = 100 } = {}) {
    super();
    this.pid = pid;
    this.input = new PassThrough();
    this.output = new PassThrough();
    this.written = [];
    this.input.on("data", (chunk) => this.written.push(chunk));
    this.stdio = [null, null, null, this.input, this.output];
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }

  /** What Edge writes back on fd 4. */
  reply(message) {
    this.output.write(encodeMessage(message));
  }

  exit(code, signal = null) {
    this.emit("exit", code, signal);
  }
}

/** Timers that fire only when the test moves the clock. */
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => [...timers.values()].map((timer) => timer.at - time).sort((a, b) => a - b),
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= time && timers.has(id)) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function harness(overrides = {}) {
  const clock = fakeClock();
  const children = [];
  const spawned = [];
  const lines = [];
  const supervisor = createSupervisor({
    spawn(command, args, options) {
      spawned.push({ command, args, options });
      const child = new FakeChild({ pid: 100 + children.length });
      children.push(child);
      return child;
    },
    edgePath: "/opt/edge",
    profileDir: "/home/test/profile",
    extensionPath: "/srv/bb/extension",
    log: (line) => lines.push(line),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    initialDelayMs: 1_000,
    maxDelayMs: 8_000,
    stableMs: 30_000,
    killGraceMs: 5_000,
    loadTimeoutMs: 40_000,
    ...overrides,
  });
  return { supervisor, clock, children, spawned, lines };
}

/** Lets the PassThrough streams deliver what was written to them. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("each start spawns Edge with the pipe on fds 3 and 4 and asks it to load the extension", async () => {
  const { supervisor, children, spawned, lines } = harness();
  supervisor.start();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "/opt/edge");
  assert.deepEqual(spawned[0].args, edgeArgs("/home/test/profile"));
  assert.deepEqual(spawned[0].options.stdio, ["ignore", "inherit", "inherit", "pipe", "pipe"]);
  await flush();
  assert.deepEqual(Buffer.concat(children[0].written), encodeMessage(loadUnpackedMessage("/srv/bb/extension")));

  children[0].reply({ id: 1, result: { id: EXTENSION_ID } });
  await flush();
  assert.ok(lines.includes(`extension loaded: ${EXTENSION_ID} from /srv/bb/extension`));
  assert.equal(lines.some((line) => line.startsWith("expected extension id")), false);
});

test("a supervisor started with gpu spawns Edge with the GPU flags and says so", () => {
  const { supervisor, spawned, lines } = harness({ gpu: true });
  supervisor.start();
  assert.deepEqual(spawned[0].args, edgeArgs("/home/test/profile", { gpu: true }));
  assert.ok(lines.some((line) => line.endsWith("with GPU flags")));
});

test("a wrong id and an unreadable message are logged, and nothing restarts", async () => {
  const { supervisor, clock, children, spawned, lines } = harness();
  supervisor.start();
  const child = children[0];
  // Two frames in one write, the second not JSON: the first must still be read.
  child.output.write(Buffer.concat([encodeMessage({ id: 1, result: { id: "abcdefghijklmnopabcdefghijklmnop" } }), Buffer.from("{nope\0")]));
  child.reply({ method: "Target.targetCreated", params: {} }); // not ours: ignored
  await flush();
  assert.ok(lines.some((line) => line.startsWith(`expected extension id ${EXTENSION_ID}`)));
  assert.ok(lines.includes("unreadable CDP message (5 chars)"));
  assert.deepEqual(clock.pending(), [], "an answer clears the load timeout");
  clock.advance(120_000);
  assert.equal(spawned.length, 1);
  assert.deepEqual(child.signals, []);
});

test("a load error stops that Edge, killing it if it lingers, and the backoff starts another", async () => {
  const { supervisor, clock, children, spawned, lines } = harness();
  supervisor.start();
  const child = children[0];
  child.reply({ id: 1, error: { code: -32000, message: "Manifest file is missing or unreadable" } });
  await flush();
  assert.ok(lines.includes("Extensions.loadUnpacked failed: Manifest file is missing or unreadable; restarting Edge"));
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual(clock.pending(), [5_000], "only the kill timer: the load timeout is gone");
  clock.advance(5_000);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.exit(null, "SIGKILL");
  assert.deepEqual(clock.pending(), [1_000]);
  clock.advance(1_000);
  assert.equal(spawned.length, 2);
  // The new Edge is asked again.
  await flush();
  assert.deepEqual(Buffer.concat(children[1].written), encodeMessage(loadUnpackedMessage("/srv/bb/extension")));
});

test("an Edge that never answers the load is stopped after the timeout and started again", async () => {
  const { supervisor, clock, children, spawned, lines } = harness();
  supervisor.start();
  const child = children[0];
  clock.advance(39_999);
  assert.deepEqual(child.signals, []);
  clock.advance(1);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.ok(lines.includes("Extensions.loadUnpacked did not answer in 40 s; restarting Edge"));
  // A late answer changes nothing now: it is already on its way out.
  child.reply({ id: 1, result: { id: EXTENSION_ID } });
  await flush();
  assert.equal(lines.some((line) => line.startsWith("extension loaded")), false);
  child.exit(0);
  assert.deepEqual(clock.pending(), [1_000], "the kill timer is cleared and a restart is scheduled");
  clock.advance(1_000);
  assert.equal(spawned.length, 2);
});

test("Edge that keeps dying is restarted with a doubling delay, capped", () => {
  const { supervisor, clock, children, spawned } = harness();
  supervisor.start();
  const delays = [];
  for (let run = 0; run < 6; run++) {
    clock.advance(100); // a quick failure every time
    children.at(-1).exit(1);
    delays.push(clock.pending()[0]);
    assert.equal(spawned.length, run + 1, "not before the delay");
    clock.advance(delays.at(-1));
    assert.equal(spawned.length, run + 2);
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
});

test("a run that lasted resets the backoff", () => {
  const { supervisor, clock, children } = harness();
  supervisor.start();
  for (const quick of [1_000, 2_000, 4_000]) {
    children.at(-1).exit(1);
    assert.deepEqual(clock.pending(), [quick]);
    clock.advance(quick);
  }
  // This one ran for longer than stableMs before it died.
  clock.advance(30_000);
  children.at(-1).exit(null, "SIGSEGV");
  assert.deepEqual(clock.pending(), [1_000]);
});

test("a binary that is not there is an error event, and gets the same backoff", () => {
  const { supervisor, clock, children, spawned, lines } = harness();
  supervisor.start();
  const child = children[0];
  child.pid = undefined;
  child.emit("error", Object.assign(new Error("spawn /opt/edge ENOENT"), { code: "ENOENT" }));
  // Node may follow a spawn error with an exit; it must not count twice.
  child.exit(-2);
  assert.deepEqual(clock.pending(), [1_000]);
  assert.ok(lines.some((line) => line.includes("could not start: spawn /opt/edge ENOENT")));
  clock.advance(1_000);
  assert.equal(spawned.length, 2);
});

test("an error from a running Edge is logged and does not start a second one", () => {
  const { supervisor, clock, children, spawned, lines } = harness();
  supervisor.start();
  children[0].emit("error", new Error("kill EPERM"));
  assert.deepEqual(clock.pending(), [40_000], "only its load timeout: no restart");
  assert.equal(spawned.length, 1);
  assert.ok(lines.includes("Edge process: kill EPERM"));
});

test("a pipe error is logged, not thrown", () => {
  const { supervisor, children, lines } = harness();
  supervisor.start();
  children[0].input.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.ok(lines.includes("pipe to Edge: write EPIPE"));
});

test("stop sends SIGTERM, resolves on exit, and nothing restarts after", async () => {
  const { supervisor, clock, children, spawned } = harness();
  supervisor.start();
  let stopped = false;
  const done = supervisor.stop().then(() => {
    stopped = true;
  });
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  await flush();
  assert.equal(stopped, false, "not until Edge has actually gone");
  children[0].exit(0);
  await done;
  assert.equal(stopped, true);
  assert.deepEqual(clock.pending(), [], "the kill timer is cleared and no restart is scheduled");
  clock.advance(120_000);
  assert.equal(spawned.length, 1);
});

test("an Edge that ignores SIGTERM is killed after the grace period", async () => {
  const { supervisor, clock, children } = harness();
  supervisor.start();
  const done = supervisor.stop();
  clock.advance(4_999);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  clock.advance(1);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  children[0].exit(null, "SIGKILL");
  await done;
});

test("stop during the backoff cancels the pending restart", async () => {
  const { supervisor, clock, children, spawned } = harness();
  supervisor.start();
  children[0].exit(1);
  assert.deepEqual(clock.pending(), [1_000]);
  await supervisor.stop();
  assert.deepEqual(clock.pending(), []);
  clock.advance(10_000);
  assert.equal(spawned.length, 1);
});

test("an overlong message from Edge restarts it rather than growing without bound", async () => {
  const { supervisor, clock, children, lines } = harness();
  supervisor.start();
  children[0].output.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
  await flush();
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.ok(lines.some((line) => line.includes("without a terminator; restarting Edge")));
  // One that ignores the SIGTERM gets the same grace as stop() gives, then SIGKILL.
  clock.advance(5_000);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  children[0].exit(null, "SIGKILL");
  assert.deepEqual(clock.pending(), [1_000]);
});
