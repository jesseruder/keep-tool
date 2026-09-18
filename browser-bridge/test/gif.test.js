// gif_creator without a browser: a stubbed chrome, an in-memory frame store, and just
// enough of OffscreenCanvas / createImageBitmap for the real gifenc encoder to run. The
// GIF bytes the encode tests look at are real GIF bytes.

import assert from "node:assert/strict";
import test from "node:test";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// --- the browser stubs ----------------------------------------------------

const state = {
  storage: {},
  tabs: new Map(),
  groups: new Map(),
  downloads: [],
  cdp: [],
  screenshotSeq: 0,
  nextDownloadId: 1,
  downloadError: null,
};

function addTab(id, groupId) {
  state.tabs.set(id, { id, groupId, url: "https://example.com/app", title: "App", active: true, windowId: 1 });
  state.groups.set(groupId, { id: groupId, title: "session" });
  return state.tabs.get(id);
}

globalThis.chrome = {
  runtime: { id: "test-extension", getManifest: () => ({ version: "0.1.0" }) },
  storage: {
    session: {
      async get(key) {
        await tick();
        return key in state.storage ? { [key]: state.storage[key] } : {};
      },
      async set(values) {
        await tick();
        Object.assign(state.storage, values);
      },
    },
  },
  tabs: {
    async get(id) {
      await tick();
      if (!state.tabs.has(id)) throw new Error("no tab");
      return state.tabs.get(id);
    },
    async query({ groupId }) {
      await tick();
      return [...state.tabs.values()].filter((tab) => tab.groupId === groupId);
    },
    async update(id, changes) {
      await tick();
      Object.assign(state.tabs.get(id), changes);
      return state.tabs.get(id);
    },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  tabGroups: {
    async get(id) {
      await tick();
      if (!state.groups.has(id)) throw new Error("no group");
      return state.groups.get(id);
    },
    async update(id, changes) {
      await tick();
      Object.assign(state.groups.get(id), changes);
      return state.groups.get(id);
    },
    onRemoved: { addListener: () => {} },
  },
  windows: {
    async getLastFocused() {
      return { id: 1 };
    },
  },
  downloads: {
    async download(options) {
      await tick();
      if (state.downloadError) throw new Error(state.downloadError);
      state.downloads.push(options);
      return state.nextDownloadId++;
    },
  },
  debugger: {
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
    async attach() {
      await tick();
    },
    async detach() {
      await tick();
    },
    async sendCommand(target, method, params) {
      await tick();
      state.cdp.push({ target, method, params });
      if (method === "Runtime.evaluate") {
        // The viewport probe and the "let it paint" wait share this command.
        if (String(params?.expression ?? "").includes("innerWidth")) {
          return {
            result: {
              value: { width: 1000, height: 600, dpr: 2, scrollX: 0, scrollY: 0, url: "https://example.com/app", title: "App" },
            },
          };
        }
        if (String(params?.expression ?? "") === "document") {
          return { result: { objectId: "doc-1" } };
        }
        return { result: { value: null } };
      }
      if (method === "Page.captureScreenshot") {
        // Real base64, because the recorder decodes it on the way into a frame.
        state.screenshotSeq += 1;
        return { data: Buffer.from(`png-${state.screenshotSeq}`, "utf8").toString("base64") };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { ok: true, target: "div", name: "recording.gif", size: 1234 } } };
      }
      return {};
    },
  },
};

// --- an in-memory frame store --------------------------------------------

function memoryBackend() {
  const metas = new Map();
  const frames = new Map(); // recordingId -> [record]
  return {
    metas,
    frames,
    async getMeta(groupId) {
      return metas.has(groupId) ? structuredCloneish(metas.get(groupId)) : null;
    },
    async putMeta(meta) {
      metas.set(meta.groupId, structuredCloneish(meta));
    },
    async putFrame(frame, meta) {
      if (!frames.has(frame.recordingId)) frames.set(frame.recordingId, []);
      frames.get(frame.recordingId).push(frame);
      metas.set(meta.groupId, structuredCloneish(meta));
    },
    async listFrames(recordingId) {
      return [...(frames.get(recordingId) ?? [])];
    },
    async deleteFrames(recordingId) {
      frames.delete(recordingId);
    },
    async deleteMeta(groupId) {
      metas.delete(groupId);
    },
  };
}

