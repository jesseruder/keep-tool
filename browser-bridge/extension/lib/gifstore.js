// Where a group's GIF frames live: IndexedDB in the service worker, so a recording
// survives the worker being torn down between two of the model's actions (which happens
// constantly — a screenshot and the click after it can easily be two worker lifetimes).
//
// One recording per tab group, because a group is a session. Frame blobs and the
// recording's counters are written in one transaction, so the counters never disagree
// with what is actually stored.
//
// The IndexedDB calls are wrapped in one small backend object that the tests replace
// with an in-memory one: everything above that line (caps, ordering, the boot check,
// the recording lifecycle) is then covered without a browser.

import { MAX_BYTES, MAX_FRAMES, capReached } from "./gifframes.js";

const DB_NAME = "browser-bridge-gif";
const DB_VERSION = 1;
const META_STORE = "recordings";
const FRAME_STORE = "frames";
const BOOT_KEY = "bridge.gifBoot";

// --- the backend ----------------------------------------------------------

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "groupId" });
      }
      if (!db.objectStoreNames.contains(FRAME_STORE)) {
        // [recordingId, seq] keeps one group's frames contiguous and already in order.
        db.createObjectStore(FRAME_STORE, { keyPath: ["recordingId", "seq"] });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Could not open the GIF database"));
  });
  dbPromise = dbPromise.catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** The only code in this file that touches IndexedDB. */
const idbBackend = {
  async getMeta(groupId) {
    const db = await openDb();
    const transaction = db.transaction(META_STORE, "readonly");
    const meta = await request(transaction.objectStore(META_STORE).get(groupId));
    return meta ?? null;
  },
  async putMeta(meta) {
    const db = await openDb();
    const transaction = db.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put(meta);
    await finished(transaction);
  },
  async putFrame(frame, meta) {
    const db = await openDb();
    const transaction = db.transaction([FRAME_STORE, META_STORE], "readwrite");
    transaction.objectStore(FRAME_STORE).put(frame);
    transaction.objectStore(META_STORE).put(meta);
    await finished(transaction);
  },
  async listFrames(recordingId) {
    const db = await openDb();
    const transaction = db.transaction(FRAME_STORE, "readonly");
    const range = IDBKeyRange.bound([recordingId, -Infinity], [recordingId, Infinity]);
    const frames = await request(transaction.objectStore(FRAME_STORE).getAll(range));
    return frames ?? [];
  },
  async deleteFrames(recordingId) {
    const db = await openDb();
    const transaction = db.transaction(FRAME_STORE, "readwrite");
    const range = IDBKeyRange.bound([recordingId, -Infinity], [recordingId, Infinity]);
    transaction.objectStore(FRAME_STORE).delete(range);
    await finished(transaction);
  },
  async clearFramesAndMeta(recordingId, meta) {
    const db = await openDb();
    const transaction = db.transaction([FRAME_STORE, META_STORE], "readwrite");
    const range = IDBKeyRange.bound([recordingId, -Infinity], [recordingId, Infinity]);
    transaction.objectStore(FRAME_STORE).delete(range);
    transaction.objectStore(META_STORE).put(meta);
    await finished(transaction);
  },
  async deleteMeta(groupId) {
    const db = await openDb();
    const transaction = db.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).delete(groupId);
    await finished(transaction);
  },
};

let backend = idbBackend;

/** Tests swap in an in-memory backend; nothing else calls this. */
export function setGifBackend(replacement) {
  backend = replacement ?? idbBackend;
}

// --- one writer at a time -------------------------------------------------

// Every mutation is a read-modify-write of one group's counters. Two frames captured at
// the same moment would otherwise both read the same count and one would overwrite the
// other's total.
let queue = Promise.resolve();

function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- the boot id ----------------------------------------------------------

// IndexedDB outlives the browser session but tab group ids do not: after a restart,
// group 100 is a different group. chrome.storage.session is cleared on restart and kept
// across worker restarts, which is exactly the lifetime a recording has, so a stored
// boot id tells a live recording apart from one left behind by the previous run.
let bootIdPromise = null;

