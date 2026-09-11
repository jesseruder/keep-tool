// Keep the viewed session selected across activity-group transitions. A missing
// row is not a user request to open whatever now occupies its old index.
export function retainSelection(items, current, selectedKey, keyOf, sectionKey, rebuild) {
  if (!current || selectedKey !== sectionKey(current)
      || items.some((item) => keyOf(item) === keyOf(current))) return [];
  const fresh = rebuild(current);
  return fresh ? [fresh] : [];
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

// Order by creation time, retaining first-seen order for equal or unknown ages.
// Activity and running/waiting transitions never affect a session's slot.
export function stableSessionOrder(items, ranks, knownIds, createdAt = () => 0) {
  for (const id of ranks.keys()) if (!knownIds.has(id)) ranks.delete(id);
  let next = Math.max(-1, ...ranks.values()) + 1;
  for (const item of items) if (!ranks.has(item.id)) ranks.set(item.id, next++);
  return [...items].sort((a, b) => createdAt(a) - createdAt(b)
    || ranks.get(a.id) - ranks.get(b.id));
}