/** Blobs do not survive structuredClone into a plain object here, and metas hold none. */
function structuredCloneish(value) {
  return { ...value };
}

// --- canvas stubs ---------------------------------------------------------

/** Every drawing call, so the overlay tests can look at what was painted. */
let drawn = [];

class FakeContext {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.fillStyle = "";
    this.strokeStyle = "";
    this.font = "";
    this.lineWidth = 1;
    this.textBaseline = "";
  }
  record(op, args) {
    drawn.push({ op, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, font: this.font });
  }
  clearRect(...args) {
    this.record("clearRect", args);
  }
  drawImage(...args) {
    this.record("drawImage", args);
  }
  fillRect(...args) {
    this.record("fillRect", args);
  }
  beginPath() {
    this.record("beginPath", []);
  }
  closePath() {
    this.record("closePath", []);
  }
  moveTo(...args) {
    this.record("moveTo", args);
  }
  lineTo(...args) {
    this.record("lineTo", args);
  }
  arcTo(...args) {
    this.record("arcTo", args);
  }
  arc(...args) {
    this.record("arc", args);
  }
  fill() {
    this.record("fill", []);
  }
  stroke() {
    this.record("stroke", []);
  }
  fillText(...args) {
    this.record("fillText", args);
  }
  measureText(text) {
    return { width: text.length * 7 };
  }
  getImageData(x, y, width, height) {
    // A gradient, so the quantizer has real work to do and the palette is not one colour.
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
      data[index * 4] = index % 256;
      data[index * 4 + 1] = (index * 7) % 256;
      data[index * 4 + 2] = (index * 13) % 256;
      data[index * 4 + 3] = 255;
    }
    return { data, width, height };
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.context = new FakeContext(width, height);
  }
  getContext() {
    return this.context;
  }
  async convertToBlob({ type } = {}) {
    return new Blob([new Uint8Array([1, 2, 3, 4])], { type: type ?? "image/png" });
  }
}

globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.createImageBitmap = async (blob) => {
  await tick();
  // Frames captured by the recorder are 1000x600 CSS px screenshots; the stub reports
  // that size so the downscale to 800 px wide is exercised for real.
  return { width: blob?.type === "image/gif" ? 100 : 1000, height: 600, close() {} };
};
globalThis.btoa = globalThis.btoa ?? ((text) => Buffer.from(text, "binary").toString("base64"));
globalThis.atob = globalThis.atob ?? ((text) => Buffer.from(text, "base64").toString("binary"));

// --- the modules under test ----------------------------------------------

const gifframes = await import("../extension/lib/gifframes.js");
const gifstore = await import("../extension/lib/gifstore.js");
const gifencode = await import("../extension/lib/gifencode.js");
const { gif_creator, recordAction } = await import("../extension/tools/gif.js");
const { computer } = await import("../extension/tools/computer.js");
const sessions = await import("../extension/lib/sessions.js");

let backend = memoryBackend();
gifstore.setGifBackend(backend);

async function freshGroup(sessionKey, groupId, tabId) {
  backend = memoryBackend();
  gifstore.setGifBackend(backend);
  drawn = [];
  state.downloads.length = 0;
  state.cdp.length = 0;
  state.downloadError = null;
  state.nextDownloadId = 1;
  const tab = addTab(tabId, groupId);
  await sessions.putSession(sessionKey, { name: `s-${sessionKey}`, groupId, windowId: 1 });
  return tab;
}

const ctx = (sessionKey) => ({ sessionKey, sessionName: `s-${sessionKey}` });

// --- labels, delays and caps (pure) --------------------------------------

