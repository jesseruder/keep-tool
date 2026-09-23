// Each machine's memory, CPU, load and disk, as the daemon publishes them on
// data.nodes[].stats (serve.js consoleNodes, bin/node-stats.js). Read only: a node
// without a sample has no `stats`, an older daemon publishes none at all, and every
// helper here then answers '' so the console renders what it rendered before.
//
// A single-node install gets no header strip and no Fleet cards; its one machine is
// shown behind the daemon health details instead.

const GB = 1024 ** 3;

// When a number is worth a second look. Memory: less than 15% of it available.
// CPU: more than 85% busy over the sample. Load: the 1-minute average above the
// core count. Disk: under 10% free on / or on home.
export const NODE_STATS_LIMITS = { memAvailablePct: 15, cpuBusyPct: 85, diskFreePct: 10 };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function statsNodes(data) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  return nodes.filter((node) => node && typeof node.name === 'string' && node.stats && typeof node.stats === 'object');
}

// The strip and the Fleet cards are a fleet's: two or more machines configured and
// at least one of them sampled.
export function nodeStatsVisible(data) {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  return nodes.length >= 2 && statsNodes(data).length > 0;
}

function gb(bytes) {
  const value = bytes / GB;
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function pct(part, whole) {
  return finite(part) && finite(whole) && whole > 0 ? (100 * part) / whole : null;
}

function disks(stats) {
  const list = [];
  const root = stats.diskRoot;
  const home = stats.diskHome;
  if (root && finite(root.total) && finite(root.free)) list.push({ label: '/', ...root });
  // Home on the same volume as / reads the same twice; it is shown once.
  if (home && finite(home.total) && finite(home.free)
    && !(root && home.total === root.total && home.free === root.free)) list.push({ label: 'home', ...home });
  return list;
}

function lowestDiskFreePct(stats) {
  const shares = disks(stats).map((disk) => pct(disk.free, disk.total)).filter((value) => value != null);
  return shares.length ? Math.min(...shares) : null;
}

// Which of the limits this sample is past, by name.
export function nodeStatsWarnings(stats) {
  if (!stats || typeof stats !== 'object') return [];
  const warnings = [];
  const available = pct(stats.memAvailable, stats.memTotal);
  if (available != null && available < NODE_STATS_LIMITS.memAvailablePct) warnings.push('memory');
  if (finite(stats.cpuBusyPct) && stats.cpuBusyPct > NODE_STATS_LIMITS.cpuBusyPct) warnings.push('cpu');
  if (finite(stats.load1) && finite(stats.cpuCount) && stats.cpuCount > 0 && stats.load1 > stats.cpuCount) warnings.push('load');
  const disk = lowestDiskFreePct(stats);
  if (disk != null && disk < NODE_STATS_LIMITS.diskFreePct) warnings.push('disk');
  return warnings;
}

function memText(stats) {
  if (!finite(stats.memTotal)) return '';
  const used = finite(stats.memAvailable) ? Math.max(0, stats.memTotal - stats.memAvailable) : null;
  return used == null ? `mem ${gb(stats.memTotal)} GB` : `mem ${gb(used)}/${gb(stats.memTotal)} GB`;
}

// The compact parts of one node's strip entry, each tagged with the limit it is
// judged by so a part past its limit can be coloured on its own.
function stripParts(stats) {
  const parts = [];
  const mem = memText(stats);
  if (mem) parts.push({ key: 'memory', text: mem });
  if (finite(stats.cpuBusyPct)) parts.push({ key: 'cpu', text: `cpu ${Math.round(stats.cpuBusyPct)}%` });
  if (finite(stats.load1)) parts.push({ key: 'load', text: `load ${Math.round(stats.load1 * 10) / 10}` });
  const disk = lowestDiskFreePct(stats);
  if (disk != null) parts.push({ key: 'disk', text: `disk ${Math.round(disk)}% free` });
  return parts;
}

export function nodeStripText(node) {
  return [node.name, ...stripParts(node.stats || {}).map((part) => part.text)].join(' · ');
}

function ageText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function uptimeText(seconds) {
  if (!finite(seconds)) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function sampledText(stats, now) {
  return finite(stats.sampledAt) ? `sampled ${ageText(now - stats.sampledAt)} ago${stats.stale ? ' (stale)' : ''}` : '';
}

// What the strip's numbers are, for its tooltip.
export function nodeStripTitle(node, now = Date.now()) {
  const stats = node.stats || {};
  const cores = finite(stats.cpuCount) ? stats.cpuCount : '?';
  return [
    `${node.name}${node.daemon ? ' (this daemon)' : ''}${node.ok === false ? ` — ${node.reason || 'unreachable'}` : ''}`,
    'mem: in use / total (in use = total minus what can be handed out without swapping)',
    'cpu: busy share of every core over a quarter-second sample',
    `load: 1-minute load average (above ${cores} cores is a queue)`,
    'disk: free share of the fuller of / and home',
    `warns below ${NODE_STATS_LIMITS.memAvailablePct}% memory available, above ${NODE_STATS_LIMITS.cpuBusyPct}% cpu, load above cores, below ${NODE_STATS_LIMITS.diskFreePct}% disk free`,
    sampledText(stats, now),
  ].filter(Boolean).join('\n');
}

function entryClass(node, extra = '') {
  const warnings = nodeStatsWarnings(node.stats);
  return [extra, warnings.length ? 'warn' : '', node.stats?.stale ? 'stale' : '', node.ok === false ? 'down' : '']
    .filter(Boolean).join(' ');
}

export function nodeStripEntryHTML(esc, node, now = Date.now()) {
  const warnings = new Set(nodeStatsWarnings(node.stats));
  const parts = stripParts(node.stats || {}).map((part) =>
    `<span class="${warnings.has(part.key) ? 'warn' : ''}">${esc(part.text)}</span>`).join('<i>·</i>');
  return `<span class="${entryClass(node, 'node-stat')}" title="${esc(nodeStripTitle(node, now))}" tabindex="0"><b>${esc(node.name)}</b><i>·</i>${parts}</span>`;
}

// The header strip: one entry per sampled node, the daemon's first (the order the
// daemon publishes). Empty unless this is a fleet.
export function nodeStripHTML(esc, data, now = Date.now()) {
  if (!nodeStatsVisible(data)) return '';
  return statsNodes(data).map((node) => nodeStripEntryHTML(esc, node, now)).join('');
}

function bytesPair(free, total) {
  const share = pct(free, total);
  return `${gb(free)} GB free of ${gb(total)} GB${share == null ? '' : ` (${Math.round(share)}%)`}`;
}

function offsetText(ms) {
  if (!finite(ms)) return '';
  const sign = ms < 0 ? '−' : '+';
  const abs = Math.abs(ms);
  return abs < 1000 ? `${sign}${Math.round(abs)} ms` : `${sign}${Math.round(abs / 100) / 10} s`;
}

// Every field of one node's sample, as label/value rows, each flagged when it is
// the one past a limit.
export function nodeStatsRows(stats, now = Date.now()) {
  const rows = [];
  const warnings = new Set(nodeStatsWarnings(stats));
  const add = (label, value, warn = false) => { if (value) rows.push({ label, value, warn }); };
  if (finite(stats.memTotal)) {
    const available = pct(stats.memAvailable, stats.memTotal);
    add('memory', `${memText(stats).replace(/^mem /, '')}${available == null ? '' : ` · ${gb(stats.memAvailable)} GB available (${Math.round(available)}%)`}`,
      warnings.has('memory'));
  }
  if (finite(stats.swapTotal)) add('swap', `${finite(stats.swapUsed) ? gb(stats.swapUsed) : '?'}/${gb(stats.swapTotal)} GB used`);
  if (finite(stats.cpuBusyPct) || finite(stats.cpuCount)) {
    add('cpu', [finite(stats.cpuBusyPct) ? `${Math.round(stats.cpuBusyPct)}% busy` : '',
      finite(stats.cpuCount) ? `${stats.cpuCount} cores` : ''].filter(Boolean).join(' · '), warnings.has('cpu'));
  }
  if (finite(stats.load1)) {
    add('load', [stats.load1, stats.load5, stats.load15].filter(finite).map((value) => value.toFixed(2)).join(' / '),
      warnings.has('load'));
  }
  for (const disk of disks(stats)) {
    const share = pct(disk.free, disk.total);
    add(`disk ${disk.label}`, bytesPair(disk.free, disk.total), share != null && share < NODE_STATS_LIMITS.diskFreePct);
  }
  add('uptime', uptimeText(stats.uptimeSec));
  if (Number.isInteger(stats.panes)) add('panes', `${stats.panes} live`);
  if (stats.agentProcesses && typeof stats.agentProcesses === 'object') {
    const agents = stats.agentProcesses;
    add('agents', ['claude', 'codex', 'pi'].map((kind) => `${Number(agents[kind]) || 0} ${kind}`).join(' · '));
  }
  if (stats.hostVersion && typeof stats.hostVersion === 'object') {
    add('host', Object.entries(stats.hostVersion).filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => `${key} ${value}`).join(' · '));
  }
  add('code', typeof stats.code === 'string' ? stats.code : '');
  add('clock', finite(stats.clockOffsetMs) ? `${offsetText(stats.clockOffsetMs)} from the daemon` : '');
  add('system', [stats.hostname, stats.platform].filter((value) => typeof value === 'string' && value).join(' · '));
  add('sampled', sampledText(stats, now));
  return rows;
}

export function nodeStatsCardHTML(esc, node, now = Date.now()) {
  const stats = node.stats || {};
  const state = node.ok === false ? `<span class="bad">${esc(node.reason || 'unreachable')}</span>` : '';
  const rows = nodeStatsRows(stats, now).map((row) =>
    `<dt>${esc(row.label)}</dt><dd class="${row.warn ? 'warn' : ''}">${esc(row.value)}</dd>`).join('');
  return `<section class="${entryClass(node, 'node-card')}" title="${esc(nodeStripTitle(node, now))}"><header><b>${esc(node.name)}</b>${node.daemon ? '<span class="node-card-tag">daemon</span>' : ''}${state}</header><dl>${rows}</dl></section>`;
}

// The Fleet tab's cards: every sampled node of a fleet. Empty for one machine.
export function nodeStatsCardsHTML(esc, data, now = Date.now()) {
  if (!nodeStatsVisible(data)) return '';
  return statsNodes(data).map((node) => nodeStatsCardHTML(esc, node, now)).join('');
}

// The health details' rows: every sampled node, a single-node install's one included,
// as its strip line.
export function nodeStatsHealthRowsHTML(esc, data, now = Date.now()) {
  return statsNodes(data).map((node) => {
    const text = stripParts(node.stats).map((part) => part.text).join(' · ');
    const warn = nodeStatsWarnings(node.stats).length ? 'warning' : '';
    return `<dt>${esc(node.name)}</dt><dd class="${warn}" title="${esc(nodeStripTitle(node, now))}">${esc(text || 'no numbers')}${node.stats.stale ? ` · ${esc(sampledText(node.stats, now))}` : ''}</dd>`;
  }).join('');
}
