// The session registry on its own: the file that lets an adopted session keep its tab group.
//
// Everything here is a file and a clock. The daemon tests cover what it is *for*.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REGISTRY_TTL_MS, SessionRegistry } from "../mcp/registry.js";

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "sessions.json");
}

test("an entry survives a reload, with its key and its labels", (t) => {
  const file = tempFile(t);
  let clock = 1_000;
  const first = new SessionRegistry({ file, now: () => clock }).load();
  first.put("mcp-1", { sessionKey: "key-aaaaaaaa", name: "#12 fix-login", agent: "claude", account: "claude-tertiary" });
  first.flush();

  const second = new SessionRegistry({ file, now: () => clock }).load();
  assert.deepEqual(second.get("mcp-1"), {
    sessionKey: "key-aaaaaaaa",
    name: "#12 fix-login",
    agent: "claude",
    account: "claude-tertiary",
    lastSeen: 1_000,
    ended: undefined,
  });
  assert.equal(second.get("nobody"), null);
});

test("ending an entry leaves a tombstone that still carries the key", (t) => {
  const file = tempFile(t);
  let clock = 1_000;
  const registry = new SessionRegistry({ file, now: () => clock }).load();
  registry.put("mcp-1", { sessionKey: "key-aaaaaaaa", name: "gone" });
  clock = 5_000;
  registry.end("mcp-1");

  // The extension keeps an ended session's tabs and hands the group back to the same key, so
  // an id that comes back after its session was closed has to be able to find it.
  assert.equal(registry.get("mcp-1").sessionKey, "key-aaaaaaaa");
  assert.equal(registry.get("mcp-1").ended, 5_000);
  registry.end("never-existed"); // harmless
});

test("lastSeen is not rewritten on every touch", (t) => {
  const file = tempFile(t);
  let clock = 1_000;
  const registry = new SessionRegistry({ file, now: () => clock, writeDelayMs: 1 }).load();
  registry.put("mcp-1", { sessionKey: "key-aaaaaaaa" });

  // An agent makes hundreds of calls and the only thing this timestamp decides is when the
  // entry may be pruned, so a write per request would be pure noise.
  registry.touch("mcp-1", 2_000);
  assert.equal(registry.get("mcp-1").lastSeen, 1_000);
  registry.touch("mcp-1", 1_000 + 61_000);
  assert.equal(registry.get("mcp-1").lastSeen, 62_000);
  registry.touch("missing", 99_000); // harmless
});

test("stale entries are pruned, at load and on demand", (t) => {
  const file = tempFile(t);
  let clock = 1_000;
  const registry = new SessionRegistry({ file, now: () => clock }).load();
  registry.put("fresh", { sessionKey: "key-fresh-1" });
  registry.put("stale", { sessionKey: "key-stale-1" });
  registry.end("stale");
  registry.flush();

  clock += REGISTRY_TTL_MS;
  assert.equal(registry.prune(clock), 0, "a day is not yet more than a day");
  clock += 1;
  assert.equal(registry.prune(clock), 2);
  assert.equal(registry.size, 0);

  // And a file full of expired entries comes back empty rather than growing forever.
  fs.writeFileSync(file, JSON.stringify({ old: { sessionKey: "key-oldold1", lastSeen: 0 } }));
  const reloaded = new SessionRegistry({ file, now: () => REGISTRY_TTL_MS * 3 }).load();
  assert.equal(reloaded.size, 0);
});

test("a missing, unreadable or junk file is not a crash", (t) => {
  const file = tempFile(t);
  assert.equal(new SessionRegistry({ file }).load().size, 0, "nothing written yet");

  fs.writeFileSync(file, "{ not json");
  assert.equal(new SessionRegistry({ file }).load().size, 0);

  fs.writeFileSync(file, JSON.stringify(["an array"]));
  assert.equal(new SessionRegistry({ file }).load().size, 0);

  // Entries without a usable key are dropped rather than trusted: a session key is what the
  // extension matches a tab group on, and a short or missing one would match nothing.
  fs.writeFileSync(
    file,
    JSON.stringify({
      good: { sessionKey: "key-goodkey", lastSeen: 10 },
      nokey: { name: "no key at all", lastSeen: 10 },
      shortkey: { sessionKey: "abc", lastSeen: 10 },
      notanobject: 7,
      weird: { sessionKey: "key-weird-01", name: 42, lastSeen: "soon" },
    }),
  );
  const loaded = new SessionRegistry({ file, now: () => 20 }).load();
  assert.deepEqual([...["good", "nokey", "shortkey", "notanobject", "weird"].filter((id) => loaded.get(id))], [
    "good",
    "weird",
  ]);
  assert.equal(loaded.get("weird").name, null, "a name that is not a string is no name");
  assert.equal(loaded.get("weird").lastSeen, 0);
});

test("the file is written atomically and stays private", (t) => {
  const file = tempFile(t);
  const registry = new SessionRegistry({ file, now: () => 1_000 }).load();
  registry.put("mcp-1", { sessionKey: "key-aaaaaaaa", name: "private" });
  registry.close();

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "renamed over, never left behind");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["mcp-1"].name, "private");
  // A tombstone is written without an undefined `ended` key.
  assert.equal("ended" in JSON.parse(fs.readFileSync(file, "utf8"))["mcp-1"], false);

  // A directory where the file should be cannot be written, and that is not fatal either:
  // losing the registry costs a tab group, not a session.
  const blocked = tempFile(t);
  fs.mkdirSync(blocked);
  const stuck = new SessionRegistry({ file: blocked, now: () => 1 }).load();
  stuck.put("mcp-1", { sessionKey: "key-aaaaaaaa" });
  assert.doesNotThrow(() => stuck.flush());
});