test("an action label reads like the spec's examples", () => {
  const { actionLabel } = gifframes;
  assert.equal(actionLabel({ kind: "left_click", point: { x: 312.4, y: 400 } }), "Click (312, 400)");
  assert.equal(actionLabel({ kind: "right_click", point: { x: 1, y: 2 } }), "Right click (1, 2)");
  assert.equal(actionLabel({ kind: "type", text: "hello" }), 'Type "hello"');
  assert.equal(
    actionLabel({ kind: "type", text: "a very long sentence that nobody wants across the frame" }),
    'Type "a very long sentence tha..."',
  );
  assert.equal(actionLabel({ kind: "key", text: "cmd+a" }), "Press cmd+a");
  assert.equal(actionLabel({ kind: "scroll", direction: "down", point: { x: 5, y: 6 } }), "Scroll down");
  assert.equal(actionLabel({ kind: "navigate", url: "https://www.example.com/x?y=1" }), "Navigate example.com");
  assert.equal(actionLabel({ kind: "navigate", url: "back" }), "Navigate back");
  assert.equal(actionLabel({ kind: "screenshot" }), "Screenshot");
  assert.equal(
    actionLabel({ kind: "left_click_drag", from: { x: 10, y: 10 }, to: { x: 90, y: 20 } }),
    "Drag (10, 10) to (90, 20)",
  );
});

test("frame delays are the real gaps, clamped, with a long last frame", () => {
  const frames = [{ at: 0 }, { at: 50 }, { at: 1500 }, { at: 99_000 }, { at: 99_100 }];
  assert.deepEqual(gifframes.frameDelays(frames), [300, 1450, 3000, 300, 1500]);
  assert.equal(gifframes.totalDurationMs(frames), 300 + 1450 + 3000 + 300 + 1500);
  assert.deepEqual(gifframes.frameDelays([{ at: 5 }]), [1500]);
});

test("quality maps to a documented palette / precision tradeoff", () => {
  const best = gifframes.quantizerSettings(1);
  const middle = gifframes.quantizerSettings(10);
  const worst = gifframes.quantizerSettings(30);
  assert.deepEqual(best, { quality: 1, maxColors: 256, format: "rgb565", roundRGB: 0 });
  assert.equal(middle.roundRGB, 5, "quality 10 is gifenc's own default rounding");
  assert.ok(middle.maxColors < best.maxColors && middle.maxColors > worst.maxColors);
  assert.deepEqual(worst, { quality: 30, maxColors: 32, format: "rgb444", roundRGB: 15 });
  // Out of range values are clamped rather than refused.
  assert.equal(gifframes.quantizerSettings(0).quality, 1);
  assert.equal(gifframes.quantizerSettings(500).quality, 30);
  assert.equal(gifframes.quantizerSettings(undefined).quality, 10);
});

test("overlay options are all on except quality", () => {
  const defaults = gifframes.overlayOptions({});
  assert.equal(defaults.showClickIndicators, true);
  assert.equal(defaults.showWatermark, true);
  assert.equal(defaults.quality, 10);
  assert.equal(gifframes.overlayOptions({ showWatermark: false }).showWatermark, false);
});

// --- the store -----------------------------------------------------------

test("the store caps frames and keeps recording after the cap", async () => {
  await freshGroup("cap", 10, 1);
  await gifstore.startRecording(10, { sessionKey: "cap" });
  const frame = () => ({ at: Date.now(), blob: { size: 1000 }, width: 10, height: 10, scale: 1, action: {} });

  for (let index = 0; index < gifframes.MAX_FRAMES; index++) {
    const added = await gifstore.addFrame(10, frame());
    assert.equal(added.added, true, `frame ${index}`);
  }
  const refused = await gifstore.addFrame(10, frame());
  assert.equal(refused.added, false);
  assert.equal(refused.cap, "frames");
  assert.equal(refused.recording, true, "recording stays on at the cap");
  const meta = await gifstore.recordingFor(10);
  assert.equal(meta.frames, gifframes.MAX_FRAMES);
  assert.equal(meta.capped, "frames");
  assert.match(gifframes.capNote("frames"), /300-frame cap/);
});

