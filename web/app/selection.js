// Keep the viewed session selected across activity-group transitions. A missing
// row is not a user request to open whatever now occupies its old index.
export function retainSelection(items, current, selectedKey, keyOf, sectionKey, rebuild) {
  if (!current || selectedKey !== sectionKey(current)
      || items.some((item) => keyOf(item) === keyOf(current))) return [];
  // A rebuilt row may be keyed differently than the one that went missing: a pane
  // stand-in hands over to the session the pane has since recorded. Never append it
  // beside a row already listed under that key.
  const fresh = rebuild(current);
  return fresh && !items.some((item) => keyOf(item) === keyOf(fresh)) ? [fresh] : [];
}
export function selectionIndex(items, selectedKey, current, fallback, keyOf, sectionKey) {
  let index = selectedKey ? items.findIndex((item) => sectionKey(item) === selectedKey) : -1;
  if (index < 0 && current) index = items.findIndex((item) => keyOf(item) === keyOf(current));
  // Launching an agent turns a shell row's key from its pane id into a session
  // id. Keep viewing that same terminal instead of the old numeric neighbour.
  if (index < 0 && current?.pane) {
    index = items.findIndex((item) => item.pane === current.pane && item.kind === current.kind);
    if (index < 0) index = items.findIndex((item) => item.pane === current.pane);
  }
  return index >= 0 ? index : Math.max(0, Math.min(fallback, items.length - 1));
}

// Order newest-created first with deterministic ties, or retain first-seen order.
// Activity and running/waiting transitions never affect a session's slot.
export function stableSessionOrder(items, ranks, knownIds, createdAt = null) {
  for (const id of ranks.keys()) if (!knownIds.has(id)) ranks.delete(id);
  let next = Math.max(-1, ...ranks.values()) + 1;
  for (const item of items) if (!ranks.has(item.id)) ranks.set(item.id, next++);
  return [...items].sort((a, b) => createdAt
    ? createdAt(b) - createdAt(a) || a.id.localeCompare(b.id)
    : ranks.get(a.id) - ranks.get(b.id));
}

// Waiting on you keeps each row where it first appeared. A row's `since` is its
// session's last transcript message, and Keep writes into a session while it waits
// (deliveries, nudges), so sorting on the live value swapped rows that did nothing.
// An anchor lives while its row is listed; a row that leaves and comes back is a
// new request and takes its new time. Priority still decides the group.
export function stableAttentionOrder(items, anchors, keyOf) {
  const time = (value) => (typeof value === 'number' ? value : Date.parse(value) || 0);
  const keys = new Set(items.map(keyOf));
  for (const key of anchors.keys()) if (!keys.has(key)) anchors.delete(key);
  for (const item of items) if (!anchors.has(keyOf(item))) anchors.set(keyOf(item), time(item.since));
  return [...items].sort((a, b) => Number(a.pri || 0) - Number(b.pri || 0)
    || anchors.get(keyOf(a)) - anchors.get(keyOf(b))
    || String(keyOf(a)).localeCompare(String(keyOf(b))));
}
