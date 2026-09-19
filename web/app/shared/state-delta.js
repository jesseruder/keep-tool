// Shared by the frontend worker and the console: a two-level keyed delta over the
// `console=1` state projection. The worker diffs consecutive publications, the
// browser applies the chain to the snapshot it already holds, so a reload carries
// the rows that changed instead of the whole 780 KB projection.
(function (root) {
  'use strict';

  // Every array in the console projection whose rows carry a stable identity, and
  // the field that identifies a row. Each entry was checked against a live
  // projection: the key is present on every row and unique across it. Paths are at
  // most two levels deep — this is a fixed table, not a generic JSON patch.
  //
  // Deliberately absent, because their rows have no unique key (checked live):
  //   review.events — no `id`; `at` collides (296 unique of 300) and so does
  //     `at|kind|sessionId` (297 of 300), so the log stays a wholesale field.
  //   attention — no `id` on most rows; `key` collides between two `unblocked`
  //     rows for the same card (11 unique of 12). It is ~5 KB, so wholesale is cheap.
  //   handoffQueue, reminders, restarts — no id field at all.
  const KEYED_PATHS = {
    tasks: 'id',
    sessions: 'id',
    panes: 'id',
    notifications: 'id',
    accounts: 'id',
    handoffs: 'id',
    agents: 'name',
    'reviewQueue.items': 'id',
    'health.schedulers': 'name',
    'limitResume.waiting': 'id',
    'limitResume.sent': 'id',
  };

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // Values are compared by their JSON form, because that is exactly what the delta
  // channel transports. The projection builds its objects from the same spreads
  // every time, so key order is stable; more importantly, two values the console
  // cannot tell apart after JSON.parse must not produce a delta, and a property
  // whose value is `undefined` must read as absent on both sides of the wire.
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function present(source, key) {
    return Object.hasOwn(source, key) && source[key] !== undefined;
  }

  function buildSpec(paths) {
    const spec = { keyed: {}, nested: {} };
    for (const path of Object.keys(paths)) {
      const parts = path.split('.');
      if (parts.length === 1) { spec.keyed[parts[0]] = paths[path]; continue; }
      if (parts.length !== 2) throw new Error(`keyed delta paths are at most two levels: ${path}`);
      const child = spec.nested[parts[0]] || (spec.nested[parts[0]] = { keyed: {}, nested: {} });
      child.keyed[parts[1]] = paths[path];
    }
    return spec;
  }

  const SPEC = buildSpec(KEYED_PATHS);

  // A path only earns a keyed diff when the live rows really are keyed: every row
  // an object carrying a non-empty string or a finite number, no duplicates.
  // Anything else (a test fixture, a shape change) falls back to a wholesale field.
  // NaN and Infinity are refused because JSON writes them as null, which would
  // collapse distinct rows into one id the moment the delta crossed the wire.
  function keyable(rows, key) {
    if (!Array.isArray(rows)) return false;
    const seen = new Set();
    for (const row of rows) {
      if (!isPlainObject(row)) return false;
      const id = row[key];
      if (typeof id === 'number' ? !Number.isFinite(id) : (typeof id !== 'string' || !id)) return false;
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }

  function rowKey(row, key) {
    if (!isPlainObject(row)) throw new Error('a keyed delta applies to rows of objects');
    return row[key];
  }

  // { key, upsert?, remove?, order? }. `order` is the complete id list in the next
  // order, and is sent whenever the id sequence changed at all — which covers every
  // add and every remove, so apply can always rebuild the exact array.
  function diffKeyed(previous, next, key) {
    const before = new Map(previous.map((row) => [row[key], row]));
    const after = new Map(next.map((row) => [row[key], row]));
    const diff = { key };
    const upsert = next.filter((row) => !before.has(row[key]) || !same(before.get(row[key]), row));
    const remove = previous.map((row) => row[key]).filter((id) => !after.has(id));
    if (upsert.length) diff.upsert = upsert;
    if (remove.length) diff.remove = remove;
    const order = next.map((row) => row[key]);
    const was = previous.map((row) => row[key]);
    if (order.length !== was.length || order.some((id, index) => id !== was[index])) diff.order = order;
    return diff;
  }

  function applyKeyed(base, diff) {
    if (!Array.isArray(base)) throw new Error('a keyed delta applies to an array');
    const key = diff.key;
    if (typeof key !== 'string' || !key) throw new Error('a keyed delta names no key field');
    const upserts = new Map((diff.upsert || []).map((row) => [rowKey(row, key), row]));
    if (diff.order) {
      const rows = new Map(base.map((row) => [rowKey(row, key), row]));
      for (const id of upserts.keys()) rows.set(id, upserts.get(id));
      return diff.order.map((id) => {
        if (!rows.has(id)) throw new Error(`a keyed delta orders an unknown row: ${id}`);
        return rows.get(id);
      });
    }
    // No order means the id sequence is untouched, so nothing was added or removed.
    if (diff.remove && diff.remove.length) throw new Error('a keyed delta removes rows without an order');
    const known = new Set(base.map((row) => rowKey(row, key)));
    for (const id of upserts.keys()) {
      if (!known.has(id)) throw new Error(`a keyed delta adds a row without an order: ${id}`);
    }
    return base.map((row) => (upserts.has(row[key]) ? upserts.get(row[key]) : row));
  }

  // { set?, remove?, keyed?, nested? }. An unchanged container diffs to `{}`.
  function diffContainer(previous, next, spec) {
    const set = {};
    const remove = [];
    const keyed = {};
    const nested = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const has = present(next, key);
      if (!has) { if (present(previous, key)) remove.push(key); continue; }
      if (!present(previous, key)) { set[key] = next[key]; continue; }
      const before = previous[key];
      const after = next[key];
      if (same(before, after)) continue;
      const id = spec.keyed[key];
      if (id && keyable(before, id) && keyable(after, id)) { keyed[key] = diffKeyed(before, after, id); continue; }
      const child = spec.nested[key];
      if (child && isPlainObject(before) && isPlainObject(after)) { nested[key] = diffContainer(before, after, child); continue; }
      set[key] = after;
    }
    const delta = {};
    if (Object.keys(set).length) delta.set = set;
    if (remove.length) delta.remove = remove;
    if (Object.keys(keyed).length) delta.keyed = keyed;
    if (Object.keys(nested).length) delta.nested = nested;
    return delta;
  }

  // Pure: a new object every level the delta touches, `base` never mutated, and
  // untouched sub-objects shared by reference. Apply needs no path table — every
  // keyed diff names its own key field.
  function applyContainer(base, delta) {
    if (!isPlainObject(base)) throw new Error('a console delta applies to an object');
    if (!isPlainObject(delta)) throw new Error('a console delta must be an object');
    const result = { ...base };
    for (const key of delta.remove || []) delete result[key];
    for (const key of Object.keys(delta.set || {})) result[key] = delta.set[key];
    for (const key of Object.keys(delta.keyed || {})) result[key] = applyKeyed(base[key], delta.keyed[key]);
    for (const key of Object.keys(delta.nested || {})) result[key] = applyContainer(base[key], delta.nested[key]);
    return result;
  }

  function diffConsoleState(previous, next) {
    if (!isPlainObject(previous) || !isPlainObject(next)) {
      throw new Error('a console state delta needs two projections');
    }
    return diffContainer(previous, next, SPEC);
  }

  function applyConsoleDelta(base, delta) {
    return applyContainer(base, delta);
  }

  const api = { KEYED_PATHS, diffConsoleState, applyConsoleDelta };
  // Both, not either: bin/ requires this file, and web/app/api.js imports it for
  // its side effect — but the console's own unit tests import api.js under Node,
  // where this file loads as CommonJS and still has to reach the global.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KeepStateDelta = api;
})(globalThis);