test("the store caps bytes too", async () => {
  await freshGroup("bytes", 11, 2);
  await gifstore.startRecording(11, { sessionKey: "bytes" });
  const big = { at: Date.now(), blob: { size: gifframes.MAX_BYTES }, width: 10, height: 10, scale: 1, action: {} };
  assert.equal((await gifstore.addFrame(11, big)).added, true);
  const refused = await gifstore.addFrame(11, big);
  assert.equal(refused.cap, "bytes");
  assert.match(gifframes.capNote("bytes"), /60 MB cap/);
});

test("frames come back in capture order and clear empties them", async () => {
  await freshGroup("order", 12, 3);
  await gifstore.startRecording(12, { sessionKey: "order" });
  for (const at of [1, 2, 3]) {
    await gifstore.addFrame(12, { at, blob: { size: 10 }, width: 4, height: 4, scale: 1, action: { kind: "type" } });
  }
  const listed = await gifstore.listFrames(12);
  assert.deepEqual(
    listed.frames.map((item) => item.seq),
    [0, 1, 2],
  );
  await gifstore.clearFrames(12);
  const cleared = await gifstore.listFrames(12);
  assert.equal(cleared.frames.length, 0);
  assert.equal(cleared.meta.recording, true, "clear keeps recording on");
  assert.equal(cleared.meta.frames, 0);
});

test("a recording from a previous browser session is dropped, not adopted", async () => {
  await freshGroup("boot", 13, 4);
  await gifstore.startRecording(13, { sessionKey: "boot" });
  await gifstore.addFrame(13, { at: 1, blob: { size: 10 }, width: 4, height: 4, scale: 1, action: {} });
  // A browser restart clears chrome.storage.session but not IndexedDB, and group 13 is
  // then somebody else's group.
  delete state.storage["bridge.gifBoot"];
  gifstore.resetBootIdCache();
  assert.equal(await gifstore.recordingFor(13), null);
  assert.equal(backend.metas.size, 0, "the stale record is deleted rather than left to rot");
  assert.equal(backend.frames.size, 0);
});

test("forgetGroupFrames drops everything for a group", async () => {
  await freshGroup("forget", 14, 5);
  await gifstore.startRecording(14, { sessionKey: "forget" });
  await gifstore.addFrame(14, { at: 1, blob: { size: 10 }, width: 4, height: 4, scale: 1, action: {} });
  assert.equal(await gifstore.forgetGroupFrames(14), true);
  assert.equal(backend.metas.size, 0);
  assert.equal(backend.frames.size, 0);
  assert.equal(await gifstore.forgetGroupFrames(14), false);
});

// --- the tool ------------------------------------------------------------

test("start_recording twice is a no-op with a note", async () => {
  await freshGroup("start", 20, 30);
  const first = await gif_creator(ctx("start"), { action: "start_recording", tabId: 30 });
  assert.match(first.text, /Recording tab group 20/);
  const again = await gif_creator(ctx("start"), { action: "start_recording", tabId: 30 });
  assert.match(again.text, /Already recording tab group 20/);
  assert.match(again.text, /did nothing/);
});

test("a tab in another session's group is refused", async () => {
  await freshGroup("mine", 21, 31);
  addTab(32, 99); // a tab in a group this session does not own
  await assert.rejects(
    () => gif_creator(ctx("mine"), { action: "start_recording", tabId: 32 }),
    /^Error: Tab 32 is not in the same group$/,
  );
});

test("an unknown action is refused with the list of the real ones", async () => {
  await freshGroup("bogus", 22, 33);
  await assert.rejects(
    () => gif_creator(ctx("bogus"), { action: "pause", tabId: 33 }),
    /Unsupported gif_creator action: pause.*start_recording/s,
  );
});

test("export with no frames is an error", async () => {
  await freshGroup("empty", 23, 34);
  await gif_creator(ctx("empty"), { action: "start_recording", tabId: 34 });
  await assert.rejects(
    () => gif_creator(ctx("empty"), { action: "export", tabId: 34, download: true }),
    /No GIF frames for tab group 23/,
  );
});

