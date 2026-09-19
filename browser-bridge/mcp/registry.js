// Which MCP session id belongs to which browser session, across daemon restarts.
//
// Why this exists: the SDK's client throws `Session not found` on a 404 and never resets
// its session id, so a daemon that answered 404 after a restart stranded every live agent
// permanently - and `node bin/install.js` restarts the daemon on every landing. The daemon
// therefore *adopts* an id it does not know instead of refusing it, and this file is what
// lets the adopted session keep its `sessionKey`, and so its Edge tab group, instead of
// opening a second one beside the tabs the agent was using.
//
// A leaf module: node built-ins only, so the tests can load it on its own.

import fs from "node:fs";
import path from "node:path";

/** An id nobody has used for a day is not coming back. */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** `lastSeen` is written at most this often; every request would mean a write per call. */
export const TOUCH_INTERVAL_MS = 60_000;
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

  /** Reads the file if it is there, drops anything stale, and never throws. */
  load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.sessionKey !== "string" || entry.sessionKey.length < 8) continue;
        this.#entries.set(id, {
          sessionKey: entry.sessionKey,
          name: typeof entry.name === "string" ? entry.name : null,
          agent: typeof entry.agent === "string" ? entry.agent : null,
          account: typeof entry.account === "string" ? entry.account : null,
          lastSeen: Number.isFinite(entry.lastSeen) ? entry.lastSeen : 0,
          ended: Number.isFinite(entry.ended) ? entry.ended : undefined,
        });
      }
    }
    this.prune();
    return this;
  }

  get size() {
    return this.#entries.size;
  }

  get(id) {
    return this.#entries.get(id) ?? null;
  }

  /** Record a session, live. Overwrites a tombstone for the same id. */
  put(id, { sessionKey, name = null, agent = null, account = null }) {
    this.#entries.set(id, { sessionKey, name, agent, account, lastSeen: this.#now() });
    this.#scheduleSave();
  }

  /**
   * Move `lastSeen` forward, but not on every request: an agent makes hundreds of calls and
   * the only thing this timestamp decides is when the entry may be pruned.
   */
  touch(id, at = this.#now()) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (at - entry.lastSeen < TOUCH_INTERVAL_MS) return;
    entry.lastSeen = at;
    this.#scheduleSave();
  }

  /**
   * A tombstone, not a deletion. The extension keeps an ended session's tabs under an
   * `ended` flag and gives the group back to the same `sessionKey`, so an id that comes
   * back after its session was closed - which is exactly what a client does after a daemon
   * restart, or after the stream-loss rule fired early - must be able to find its key.
   */
  end(id, at = this.#now()) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.ended = at;
    entry.lastSeen = at;
    this.#scheduleSave();
  }

  prune(at = this.#now()) {
    let dropped = 0;
    for (const [id, entry] of this.#entries) {
      if (at - Math.max(entry.lastSeen, entry.ended ?? 0) > REGISTRY_TTL_MS) {
        this.#entries.delete(id);
        dropped += 1;
      }
    }
    if (dropped > 0) this.#scheduleSave();
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
   * daemon killed mid-write leaves the previous registry intact rather than a truncated
   * file that would strand every session it named. Failures are swallowed - losing the
   * registry costs a tab group, not a session.
   */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const object = {};
    for (const [id, entry] of this.#entries) {
      object[id] = { ...entry };
      if (entry.ended === undefined) delete object[id].ended;
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
