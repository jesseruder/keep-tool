// What the daemon remembers about a session id between restarts.
//
// Deliberately *not* the session key. Keys are derived from the id (see
// `deriveSessionKey`), so nothing here would let a reader of this file drive somebody else's
// tab group - which is exactly what storing keys allowed. What is left is only what cannot be
// derived: the labels to fall back on when a client stops sending its headers, when the id was
// last used, and whether its session ended and who ended it.
//
// Entries are filed under `deriveRegistryKey(secret, id)`, so the file names neither the
// session ids nor anything derived from them for the socket.
//
// A leaf module: node built-ins only, so the tests can load it on its own.

import fs from "node:fs";
import path from "node:path";

/** An id nobody has used for a day is not coming back. */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** `lastSeen` is written at most this often; every request would mean a write per call. */
export const TOUCH_INTERVAL_MS = 60_000;
/** A bound on the file, so a machine that churns sessions cannot grow it without limit. */
export const MAX_ENTRIES = 500;
const WRITE_DELAY_MS = 250;

export class SessionRegistry {
  #file;
  #now;
  #writeDelayMs;
  #timer = null;
  #entries = new Map();

  constructor({ file, now = () => Date.now(), writeDelayMs = WRITE_DELAY_MS }) {
    this.#file = file;
    this.#now = now;
    this.#writeDelayMs = writeDelayMs;
  }

  /** Reads the file if it is there, drops anything stale or malformed, and never throws. */
  load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (!/^[0-9a-f]{64}$/.test(key)) continue; // not one of ours
        this.#entries.set(key, {
          name: typeof entry.name === "string" ? entry.name : null,
          agent: typeof entry.agent === "string" ? entry.agent : null,
          account: typeof entry.account === "string" ? entry.account : null,
          lastSeen: Number.isFinite(entry.lastSeen) ? entry.lastSeen : 0,
          ended: Number.isFinite(entry.ended) ? entry.ended : undefined,
          endedBy: entry.endedBy === "client" || entry.endedBy === "daemon" ? entry.endedBy : undefined,
        });
      }
    }
    this.prune();
    return this;
  }

  get size() {
    return this.#entries.size;
  }

  get(key) {
    return this.#entries.get(key) ?? null;
  }

  /** Record a session, live. Clears any tombstone for the same key. */
  put(key, { name = null, agent = null, account = null }) {
    this.#entries.set(key, { name, agent, account, lastSeen: this.#now() });
    this.#capEntries();
    this.#scheduleSave();
  }

  /**
   * Move `lastSeen` forward, but not on every request: an agent makes hundreds of calls and
   * the only thing this timestamp decides is when the entry may be pruned.
   */
  touch(key, at = this.#now()) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (at - entry.lastSeen < TOUCH_INTERVAL_MS) return;
    entry.lastSeen = at;
    this.#scheduleSave();
  }

  /**
   * A tombstone, not a deletion, and `by` matters.
   *
   * `daemon` - the sweep decided the client had gone - may be adopted back: the client may
   * well still be there and simply have been quiet, and then it should find its own tabs
   * again. `client` means the client itself sent DELETE; that session is over, its group has
   * been released, and the id must not come back to life and take the group with it.
   */
  end(key, { by = "daemon", at = this.#now() } = {}) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.ended = at;
    entry.endedBy = by;
    entry.lastSeen = at;
    this.#scheduleSave();
  }

  prune(at = this.#now()) {
    let dropped = 0;
    for (const [key, entry] of this.#entries) {
      if (at - Math.max(entry.lastSeen, entry.ended ?? 0) > REGISTRY_TTL_MS) {
        this.#entries.delete(key);
        dropped += 1;
      }
    }
    dropped += this.#capEntries();
    if (dropped > 0) this.#scheduleSave();
    return dropped;
  }

  /** Oldest first, because the newest entries are the ones a client may still present. */
  #capEntries() {
    if (this.#entries.size <= MAX_ENTRIES) return 0;
    const byAge = [...this.#entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    let dropped = 0;
    while (this.#entries.size > MAX_ENTRIES && dropped < byAge.length) {
      this.#entries.delete(byAge[dropped][0]);
      dropped += 1;
    }
    return dropped;
  }

  #scheduleSave() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#writeDelayMs);
    this.#timer.unref?.();
  }

  /**
   * Write the whole map, atomically: a tmp file in the same directory and a rename, so a
   * daemon killed mid-write leaves the previous registry intact rather than a truncated file.
   * Failures are swallowed - losing this costs a session its name, not its session.
   */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const object = {};
    for (const [key, entry] of this.#entries) {
      object[key] = { ...entry };
      if (entry.ended === undefined) {
        delete object[key].ended;
        delete object[key].endedBy;
      }
    }
    const tmp = `${this.#file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(object, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing left to clean up
      }
    }
  }

  close() {
    this.flush();
  }
}
