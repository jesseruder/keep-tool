'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const escSource = html.match(/const esc = .*;/)?.[0];
const agoSource = html.match(/function ago\(ms\) \{[\s\S]*?\n\}/)?.[0];
const renderSource = html.match(/function renderDaemon\(\) \{[\s\S]*?\n\}\n\nfunction attentionItemKey/)?.[0]
  .replace(/\n\nfunction attentionItemKey$/, '');

function dashboard(health) {
  assert.ok(escSource && agoSource && renderSource, 'default dashboard health renderer should be extractable');
  const elements = { daemonBox: { style: {} }, daemonList: { innerHTML: '' } };
  const context = vm.createContext({ elements });
  vm.runInContext(`var state = ${JSON.stringify({ health })}; const $ = (id) => elements[id]; ${escSource}\n${agoSource}\n${renderSource}\nrenderDaemon();`, context);
  return elements;
}

test('default dashboard presents warnings without reviving recovered errors', () => {
  const elements = dashboard({
    daemon: { running: true, startedAt: Date.now() - 3600e3 },
    schedulers: [
      {
        name: 'digest', state: 'ok', displayState: 'ok', displayDetail: 'generated digest',
        detail: 'generated digest', lastError: 'recovered old failure', lastRunAt: Date.now() - 60e3, lastOkAt: Date.now() - 60e3,
      },
      {
        name: 'review', state: 'skipped', displayState: 'warning', consecutiveFailures: 1,
        displayDetail: '1 failed attempt · last failed attempt 13h ago · latest check skipped 1h ago · timeout <img id="health-injection">',
        lastRunAt: Date.now() - 3600e3,
      },
    ],
  });
  assert.equal(elements.daemonBox.style.display, '');
  assert.match(elements.daemonList.innerHTML, /daemon-row warning/);
  assert.match(elements.daemonList.innerHTML, /daemon-state">warning</);
  assert.match(elements.daemonList.innerHTML, /1 failed attempt · last failed attempt 13h ago · latest check skipped 1h ago/);
  assert.match(elements.daemonList.innerHTML, /generated digest/);
  assert.doesNotMatch(elements.daemonList.innerHTML, /recovered old failure/);
  assert.match(elements.daemonList.innerHTML, /&lt;img id=&quot;health-injection&quot;&gt;/);
  assert.doesNotMatch(elements.daemonList.innerHTML, /<img id="health-injection">/);
  assert.doesNotMatch(elements.daemonList.innerHTML, /all ok/);
});

test('default dashboard fallback preserves severe and disabled states', () => {
  const warning = dashboard({
    daemon: { running: true },
    schedulers: [{ name: 'runs', state: 'skipped', consecutiveFailures: 2, lastErrorAt: 20, lastOkAt: 10, lastError: 'still timing out' }],
  });
  assert.match(warning.daemonList.innerHTML, /daemon-row warning/);
  assert.match(warning.daemonList.innerHTML, /daemon-state">warning</);

  const severe = dashboard({
    daemon: { running: true },
    schedulers: [
      { name: 'delivery', state: 'failing', displayState: 'failing', displayDetail: '3 failed attempts · connection refused' },
      { name: 'review', state: 'silent', consecutiveFailures: 1, lastErrorAt: 20, lastOkAt: 10, lastError: 'stale timeout' },
      { name: 'slack', state: 'disabled', consecutiveFailures: 1, lastErrorAt: 20, lastError: 'old token error', detail: 'not configured' },
    ],
  });
  assert.match(severe.daemonList.innerHTML, /daemon-row bad/);
  assert.match(severe.daemonList.innerHTML, /daemon-state">failing/);
  assert.match(severe.daemonList.innerHTML, /3 failed attempts · connection refused/);
  assert.match(severe.daemonList.innerHTML, /daemon-state">silent/);
  assert.match(severe.daemonList.innerHTML, /daemon-state">disabled/);
  assert.match(severe.daemonList.innerHTML, /not configured/);
  assert.doesNotMatch(severe.daemonList.innerHTML, /old token error/);

  const offline = dashboard({ daemon: { running: false }, schedulers: [] });
  assert.match(offline.daemonList.innerHTML, /offline · last start never/);
  assert.doesNotMatch(offline.daemonList.innerHTML, /all ok/);
});

test('default dashboard collapses recovered-only health to all ok', () => {
  const elements = dashboard({
    daemon: { running: true, startedAt: Date.now() - 3600e3 },
    schedulers: [{ name: 'digest', state: 'ok', consecutiveFailures: 0, detail: 'generated', lastError: 'historical failure' }],
  });
  assert.match(elements.daemonList.innerHTML, /all ok/);
  assert.doesNotMatch(elements.daemonList.innerHTML, /historical failure/);
});
