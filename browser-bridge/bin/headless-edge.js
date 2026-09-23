#!/usr/bin/env node
// Keeps a headless Edge running with the extension loaded, for a machine with no display
// and so no everyday browser for the extension to live in (a Linux node, under systemd).
//
//   node bin/headless-edge.js [--edge <path>] [--user-data-dir <dir>] [--extension <dir>]
//
// Edge 153 ignores --load-extension, so the extension goes in the one way that works on a
// browser started from a script: over the DevTools pipe. With --remote-debugging-pipe Edge
// reads CDP messages on its fd 3 and writes them on its fd 4, each one JSON followed by a
// NUL byte, and `Extensions.loadUnpacked` (which needs --enable-unsafe-extension-debugging)
// loads an unpacked directory. It does that on every start: the call is idempotent, and it
// is what makes a landing's new extension code reach the browser on the next restart.
//
// Edge is this process's child, and the pipe stays open for as long as it runs. When Edge
// exits it is started again after a backoff that doubles on each quick failure and resets
// after a run that lasted. SIGTERM or SIGINT stops Edge and exits 0 with no restart, which
// is what the systemd unit's stop and `Restart=on-failure` expect.

import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_ID, edgeProfileDir, isMainModule } from "../host/protocol.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_EDGE = "/usr/bin/microsoft-edge";

/** The request id of the one call this wrapper makes. */
const LOAD_ID = 1;

// --- CDP over a pipe ------------------------------------------------------

/**
 * Nothing Edge sends back on this pipe is large - the wrapper only ever asks one thing and
 * enables no events - so a frame this big means the stream is not what it should be.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeMessage(message) {
  return Buffer.concat([Buffer.from(JSON.stringify(message), "utf8"), Buffer.from([0])]);
}

/**
 * Splits the pipe's byte stream at NUL bytes. A read can end in the middle of a message,
 * or even of a UTF-8 character, and can carry several messages at once, so bytes are held
 * until their terminator arrives and only whole frames are decoded.
 */
export class FrameDecoder {
  #pending = [];
  #pendingBytes = 0;

  /** Returns the complete frames in this chunk, as strings, in order. */
  push(chunk) {
    const frames = [];
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul === -1) break;
      this.#pending.push(chunk.subarray(start, nul));
      frames.push(Buffer.concat(this.#pending).toString("utf8"));
      this.#pending = [];
      this.#pendingBytes = 0;
      start = nul + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.#pendingBytes += rest.length;
      if (this.#pendingBytes > MAX_FRAME_BYTES) {
        this.#pending = [];
        this.#pendingBytes = 0;
        throw new Error(`a CDP message ran past ${MAX_FRAME_BYTES} bytes without a terminator`);
      }
      // Copied, not a view: the stream may reuse the chunk's memory once this returns.
      this.#pending.push(Buffer.from(rest));
    }
    return frames;
  }
}

export function loadUnpackedMessage(extensionPath) {
  return { id: LOAD_ID, method: "Extensions.loadUnpacked", params: { path: extensionPath } };
}

/**
 * `--headless=new` is the full browser without a window, which is what extensions need (the
 * old headless mode has no extension system). The rest keep a scratch profile quiet: no
 * first-run page, no default-browser prompt, no GPU process on a machine with no GPU, and no
 * wait on a desktop keyring that is not there.
 */
export function edgeArgs(profileDir) {
  return [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--password-store=basic",
    "about:blank",
  ];
}

// --- the supervisor -------------------------------------------------------

/**
 * Runs Edge, loads the extension into it, and starts it again whenever it exits, until
 * `stop()`. Everything that reaches outside the process is passed in - `spawn`, the timers
 * and the clock - so the restart policy can be tested with a fake child and a fake clock.
 */
