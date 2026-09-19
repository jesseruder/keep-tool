// The session registry on its own: what the daemon remembers about a session id between
// restarts. Notably *not* its session key — that is derived, see mcp/identity.js.
//
// Everything here is a file and a clock. The daemon tests cover what it is for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveRegistryKey, deriveSecretTag, deriveSessionKey } from "../mcp/identity.js";
import { MAX_ENTRIES, REGISTRY_TTL_MS, SessionRegistry } from "../mcp/registry.js";

const SECRET = "a1b2c3d4".repeat(8);
const KEY = deriveRegistryKey(SECRET, "mcp-session-1");

const OTHER_SECRET = "f0f0f0f0".repeat(8);

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "sessions.json");
}

function open(file, secret = SECRET, now = () => 1_000) {
  return new SessionRegistry({ file, secret, now }).load();
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
  const first = open(file, SECRET, () => clock);
  first.put(KEY, { name: "#12 fix-login", agent: "claude", account: "claude-tertiary" });
  first.flush();

  const second = open(file, SECRET, () => clock);
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
  const registry = open(file, SECRET, () => clock);
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
  const registry = new SessionRegistry({ file, secret: SECRET, now: () => 1_000, writeDelayMs: 1 }).load();
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
  const registry = open(file, SECRET, () => clock);
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
  fs.writeFileSync(
    file,
    JSON.stringify({ secretTag: deriveSecretTag(SECRET), sessions: { [KEY]: { name: "old", lastSeen: 0 } } }),
  );
  assert.equal(open(file, SECRET, () => REGISTRY_TTL_MS * 3).size, 0);
});

test("the number of entries is capped, oldest first", (t) => {
  const file = tempFile(t);
  let clock = 0;
  const registry = open(file, SECRET, () => clock);
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
  assert.equal(open(file).size, 0, "nothing written yet");

  fs.writeFileSync(file, "{ not json");
  assert.equal(open(file).size, 0);

  fs.writeFileSync(file, JSON.stringify(["an array"]));
  assert.equal(open(file).size, 0);

  // The older shape, a flat map with no tag, is not read at all.
  fs.writeFileSync(file, JSON.stringify({ [KEY]: { name: "from an older format", lastSeen: 10 } }));
  assert.equal(open(file).size, 0);

  // Anything not filed under one of our derived keys is not ours to read.
  fs.writeFileSync(
    file,
    JSON.stringify({
      secretTag: deriveSecretTag(SECRET),
      sessions: {
        [KEY]: { name: "good", lastSeen: 10 },
        "a-raw-session-id": { name: "not a derived key", lastSeen: 10 },
        notanobject: 7,
        [deriveRegistryKey(SECRET, "weird")]: { name: 42, lastSeen: "soon", endedBy: "somebody" },
      },
    }),
  );
  const loaded = open(file, SECRET, () => 20);
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
  const registry = open(file);
  registry.put(KEY, { name: "private" });
  registry.close();

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "renamed over, never left behind");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.secretTag, deriveSecretTag(SECRET));
  assert.equal(saved.sessions[KEY].name, "private");
  assert.equal("ended" in saved.sessions[KEY], false, "a live entry has no tombstone fields");
  assert.equal("endedBy" in saved.sessions[KEY], false);

  // A directory where the file should be cannot be written, and that is not fatal either:
  // losing this costs a session its name, not its session.
  const blocked = tempFile(t);
  fs.mkdirSync(blocked);
  const stuck = open(blocked);
  stuck.put(KEY, { name: "nowhere to go" });
  assert.doesNotThrow(() => stuck.flush());
});

test("a file written under another secret is dropped whole, and rewritten under this one", (t) => {
  const file = tempFile(t);

  // Rotating the secret makes every key in here unlookupable, so the rows are not stale - they
  // are unreadable. The installer cannot deal with this by deleting the file: the daemon it is
  // about to replace flushes its own copy on the way out and puts the old rows straight back.
  // So the check is here, where the reading happens.
  const before = open(file, OTHER_SECRET);
  before.put(deriveRegistryKey(OTHER_SECRET, "mcp-session-1"), { name: "#12 under the old secret" });
  before.close();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).secretTag, deriveSecretTag(OTHER_SECRET));

  const after = open(file, SECRET);
  assert.equal(after.size, 0, "not one entry survives the rotation");
  assert.equal(after.get(deriveRegistryKey(OTHER_SECRET, "mcp-session-1")), null);
  assert.equal(after.get(KEY), null);

  // And the file is rewritten under the new secret's tag, so the next start reads it normally.
  after.put(KEY, { name: "#12 under the new secret" });
  after.close();
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.secretTag, deriveSecretTag(SECRET));
  assert.deepEqual(Object.keys(saved.sessions), [KEY]);
  assert.equal(saved.sessions[KEY].name, "#12 under the new secret");
  assert.equal(fs.readFileSync(file, "utf8").includes("under the old secret"), false);

  // The tag says which secret, and nothing about it.
  assert.equal(deriveSecretTag(SECRET).length, 8);
  assert.notEqual(deriveSecretTag(SECRET), deriveSecretTag(OTHER_SECRET));
  assert.equal(SECRET.includes(deriveSecretTag(SECRET)), false);
});
