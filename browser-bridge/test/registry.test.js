// The session registry on its own: what the daemon remembers about a session id between
// restarts. Notably *not* its session key — that is derived, see mcp/identity.js.
//
// Everything here is a file and a clock. The daemon tests cover what it is for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveRegistryKey, deriveSessionKey } from "../mcp/identity.js";
import { MAX_ENTRIES, REGISTRY_TTL_MS, SessionRegistry } from "../mcp/registry.js";

const SECRET = "a1b2c3d4".repeat(8);
const KEY = deriveRegistryKey(SECRET, "mcp-session-1");

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "sessions.json");
}

test("a session key is derived from its id, the same way every time", () => {
  // The registry used to store these. That meant any local reader of the file could say hello
  // on the socket as somebody else and drive their tab group, so now nothing stores them: a
  // restart re-derives the same key from the same id and the file never sees either.
  const key = deriveSessionKey(SECRET, "mcp-session-1");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(deriveSessionKey(SECRET, "mcp-session-1"), key, "stable across calls");
  assert.notEqual(deriveSessionKey(SECRET, "mcp-session-2"), key, "and per session");
  assert.notEqual(deriveSessionKey("b".repeat(64), "mcp-session-1"), key, "and per machine");
  // The registry files an entry under a different label, so the file exposes neither the id
  // nor anything the socket would accept.
  assert.notEqual(KEY, key);
  assert.match(KEY, /^[0-9a-f]{64}$/);
});

test("an entry survives a reload, with its labels", (t) => {
  const file = tempFile(t);
  const clock = 1_000;
  const first = new SessionRegistry({ file, now: () => clock }).load();
  first.put(KEY, { name: "#12 fix-login", agent: "claude", account: "claude-tertiary" });
  first.flush();

  const second = new SessionRegistry({ file, now: () => clock }).load();
  assert.deepEqual(second.get(KEY), {
    name: "#12 fix-login",
    agent: "claude",
    account: "claude-tertiary",
    lastSeen: 1_000,
    ended: undefined,
    endedBy: undefined,
  });
  assert.equal(second.get(deriveRegistryKey(SECRET, "nobody")), null);
  assert.equal("sessionKey" in second.get(KEY), false, "there is no key to leak");
});

test("a tombstone records who ended the session", (t) => {
  const file = tempFile(t);
  let clock = 1_000;
  const registry = new SessionRegistry({ file, now: () => clock }).load();
  registry.put(KEY, { name: "gone" });
  clock = 5_000;

  // The sweep deciding a client has gone is a guess, and an id it ended may be adopted back.
  registry.end(KEY);
  assert.equal(registry.get(KEY).ended, 5_000);
  assert.equal(registry.get(KEY).endedBy, "daemon");

  // A DELETE is not a guess: the group has been released and the id must stay closed.
  registry.end(KEY, { by: "client", at: 6_000 });
  assert.equal(registry.get(KEY).endedBy, "client");
  registry.end(deriveRegistryKey(SECRET, "never-existed")); // harmless
});

test("lastSeen is not rewritten on every touch", (t) => {
  const file = tempFile(t);
  const registry = new SessionRegistry({ file, now: () => 1_000, writeDelayMs: 1 }).load();
  registry.put(KEY, { name: "busy" });

  // An agent makes hundreds of calls and the only thing this timestamp decides is when the
  // entry may be pruned, so a write per request would be pure noise.
  registry.touch(KEY, 2_000);
  assert.equal(registry.get(KEY).lastSeen, 1_000);
  registry.touch(KEY, 1_000 + 61_000);
  assert.equal(registry.get(KEY).lastSeen, 62_000);
  registry.touch(deriveRegistryKey(SECRET, "missing"), 99_000); // harmless
});