export function createSupervisor({
  spawn = spawnProcess,
  edgePath = DEFAULT_EDGE,
  profileDir,
  extensionPath = path.join(PROJECT_DIR, "extension"),
  log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  initialDelayMs = 1_000,
  maxDelayMs = 60_000,
  /** A run at least this long counts as healthy, and the next failure starts the backoff over. */
  stableMs = 60_000,
  /** How long Edge gets to close after SIGTERM before it is killed outright. */
  killGraceMs = 10_000,
}) {
  const args = edgeArgs(profileDir);
  let child = null;
  let restartTimer = null;
  let delay = initialDelayMs;
  let stopping = false;
  let launches = 0;
  let onStopped = null;

  function launch() {
    restartTimer = null;
    if (stopping) return;
    launches += 1;
    const startedAt = now();
    log(`starting ${edgePath} (launch ${launches}) on ${profileDir}`);
    let proc;
    try {
      proc = spawn(edgePath, args, { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
    } catch (error) {
      // A synchronous throw (a bad argument, not a missing binary - that one is an 'error'
      // event) still gets the backoff, not a crash loop.
      exited(null, `could not start: ${error.message}`, startedAt);
      return;
    }
    child = proc;
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      if (child === proc) child = null;
      exited(proc, reason, startedAt);
    };

    const input = proc.stdio[3];
    const output = proc.stdio[4];
    const decoder = new FrameDecoder();
    // A write to a pipe whose reader has died is EPIPE, which is Edge exiting and is reported
    // by the exit handler; unhandled, it would take the wrapper down with it.
    input.on("error", (error) => log(`pipe to Edge: ${error.message}`));
    output.on("error", (error) => log(`pipe from Edge: ${error.message}`));
    output.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        log(`${error.message}; restarting Edge`);
        proc.kill("SIGTERM");
        return;
      }
      for (const frame of frames) handleFrame(frame);
    });

    proc.on("exit", (code, signal) => finish(signal ? `signal ${signal}` : `code ${code}`));
    proc.on("error", (error) => {
      // Spawn failures (no such file, not executable) come here with no process behind them.
      // Anything else - a failed kill, say - leaves Edge running, and restarting would make two.
      if (proc.pid === undefined) finish(`could not start: ${error.message}`);
      else log(`Edge process: ${error.message}`);
    });

    input.write(encodeMessage(loadUnpackedMessage(extensionPath)));
  }

  function handleFrame(frame) {
    let message;
    try {
      message = JSON.parse(frame);
    } catch {
      log(`unreadable CDP message (${frame.length} chars)`);
      return;
    }
    if (message?.id !== LOAD_ID) return;
    if (message.error) {
      log(`Extensions.loadUnpacked failed: ${message.error.message ?? JSON.stringify(message.error)}`);
      return;
    }
    const id = message.result?.id;
    log(`extension loaded: ${id} from ${extensionPath}`);
    // The manifest's key pins the id, and the native messaging manifest allows only that one
    // origin, so any other id is an extension that can never reach the host.
    if (id !== EXTENSION_ID) log(`expected extension id ${EXTENSION_ID}; the native host will refuse ${id}`);
  }

  function exited(proc, reason, startedAt) {
    if (stopping) {
      log(`Edge stopped (${reason})`);
      onStopped?.();
      return;
    }
    const ranFor = now() - startedAt;
    if (ranFor >= stableMs) delay = initialDelayMs;
    const wait = delay;
    delay = Math.min(delay * 2, maxDelayMs);
    log(`Edge exited (${reason}) after ${Math.round(ranFor / 1000)} s; starting it again in ${wait / 1000} s`);
    restartTimer = setTimer(launch, wait);
  }

  return {
    start() {
      launch();
    },
    /** Stops Edge for good. Resolves once it has exited, or at once if it was not running. */
    stop() {
      if (stopping) return Promise.resolve();
      stopping = true;
      if (restartTimer !== null) {
        clearTimer(restartTimer);
        restartTimer = null;
      }
      const proc = child;
      if (!proc) return Promise.resolve();
      return new Promise((resolve) => {
        const grace = setTimer(() => {
          log(`Edge still running ${killGraceMs / 1000} s after SIGTERM; killing it`);
          proc.kill("SIGKILL");
        }, killGraceMs);
        onStopped = () => {
          clearTimer(grace);
          resolve();
        };
        proc.kill("SIGTERM");
      });
    },
    /** For the tests: what is running and what is scheduled. */
    get child() {
      return child;
    },
    get nextDelay() {
      return delay;
    },
  };
}

// --- the command ----------------------------------------------------------

export function parseArgs(argv, env = process.env) {
  const options = {
    edgePath: env.BROWSER_BRIDGE_EDGE || DEFAULT_EDGE,
    profileDir: env.BROWSER_BRIDGE_EDGE_PROFILE || edgeProfileDir(env),
    extensionPath: path.join(PROJECT_DIR, "extension"),
  };
  const flags = { "--edge": "edgePath", "--user-data-dir": "profileDir", "--extension": "extensionPath" };
  for (let index = 0; index < argv.length; index++) {
    const key = flags[argv[index]];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} needs a value`);
    options[key] = value;
  }
  // Edge resolves a relative --user-data-dir against its own working directory, and the
  // installer's copy of the manifest is at an absolute one; make them the same directory.
  options.profileDir = path.resolve(options.profileDir);
  options.extensionPath = path.resolve(options.extensionPath);
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  // Private: the profile will hold cookies for whatever the sessions browse.
  fs.mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  const supervisor = createSupervisor(options);
  let signalled = false;
  const shutdown = async (signal) => {
    if (signalled) {
      // A second signal while Edge is taking its time: go now, and SIGKILL it on the way.
      supervisor.child?.kill("SIGKILL");
      process.exit(1);
    }
    signalled = true;
    process.stdout.write(`${new Date().toISOString()} ${signal}: stopping Edge\n`);
    await supervisor.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  supervisor.start();
}

if (isMainModule(import.meta.url)) {
  await main(process.argv.slice(2));
}
