'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { webkit } = require('@playwright/test');

const root = path.join(__dirname, '..');
const fixtureHtml = `<!doctype html>
<meta charset="utf-8">
<style>#terminal { width: 300px; height: 200px; overflow: auto; } #content { height: 1000px; }</style>
<div id="terminal"><div id="content"></div></div>
<script type="module">
  import { createTerminalProfiler } from '/terminal-profile.js';
  const wrapper = document.getElementById('terminal');
  const config = {
    runId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pane: 'pane', runtime: 'desktop',
    durationMs: 15000, expiresAt: Date.now() + 60000,
  };
  const env = {
    randomNonce: () => 'ffffffffffffffffffffffffffffffff',
    async fetch(_url, request = {}) {
      if (!request.method) return { ok: true, json: async () => ({ config }) };
      const body = JSON.parse(request.body);
      if (body.action === 'report') window.profileReport = body.report;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  window.profiler = createTerminalProfiler({
    pane: 'pane', runtime: 'desktop', wrapper, env,
    active: () => true, focused: () => true, terminal: {},
  });
</script>`;

function server() {
  return http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(fixtureHtml);
      return;
    }
    if (req.url === '/terminal-profile.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(fs.readFileSync(path.join(root, 'web/app/terminal-profile.js')));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

async function listen(instance) {
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${instance.address().port}`;
}

const browserTest = process.env.KEEP_BROWSER_TEST ? test : test.skip;

browserTest('WebKit brackets constructed wheel timestamps and captures trusted wheel propagation', async () => {
  const instance = server();
  const url = await listen(instance);
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.profiler?.state === 'armed');
    await page.mouse.move(100, 100);
    await page.mouse.wheel(0, 20);
    await page.waitForFunction(() => window.profiler?.state === 'recording');
    await page.mouse.wheel(0, 20);
    await page.evaluate(() => window.profiler.stop('hidden'));
    await page.waitForFunction(() => window.profileReport);
    const diagnostics = await page.evaluate(() => window.profileReport.clockDiagnostics);

    assert.deepEqual(diagnostics.wheelDocumentCaptureMissing, [[0]]);
    assert.equal(diagnostics.wheelDocumentToWrapper.length, 1);
    assert.equal(diagnostics.wheelDocumentToWrapper[0][0], 1);
    assert.ok(diagnostics.wheelDocumentToWrapper[0][1] >= 0);
    assert.deepEqual(diagnostics.wheelConstruct.map((tuple) => tuple[0]), [0, 1]);
    for (const [, timestampMinusBefore, timestampMinusAfter] of diagnostics.wheelConstruct) {
      assert.ok(timestampMinusBefore >= -2, `timestamp preceded construction bracket by ${timestampMinusBefore}ms`);
      assert.ok(timestampMinusAfter <= 2, `timestamp followed construction bracket by ${timestampMinusAfter}ms`);
      assert.ok(timestampMinusBefore >= timestampMinusAfter);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => instance.close(resolve));
  }
});
