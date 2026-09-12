'use strict';
// Opt-in isolated browser QA; never connects to the real daemon or terminal host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('@playwright/test');
const { dashboardDetail, lightweightState } = require('./dashboard-state');

test('isolated browser: legacy dashboard task details load on open and reject stale responses', { skip: process.env.KEEP_BROWSER_TEST !== '1', timeout: 30000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const task = (id, title, body) => ({
    id, body, lastLog: `Latest ${id}`, modelUsage: { total: id.length }, overdue: false,
    fm: { title, status: 'active', kind: 'task', project: '/tmp/dashboard-fixture', tags: ['work'], sessions: [], updated: '2026-09-07T12:00:00Z', check: `verify ${id}` },
  });
  const first = task('first', 'First card', 'First full history');
  const second = task('second', 'Second card', 'Second full history v1');
  const broken = task('broken', 'Broken card', 'Recovered full history');
  const state = {
    generatedAt: 1, tasks: [first, second, broken], sessions: [], attention: [], stalled: [], unblocked: [], alerts: [],
    notifications: [], landed: {}, runs: [], usage: {}, reviewQueue: { items: [], counts: {} }, scopes: { names: ['work'] },
  };
  const detailGets = [];
  let failBroken = true;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return;
    }
    if (url.pathname === '/api/state') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(lightweightState(state))); return;
    }
    if (url.pathname === '/api/dashboard-detail') {
      const id = url.searchParams.get('id');
      detailGets.push(id);
      if (id === 'broken' && failBroken) {
        failBroken = false; res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture unavailable' })); return;
      }
      const send = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(dashboardDetail(state, 'task', id))); };
      if (id === 'first') setTimeout(send, 150); else send();
      return;
    }
    if (url.pathname === '/api/tasksummary') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tooShort: true })); return;
    }
    const file = path.resolve(root, url.pathname === '/' ? 'web/index.html' : `web${url.pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('[data-id="first"]').waitFor();
    assert.deepEqual(detailGets, [], 'initial board render uses summaries only');

    await page.locator('[data-id="first"]').click();
    await page.getByText('Loading task details…').waitFor();
    await page.evaluate(() => openTask('second'));
    await page.getByText('Second full history v1').waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#detail h3').textContent(), 'Second card', 'the delayed first response cannot replace the second card');
    assert.equal(await page.locator('#detail').getAttribute('data-detail-version'), lightweightState(state).tasks.find((row) => row.id === 'second')._detailVersion);

    await page.evaluate(() => openTask('broken'));
    await page.getByText(/Could not load task details: fixture unavailable/).waitFor();
    await page.locator('#retryTaskDetail').click();
    await page.getByText('Recovered full history').waitFor();
    assert.equal(detailGets.filter((id) => id === 'broken').length, 2, 'retry starts one new detail request');

    await page.evaluate(() => openTask('second'));
    await page.getByText('Second full history v1').waitFor();
    second.body = 'Second full history v2';
    second.fm.updated = '2026-09-07T12:01:00Z';
    state.generatedAt += 1;
    await page.evaluate(() => refresh());
    await page.getByText('Second full history v2').waitFor();
    assert.equal(await page.locator('#detail details.recipe pre').textContent(), 'verify second', 'check recipe is rehydrated with refreshed detail');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