function currentBootId() {
  if (bootIdPromise) return bootIdPromise;
  bootIdPromise = (async () => {
    const stored = await chrome.storage.session.get(BOOT_KEY);
    if (stored[BOOT_KEY]) return stored[BOOT_KEY];
    const id = `boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await chrome.storage.session.set({ [BOOT_KEY]: id });
    return id;
  })();
  bootIdPromise = bootIdPromise.catch((error) => {
    bootIdPromise = null;
    throw error;
  });
  return bootIdPromise;
}

/** For tests that want a fresh module state without re-importing. */
export function resetBootIdCache() {
  bootIdPromise = null;
}

async function liveMeta(groupId) {
  const meta = await backend.getMeta(groupId);
  if (!meta) return null;
  const boot = await currentBootId();
  if (meta.bootId === boot) return meta;
  // Left over from a previous browser session: the group id has been recycled, so the
  // frames belong to nobody. Drop them instead of showing them to whoever holds the id.
  await backend.deleteFrames(meta.recordingId);
  await backend.deleteMeta(groupId);
  return null;
}

// --- the recording lifecycle ---------------------------------------------

function emptyCounters() {
  return { frames: 0, bytes: 0, capped: null, nextSeq: 0 };
}

/**
 * Start (or keep) the group's recording. Returns `{ meta, alreadyRecording }`; starting
 * an already-running recording is a no-op the tool reports as a note.
 */
export function startRecording(groupId, { sessionKey = null, name = null } = {}) {
  return serialize(async () => {
    const existing = await liveMeta(groupId);
    if (existing?.recording) return { meta: existing, alreadyRecording: true };
    const boot = await currentBootId();
    const meta = existing
      ? { ...existing, recording: true, startedAt: Date.now() }
      : {
          groupId,
          recordingId: `${boot}_g${groupId}_${Date.now().toString(36)}`,
          bootId: boot,
          sessionKey,
          name,
          recording: true,
          startedAt: Date.now(),
          ...emptyCounters(),
        };
    await backend.putMeta(meta);
    return { meta, alreadyRecording: false };
  });
}

/** Stop capturing but keep the frames, as the tool contract promises. */
export function stopRecording(groupId) {
  return serialize(async () => {
    const meta = await liveMeta(groupId);
    if (!meta) return null;
    const next = { ...meta, recording: false, stoppedAt: Date.now() };
    await backend.putMeta(next);
    return next;
  });
}

export function recordingFor(groupId) {
  return serialize(() => liveMeta(groupId));
}

/**
 * Store one frame. Returns `{ added, cap }`: at a cap the recording stays on (so the
 * model's `stop_recording` still behaves) but nothing more is stored, and `export` says
 * so.
 */
export function addFrame(groupId, frame) {
  return serialize(async () => {
    const meta = await liveMeta(groupId);
    if (!meta?.recording) return { added: false, cap: null, recording: false };

    const bytes = Number(frame.blob?.size ?? frame.bytes ?? 0);
    // Once a recording is capped it stays capped until `clear` resets the counters:
    // dropping under a cap again would otherwise make the GIF skip the middle. The
    // incoming frame's own size counts towards the cap before it is written, not after.
    const cap = meta.capped ?? capReached(meta, bytes);
    if (cap) {
      if (meta.capped !== cap) await backend.putMeta({ ...meta, capped: cap });
      return { added: false, cap, recording: true };
    }

    const record = { ...frame, recordingId: meta.recordingId, seq: meta.nextSeq, bytes };
    const next = {
      ...meta,
      frames: meta.frames + 1,
      bytes: meta.bytes + bytes,
      nextSeq: meta.nextSeq + 1,
    };
    await backend.putFrame(record, next);
    return { added: true, cap: capReached(next), recording: true, seq: record.seq };
  });
}

/**
 * Remember that a cap stopped this recording. The recorder calls this instead of
 * capturing a frame it already knows will be refused, so `export` can still explain why
 * the GIF ends where it does.
 */
export function noteCap(groupId, cap) {
  return serialize(async () => {
    const meta = await liveMeta(groupId);
    if (!meta || meta.capped === cap) return meta;
    const next = { ...meta, capped: cap };
    await backend.putMeta(next);
    return next;
  });
}

/** The group's frames in capture order. */
export function listFrames(groupId) {
  return serialize(async () => {
    const meta = await liveMeta(groupId);
    if (!meta) return { meta: null, frames: [] };
    const frames = await backend.listFrames(meta.recordingId);
    frames.sort((a, b) => a.seq - b.seq);
    return { meta, frames };
  });
}

/**
 * `clear`: the frames go, the recording state stays (and can fill up again).
 *
 * Both halves are one transaction: a worker terminated between them would leave a
 * recording with no frames but the old counters, and a cap that refuses to record
 * anything into an empty take.
 */
export function clearFrames(groupId) {
  return serialize(async () => {
    const meta = await liveMeta(groupId);
    if (!meta) return null;
    const next = { ...meta, ...emptyCounters() };
    await backend.clearFramesAndMeta(meta.recordingId, next);
    return next;
  });
}

/** The group is gone (closed, or its session ended): nothing of it is worth keeping. */
export function forgetGroupFrames(groupId) {
  return serialize(async () => {
    const meta = await backend.getMeta(groupId);
    if (!meta) return false;
    await backend.deleteFrames(meta.recordingId);
    await backend.deleteMeta(groupId);
    return true;
  });
}

export { MAX_BYTES, MAX_FRAMES };
