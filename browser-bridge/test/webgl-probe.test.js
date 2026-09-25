// The WebGL probe without Edge: its arguments, the page it loads, and the verdict on a
// renderer string. Nothing here spawns a browser.

import assert from "node:assert/strict";
import test from "node:test";

import { GPU_ARGS } from "../bin/headless-edge.js";
import { PROBE_URL, judge, parseArgs, parseRenderer, probeArgs } from "../bin/webgl-probe.js";

test("the probe runs the wrapper's GPU flags on its own profile and dumps the probe page", () => {
  const args = probeArgs("/tmp/probe-1");
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--user-data-dir=/tmp/probe-1"));
  for (const flag of GPU_ARGS) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(-2), ["--dump-dom", PROBE_URL]);
  const page = Buffer.from(PROBE_URL.split(",")[1], "base64").toString("utf8");
  assert.match(page, /UNMASKED_RENDERER_WEBGL/);

  const bare = probeArgs("/tmp/probe-2", { gpu: false });
  for (const flag of GPU_ARGS) assert.ok(!bare.includes(flag), flag);
});

test("the renderer comes out of the dumped DOM, and a page that never ran gives null", () => {
  const dom = "<html><head></head><body>WEBGL_RENDERER=ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)=END</body></html>";
  assert.equal(parseRenderer(dom), "ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)");
  assert.equal(parseRenderer("<html><body></body></html>"), null);
});

test("a hardware renderer passes; SwiftShader, llvmpipe and no WebGL fail", () => {
  assert.equal(judge("ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)").ok, true);
  assert.equal(
    judge("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)").ok,
    false,
  );
  assert.equal(judge("llvmpipe (LLVM 20.1.2, 256 bits)").ok, false);
  assert.deepEqual(judge("none"), { ok: false, renderer: "none" });
  assert.deepEqual(judge(null), { ok: false, renderer: "none" });
  assert.equal(judge("masked: WebKit WebGL").ok, false);
});

test("arguments pick the Edge binary and whether the GPU flags go on", () => {
  assert.deepEqual(parseArgs([], {}), { edgePath: "/usr/bin/microsoft-edge", gpu: true });
  assert.equal(parseArgs([], { BROWSER_BRIDGE_EDGE: "/opt/edge" }).edgePath, "/opt/edge");
  assert.deepEqual(parseArgs(["--edge", "/opt/e", "--without-gpu-flags"], {}), { edgePath: "/opt/e", gpu: false });
  assert.throws(() => parseArgs(["--edge"], {}), /needs a path/);
  assert.throws(() => parseArgs(["--wat"], {}), /Unknown argument/);
});
