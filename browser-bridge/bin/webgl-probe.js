#!/usr/bin/env node
// Asks a headless Edge which renderer its WebGL really got, and fails when that is a CPU one.
//
//   node bin/webgl-probe.js [--edge <path>] [--without-gpu-flags]
//
// Headless Chromium falls back to SwiftShader without a word when the GPU path does not come
// up, so a flag on a command line proves nothing: this starts Edge with the flags the
// headless-edge wrapper uses with --gpu, on a scratch profile (the wrapper's own Edge holds
// its profile's lock), loads a page that reads WEBGL_debug_renderer_info, and prints what
// came back. Exit 0 for a hardware renderer, 1 for a software one, a masked one or no WebGL
// at all, 2 for a probe that could not run (Edge missing, timed out, or dead before the
// page). --without-gpu-flags shows what Edge picks on its own.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule } from "../host/protocol.js";
import { DEFAULT_EDGE, GPU_ARGS } from "./headless-edge.js";

const PAGE = `<html><body><script>
const gl = document.createElement("canvas").getContext("webgl");
let r = "none";
if (gl) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  r = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "masked: " + gl.getParameter(gl.RENDERER);
}
document.body.textContent = "WEBGL_RENDERER=" + r + "=END";
</script></body></html>`;

export const PROBE_URL = `data:text/html;base64,${Buffer.from(PAGE).toString("base64")}`;

/** Renderers that mean the drawing happens on the CPU. */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software/i;

export function probeArgs(profileDir, { gpu = true } = {}) {
  return [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    ...(gpu ? GPU_ARGS : []),
    "--dump-dom",
    PROBE_URL,
  ];
}

/** The renderer string in Edge's dumped DOM, or null when the page never wrote one. */
export function parseRenderer(dom) {
  const match = /WEBGL_RENDERER=(.*?)=END/s.exec(dom);
  return match ? match[1] : null;
}

/**
 * `{ ok, renderer }`: ok only for a WebGL context on something other than a CPU renderer. A
 * masked renderer ("WebKit WebGL", when the debug extension is missing) says nothing either
 * way, so it does not pass.
 */
export function judge(renderer) {
  if (renderer === null || renderer === "none") return { ok: false, renderer: renderer ?? "none" };
  return { ok: !SOFTWARE_RENDERER.test(renderer) && !renderer.startsWith("masked: "), renderer };
}

export function parseArgs(argv, env = process.env) {
  const options = { edgePath: env.BROWSER_BRIDGE_EDGE || DEFAULT_EDGE, gpu: true };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--without-gpu-flags") options.gpu = false;
    else if (arg === "--edge") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--edge needs a path");
      options.edgePath = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "webgl-probe-"));
  try {
    const result = spawnSync(options.edgePath, probeArgs(profileDir, options), {
      encoding: "utf8",
      timeout: 60_000,
      // Edge's stderr is chatty (D-Bus complaints on a headless box); past the default 1 MB
      // spawnSync would kill it and report ENOBUFS, which is not a GPU answer.
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      process.stderr.write(`could not run ${options.edgePath}: ${result.error.message}\n`);
      return 2;
    }
    const renderer = parseRenderer(result.stdout ?? "");
    if (renderer === null && (result.status !== 0 || result.signal)) {
      // Edge died before the page ran: that says nothing about the GPU flags.
      const how = result.signal ? `signal ${result.signal}` : `code ${result.status}`;
      const tail = (result.stderr ?? "").trim().split("\n").slice(-5).join("\n");
      process.stderr.write(`${options.edgePath} exited with ${how} before the page ran${tail ? `:\n${tail}` : ""}\n`);
      return 2;
    }
    const verdict = judge(renderer);
    process.stdout.write(`${verdict.ok ? "hardware" : "SOFTWARE OR NONE"}: ${verdict.renderer}\n`);
    return verdict.ok ? 0 : 1;
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
