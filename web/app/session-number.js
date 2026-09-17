// The short console number a session is listed under. The daemon allocates it
// once per session (bin/session-numbers.js) and ships it on every session row as
// `num`; the console shows it so Owner can type `#12` instead of a title or uuid.

export function numLabel(num) {
  return Number.isInteger(num) && num >= 1 ? `#${num}` : '';
}

// A muted badge that reads like the faint ids it replaces, with the full session
// id kept in the tooltip for copying.
export function numBadgeHTML(esc, num, id) {
  const label = numLabel(num);
  if (!label) return '';
  return `<span class="num-id"${id ? ` title="${esc(id)}"` : ''}>${esc(label)}</span>`;
}

// Both `#12` and `12` should find the session in a filter box.
export function numHaystack(num) {
  const label = numLabel(num);
  return label ? [label, String(num)] : [];
}
