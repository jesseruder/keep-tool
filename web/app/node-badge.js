// Which machine a session runs on, named only when it is not the daemon's own.
//
// A session in the publication carries `node` only when its pane is on another
// machine (serve.js addHostSessionState). A pane is different: on a fleet of more
// than one node every pane carries `node`, the daemon's own included, so the pane's
// id decides. A pane on another machine is published as `<id>@<node>`; a pane here
// keeps its bare id. A single-node install publishes neither, so every helper here
// answers '' and every caller renders exactly what it rendered before.

export function remotePaneNode(pane) {
  const node = pane && typeof pane.node === 'string' ? pane.node : '';
  return node && typeof pane.id === 'string' && pane.id.endsWith(`@${node}`) ? node : '';
}

export function remoteNode({ item, session, pane } = {}) {
  for (const source of [item, session]) {
    if (source && typeof source.node === 'string' && source.node) return source.node;
  }
  return remotePaneNode(pane);
}

// A small muted chip beside the provider icon or the account label. Nothing at all
// on the daemon node.
export function nodeBadgeHTML(esc, node) {
  if (!node) return '';
  return `<span class="node-badge" title="runs on node ${esc(node)}">${esc(node)}</span>`;
}