test("export with neither download nor coordinate says which one to pass", async () => {
  await freshGroup("how", 24, 35);
  await gif_creator(ctx("how"), { action: "start_recording", tabId: 35 });
  await recordAction(ctx("how"), state.tabs.get(35), { kind: "left_click", point: { x: 10, y: 20 } });
  await assert.rejects(
    () => gif_creator(ctx("how"), { action: "export", tabId: 35 }),
    /pass download: true .* or coordinate/s,
  );
});

test("every computer action in a recording group becomes a frame", async () => {
  await freshGroup("rec", 25, 36);
  await gif_creator(ctx("rec"), { action: "start_recording", tabId: 36 });

  await computer(ctx("rec"), { action: "screenshot", tabId: 36 });
  await computer(ctx("rec"), { action: "left_click", tabId: 36, coordinate: [312, 400] });
  await computer(ctx("rec"), { action: "type", tabId: 36, text: "hello" });
  await computer(ctx("rec"), { action: "key", tabId: 36, text: "cmd+a" });
  await computer(ctx("rec"), { action: "scroll", tabId: 36, coordinate: [100, 100], scroll_direction: "down" });
  await computer(ctx("rec"), {
    action: "left_click_drag",
    tabId: 36,
    start_coordinate: [10, 10],
    coordinate: [90, 20],
  });
  await computer(ctx("rec"), { action: "screenshot", tabId: 36 });

  const { frames } = await gifstore.listFrames(25);
  assert.deepEqual(
    frames.map((frame) => frame.label),
    [
      "Screenshot",
      "Click (312, 400)",
      'Type "hello"',
      "Press cmd+a",
      "Scroll down",
      "Drag (10, 10) to (90, 20)",
      "Screenshot",
    ],
  );
  // 1000 CSS px wide viewport, stored at most 800 px wide, so the overlay scale is 0.8.
  assert.equal(frames[0].width, 800);
  assert.equal(frames[0].height, 480);
  assert.equal(frames[1].scale, 0.8);
  // The screenshot action's own image is reused instead of capturing the same pixels
  // twice: seven frames but only five extra captures.
  const captures = state.cdp.filter((call) => call.method === "Page.captureScreenshot").length;
  assert.equal(captures, 7, "two of the shots are the screenshot action's own");
});

test("nothing is captured when the group is not recording", async () => {
  await freshGroup("idle", 26, 37);
  await computer(ctx("idle"), { action: "left_click", tabId: 37, coordinate: [1, 2] });
  const listed = await gifstore.listFrames(26);
  assert.equal(listed.meta, null);
  assert.equal(listed.frames.length, 0);
});

test("stop_recording keeps the frames and export does not clear them", async () => {
  await freshGroup("keep", 27, 38);
  await gif_creator(ctx("keep"), { action: "start_recording", tabId: 38 });
  await computer(ctx("keep"), { action: "screenshot", tabId: 38 });
  await computer(ctx("keep"), { action: "left_click", tabId: 38, coordinate: [5, 5] });

  const stopped = await gif_creator(ctx("keep"), { action: "stop_recording", tabId: 38 });
  assert.match(stopped.text, /2 frame\(s\)/);
  assert.equal((await gifstore.listFrames(27)).frames.length, 2);

  // After stop, an action is no longer captured.
  await computer(ctx("keep"), { action: "left_click", tabId: 38, coordinate: [6, 6] });
  assert.equal((await gifstore.listFrames(27)).frames.length, 2);

  const exported = await gif_creator(ctx("keep"), { action: "export", tabId: 38, download: true });
  assert.match(exported.text, /2 frame\(s\)/);
  assert.match(exported.text, /frames are kept/);
  assert.equal((await gifstore.listFrames(27)).frames.length, 2, "export keeps the frames");

  const cleared = await gif_creator(ctx("keep"), { action: "clear", tabId: 38 });
  assert.match(cleared.text, /Cleared 2 frame\(s\)/);
  assert.equal((await gifstore.listFrames(27)).frames.length, 0);
});

