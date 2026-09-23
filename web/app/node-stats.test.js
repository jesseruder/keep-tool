import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nodeStatsVisible, nodeStatsWarnings, nodeStripText, nodeStripHTML, nodeStatsCardsHTML, nodeStatsRows,
  nodeStatsHealthRowsHTML,
} from './node-stats.js';

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const GB = 1024 ** 3;
const NOW = 1_000_000;

function sample(overrides = {}) {
  return {
    at: NOW - 5000, platform: 'linux', hostname: 'box-one', uptimeSec: 3 * 86400 + 4 * 3600,
    memTotal: 30 * GB, memAvailable: 17.6 * GB, swapTotal: 2 * GB, swapUsed: 0.5 * GB,
    cpuCount: 8, load1: 1.23, load5: 0.9, load15: 0.7, cpuBusyPct: 18.2,
    diskRoot: { total: 100 * GB, free: 71 * GB }, diskHome: { total: 100 * GB, free: 71 * GB },
    panes: 3, agentProcesses: { claude: 2, codex: 1, pi: 0 },
    hostVersion: { protocol: 1, transcript: 4, artifacts: 2, stats: 1, boot: 2 }, code: 'abc1234',
    clockOffsetMs: -420, sampledAt: NOW - 5000, stale: false, ...overrides,
  };
}

function fleet(main = sample(), aws1 = sample({ hostname: 'box-two' })) {
  return { nodes: [
    { name: 'main', daemon: true, capabilities: [], ok: true, ...(main ? { stats: main } : {}) },
    { name: 'aws1', daemon: false, capabilities: [], ok: true, ...(aws1 ? { stats: aws1 } : {}) },
  ] };
}

test('the strip reads name, memory in use, cpu, load and the fuller disk, daemon node first', () => {
  const data = fleet();
  assert.equal(nodeStripText(data.nodes[0]), 'main · mem 12.4/30 GB · cpu 18% · load 1.2 · disk 71% free');
  const html = nodeStripHTML(esc, data, NOW);
  assert.ok(html.indexOf('<b>main</b>') < html.indexOf('<b>aws1</b>'), 'the daemon node comes first');
  assert.doesNotMatch(html, /class="[^"]*\bwarn\b/, 'nothing is past a limit');
  assert.match(html, /title="main \(this daemon\)\n[^"]*mem: in use \/ total/);
  assert.match(html, /sampled 5s ago/);
});

test('each limit colours its own part and the entry, and a stale or silent node is muted', () => {
  const hot = sample({
    memAvailable: 4 * GB, cpuBusyPct: 91, load1: 9.5, diskRoot: { total: 100 * GB, free: 5 * GB },
  });
  assert.deepEqual(nodeStatsWarnings(hot), ['memory', 'cpu', 'load', 'disk']);
  assert.deepEqual(nodeStatsWarnings(sample()), []);
  assert.deepEqual(nodeStatsWarnings(sample({ diskHome: { total: 10 * GB, free: 0.5 * GB } })), ['disk'], 'home counts too');
  const data = fleet(sample(), hot);
  const html = nodeStripHTML(esc, data, NOW);
  const aws1 = html.slice(html.lastIndexOf('<span class="node-stat'));
  assert.match(aws1, /class="node-stat warn"/);
  for (const part of ['mem 26/30 GB', 'cpu 91%', 'load 9.5', 'disk 5% free']) {
    assert.ok(aws1.includes(`<span class="warn">${part}</span>`), part);
  }
  const quiet = fleet(sample(), sample({ stale: true, sampledAt: NOW - 90_000 }));
  quiet.nodes[1].ok = false;
  quiet.nodes[1].reason = 'timeout';
  const muted = nodeStripHTML(esc, quiet, NOW);
  assert.match(muted, /class="node-stat stale down"/);
  assert.match(muted, /aws1 — timeout/);
  assert.match(muted, /sampled 2m ago \(stale\)/);
});

test('a single node, or a fleet with no samples, shows no strip and no cards', () => {
  const one = { nodes: [{ name: 'main', daemon: true, capabilities: [], ok: true, stats: sample() }] };
  assert.equal(nodeStatsVisible(one), false);
  assert.equal(nodeStripHTML(esc, one, NOW), '');
  assert.equal(nodeStatsCardsHTML(esc, one, NOW), '');
  assert.equal(nodeStripHTML(esc, fleet(null, null), NOW), '');
  assert.equal(nodeStripHTML(esc, {}, NOW), '', 'an older daemon publishes no nodes at all');
  // The lone machine's numbers live behind the health details instead.
  assert.match(nodeStatsHealthRowsHTML(esc, one, NOW), /<dt>main<\/dt><dd class="" [^>]*>mem 12\.4\/30 GB · cpu 18% · load 1\.2 · disk 71% free<\/dd>/);
  assert.equal(nodeStatsHealthRowsHTML(esc, { nodes: [{ name: 'main', ok: true }] }, NOW), '');
  // Only the sampled nodes of a fleet get an entry.
  const half = nodeStripHTML(esc, fleet(sample(), null), NOW);
  assert.match(half, /<b>main<\/b>/);
  assert.doesNotMatch(half, /aws1/);
});

test('the Fleet card lists every field', () => {
  const rows = nodeStatsRows(sample({ diskHome: { total: 500 * GB, free: 250 * GB } }), NOW);
  assert.deepEqual(rows.map((row) => row.label), [
    'memory', 'swap', 'cpu', 'load', 'disk /', 'disk home', 'uptime', 'panes', 'agents', 'host', 'code', 'clock',
    'system', 'sampled',
  ]);
  const value = (label) => rows.find((row) => row.label === label).value;
  assert.equal(value('memory'), '12.4/30 GB · 17.6 GB available (59%)');
  assert.equal(value('swap'), '0.5/2 GB used');
  assert.equal(value('cpu'), '18% busy · 8 cores');
  assert.equal(value('load'), '1.23 / 0.90 / 0.70');
  assert.equal(value('disk /'), '71 GB free of 100 GB (71%)');
  assert.equal(value('disk home'), '250 GB free of 500 GB (50%)');
  assert.equal(value('uptime'), '3d 4h');
  assert.equal(value('panes'), '3 live');
  assert.equal(value('agents'), '2 claude · 1 codex · 0 pi');
  assert.equal(value('host'), 'protocol 1 · transcript 4 · artifacts 2 · stats 1 · boot 2');
  assert.equal(value('code'), 'abc1234');
  assert.equal(value('clock'), '−420 ms from the daemon');
  assert.equal(value('system'), 'box-one · linux');
  assert.equal(value('sampled'), 'sampled 5s ago');

  const html = nodeStatsCardsHTML(esc, fleet(), NOW);
  assert.equal((html.match(/<section class="node-card/g) || []).length, 2);
  assert.match(html, /<b>main<\/b><span class="node-card-tag">daemon<\/span>/);
  assert.match(html, /<dt>disk \/<\/dt><dd class="">71 GB free/);
  assert.doesNotMatch(html, /disk home/, 'home on the same volume as / is shown once');
  const warned = nodeStatsCardsHTML(esc, fleet(sample(), sample({ cpuBusyPct: 99, stale: true })), NOW);
  assert.match(warned, /<section class="node-card warn stale"/);
  assert.match(warned, /<dt>cpu<\/dt><dd class="warn">99% busy/);
  // A sample missing most fields lists only what it has.
  assert.deepEqual(nodeStatsRows({ memTotal: 8 * GB, sampledAt: NOW }, NOW).map((row) => row.label), ['memory', 'sampled']);
});