test("stale entries are pruned, at load and on demand", (t) => {
  const file = tempFile(t);
  let clock = 1_000;
  const registry = new SessionRegistry({ file, now: () => clock }).load();
  registry.put(deriveRegistryKey(SECRET, "fresh"), { name: "fresh" });
  registry.put(deriveRegistryKey(SECRET, "stale"), { name: "stale" });
  registry.end(deriveRegistryKey(SECRET, "stale"));
  registry.flush();

  clock += REGISTRY_TTL_MS;
  assert.equal(registry.prune(clock), 0, "a day is not yet more than a day");
  clock += 1;
  assert.equal(registry.prune(clock), 2);
  assert.equal(registry.size, 0);

  // And a file full of expired entries comes back empty rather than growing forever.
  fs.writeFileSync(file, JSON.stringify({ [KEY]: { name: "old", lastSeen: 0 } }));
  assert.equal(new SessionRegistry({ file, now: () => REGISTRY_TTL_MS * 3 }).load().size, 0);
});

test("the number of entries is capped, oldest first", (t) => {
  const file = tempFile(t);
  let clock = 0;
  const registry = new SessionRegistry({ file, now: () => clock }).load();
  for (let index = 0; index < MAX_ENTRIES + 20; index++) {
    clock = index;
    registry.put(deriveRegistryKey(SECRET, `session-${index}`), { name: `#${index}` });
  }

  // The newest entries are the ones a client may still present, so the oldest give way.
  assert.equal(registry.size, MAX_ENTRIES);
  assert.equal(registry.get(deriveRegistryKey(SECRET, "session-0")), null);
  assert.equal(registry.get(deriveRegistryKey(SECRET, `session-${MAX_ENTRIES + 19}`)).name, `#${MAX_ENTRIES + 19}`);
});

test("a missing, unreadable or junk file is not a crash", (t) => {
  const file = tempFile(t);
  assert.equal(new SessionRegistry({ file }).load().size, 0, "nothing written yet");

  fs.writeFileSync(file, "{ not json");
  assert.equal(new SessionRegistry({ file }).load().size, 0);

  fs.writeFileSync(file, JSON.stringify(["an array"]));
  assert.equal(new SessionRegistry({ file }).load().size, 0);

  // Anything not filed under one of our derived keys is not ours to read.
  fs.writeFileSync(
    file,
    JSON.stringify({
      [KEY]: { name: "good", lastSeen: 10 },
      "a-raw-session-id": { name: "from an older format", lastSeen: 10 },
      notanobject: 7,
      [deriveRegistryKey(SECRET, "weird")]: { name: 42, lastSeen: "soon", endedBy: "somebody" },
    }),
  );
  const loaded = new SessionRegistry({ file, now: () => 20 }).load();
  assert.equal(loaded.size, 2);
  assert.equal(loaded.get(KEY).name, "good");
  assert.equal(loaded.get("a-raw-session-id"), null);
  const weird = loaded.get(deriveRegistryKey(SECRET, "weird"));
  assert.equal(weird.name, null, "a name that is not a string is no name");
  assert.equal(weird.lastSeen, 0);
  assert.equal(weird.endedBy, undefined, "and only the two reasons we write are read back");
});

test("the file is written atomically and stays private", (t) => {
  const file = tempFile(t);
  const registry = new SessionRegistry({ file, now: () => 1_000 }).load();
  registry.put(KEY, { name: "private" });
  registry.close();

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "renamed over, never left behind");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved[KEY].name, "private");
  assert.equal("ended" in saved[KEY], false, "a live entry has no tombstone fields");
  assert.equal("endedBy" in saved[KEY], false);

  // A directory where the file should be cannot be written, and that is not fatal either:
  // losing this costs a session its name, not its session.
  const blocked = tempFile(t);
  fs.mkdirSync(blocked);
  const stuck = new SessionRegistry({ file: blocked, now: () => 1 }).load();
  stuck.put(KEY, { name: "nowhere to go" });
  assert.doesNotThrow(() => stuck.flush());
});