test("export downloads a real GIF as a data URL and reports the numbers", async () => {
  await freshGroup("dl", 28, 39);
  await gif_creator(ctx("dl"), { action: "start_recording", tabId: 39 });
  await computer(ctx("dl"), { action: "screenshot", tabId: 39 });
  await computer(ctx("dl"), { action: "left_click", tabId: 39, coordinate: [100, 200] });

  const result = await gif_creator(ctx("dl"), {
    action: "export",
    tabId: 39,
    download: true,
    filename: "my flow",
  });
  assert.match(result.text, /Exported my flow\.gif: 2 frame\(s\), 1\.8s, .* 800x480 px\./);
  assert.match(result.text, /download id 1/);
  assert.equal(state.downloads.length, 1);
  const download = state.downloads[0];
  assert.equal(download.filename, "my flow.gif");
  assert.equal(download.saveAs, false);
  assert.match(download.url, /^data:image\/gif;base64,/);
  const bytes = Buffer.from(download.url.split(",")[1], "base64");
  assert.equal(bytes.subarray(0, 6).toString("latin1"), "GIF89a", "a real GIF header");
  // Two frames means two graphic control extensions with a delay each.
  assert.ok(bytes.length > 100);
  // The image bytes never go back to the model.
  assert.equal(result.image, undefined);
});

test("a filename cannot escape the download folder", async () => {
  await freshGroup("safe", 29, 40);
  await gif_creator(ctx("safe"), { action: "start_recording", tabId: 40 });
  await computer(ctx("safe"), { action: "screenshot", tabId: 40 });
  await gif_creator(ctx("safe"), {
    action: "export",
    tabId: 40,
    download: true,
    filename: "../../etc/evil",
  });
  assert.equal(state.downloads.at(-1).filename, "-.-etc-evil.gif");
});

test("a failed download is reported as an error, not as a success", async () => {
  await freshGroup("fail", 31, 41);
  await gif_creator(ctx("fail"), { action: "start_recording", tabId: 41 });
  await computer(ctx("fail"), { action: "screenshot", tabId: 41 });
  state.downloadError = "Download interrupted";
  await assert.rejects(
    () => gif_creator(ctx("fail"), { action: "export", tabId: 41, download: true }),
    /Could not download .*: Download interrupted/,
  );
});

test("export with a coordinate drops the GIF on the page", async () => {
  await freshGroup("drop", 32, 42);
  await gif_creator(ctx("drop"), { action: "start_recording", tabId: 42 });
  await computer(ctx("drop"), { action: "screenshot", tabId: 42 });
  const result = await gif_creator(ctx("drop"), {
    action: "export",
    tabId: 42,
    coordinate: [300, 400],
  });
  assert.match(result.text, /Dropped recording-.*\.gif on <div> at \(300, 400\) in tab 42\./);
  assert.equal(state.downloads.length, 0, "no download unless download: true");
  const call = state.cdp.find((entry) => entry.method === "Runtime.callFunctionOn");
  assert.equal(call.params.arguments[2].value, "image/gif");
});

test("a capped recording says so in the export result", async () => {
  await freshGroup("capnote", 33, 43);
  await gif_creator(ctx("capnote"), { action: "start_recording", tabId: 43 });
  await computer(ctx("capnote"), { action: "screenshot", tabId: 43 });
  // Pretend the cap was hit: the recorder writes the flag and stops capturing.
  await gifstore.noteCap(33, "frames");
  const before = state.cdp.filter((call) => call.method === "Page.captureScreenshot").length;
  await computer(ctx("capnote"), { action: "left_click", tabId: 43, coordinate: [1, 1] });
  assert.equal(
    state.cdp.filter((call) => call.method === "Page.captureScreenshot").length,
    before,
    "a capped recording does not even take the screenshot",
  );
  assert.equal((await gifstore.listFrames(33)).frames.length, 1);

  const exported = await gif_creator(ctx("capnote"), { action: "export", tabId: 43, download: true });
  assert.match(exported.text, /300-frame cap/);
});

test("a recording failure never breaks the action that triggered it", async () => {
  await freshGroup("broken", 34, 44);
  await gif_creator(ctx("broken"), { action: "start_recording", tabId: 44 });
  const original = backend.putFrame;
  backend.putFrame = async () => {
    throw new Error("IndexedDB is angry");
  };
  const result = await computer(ctx("broken"), { action: "left_click", tabId: 44, coordinate: [7, 8] });
  assert.match(result.text, /left_click on tab 44/);
  backend.putFrame = original;
});

// --- overlays and encoding ----------------------------------------------

function frameFor(action, { at = 0, scale = 0.8 } = {}) {
  return {
    at,
    action,
    label: gifframes.actionLabel(action),
    blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    width: 800,
    height: 480,
    scale,
  };
}

test("the overlays that are drawn follow the options", async () => {
  drawn = [];
  const frames = [
    frameFor({ kind: "left_click", point: { x: 100, y: 200 } }, { at: 0 }),
    frameFor({ kind: "left_click_drag", from: { x: 10, y: 10 }, to: { x: 100, y: 50 } }, { at: 500 }),
  ];
  await gifencode.encodeGif(frames, {});

  const arcs = drawn.filter((call) => call.op === "arc");
  assert.equal(arcs.length, 1, "one click indicator");
  assert.deepEqual(arcs[0].args.slice(0, 2), [80, 160], "the click is scaled into frame pixels");
  assert.match(arcs[0].fillStyle, /255, 106, 0/, "orange");

  const labels = drawn.filter((call) => call.op === "fillText").map((call) => call.args[0]);
  assert.ok(labels.includes("Click (100, 200)"));
  assert.ok(labels.includes("Browser Bridge"), "the watermark replaces the Claude logo");

  // The progress bar grows: half the width on the first of two frames, all of it on the
  // last, drawn at the bottom of the frame.
  const bars = drawn.filter((call) => call.op === "fillRect" && call.args[1] === 480 - 6);
  assert.equal(bars.length, 4, "a track and a fill per frame");
  assert.equal(bars[1].args[2], 400);
  assert.equal(bars[3].args[2], 800);

  // The drag arrow is red and runs from start to end in frame pixels.
  const lines = drawn.filter((call) => call.op === "lineTo" && call.strokeStyle === "#e01b24");
  assert.deepEqual(lines[0].args, [80, 40]);
});

test("every overlay can be switched off", async () => {
  drawn = [];
  await gifencode.encodeGif([frameFor({ kind: "left_click", point: { x: 1, y: 2 } })], {
    showClickIndicators: false,
    showDragPaths: false,
    showActionLabels: false,
    showProgressBar: false,
    showWatermark: false,
  });
  assert.equal(drawn.filter((call) => call.op === "arc").length, 0);
  assert.equal(drawn.filter((call) => call.op === "fillText").length, 0);
  assert.equal(drawn.filter((call) => call.op === "fillRect").length, 0);
});

test("the encoder writes one frame per capture with the clamped delays", async () => {
  const frames = [frameFor({ kind: "screenshot" }, { at: 0 }), frameFor({ kind: "screenshot" }, { at: 800 })];
  const { bytes, delays, width, height } = await gifencode.encodeGif(frames, { quality: 30 });
  assert.deepEqual(delays, [800, 1500]);
  assert.equal(width, 800);
  assert.equal(height, 480);
  assert.equal(Buffer.from(bytes.subarray(0, 6)).toString("latin1"), "GIF89a");
  assert.equal(bytes.at(-1), 0x3b, "the trailer byte: finish() was called");
  // GIF delays are in hundredths of a second, little endian: 80 and 150.
  const hundredths = [];
  for (let index = 0; index < bytes.length - 8; index++) {
    if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) {
      hundredths.push(bytes[index + 4] | (bytes[index + 5] << 8));
    }
  }
  assert.deepEqual(hundredths, [80, 150]);
});

test("encoding nothing is an error, not an empty GIF", async () => {
  await assert.rejects(() => gifencode.encodeGif([], {}), /No frames to encode/);
});

test("a data URL round trips the bytes", () => {
  const bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 255]);
  const url = gifencode.gifDataUrl(gifencode.bytesToBase64(bytes));
  assert.deepEqual([...gifencode.base64ToBytes(url.split(",")[1])], [...bytes]);
});
