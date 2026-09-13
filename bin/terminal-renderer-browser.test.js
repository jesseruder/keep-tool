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
<link rel="stylesheet" href="/xterm.css">
<style>#terminal { width: 500px; height: 180px; }</style>
<div id="terminal"></div>
<script src="/xterm.js"></script>
<script src="/addon-webgl.js"></script>
<script>
  const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100 });
  terminal.open(document.getElementById('terminal'));
  let webgl = new WebglAddon.WebglAddon();
  terminal.loadAddon(webgl);
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  window.fixture = {
    terminal,
    async prepare() {
      await write(Array.from({ length: 12 }, (_, i) => 'history ' + i + '\\r\\n').join(''));
      await write('before switch');
      const before = terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)
        .translateToString(true);
      webgl.dispose();
      terminal.refresh(0, terminal.rows - 1);
      await new Promise(requestAnimationFrame);
      await write(' after switch');
      await new Promise(requestAnimationFrame);
      const standardText = terminal.element.querySelector('.xterm-rows')?.textContent || '';
      webgl = new WebglAddon.WebglAddon();
      terminal.loadAddon(webgl);
      terminal.refresh(0, terminal.rows - 1);
      await write(' and back');
      await new Promise(requestAnimationFrame);
      const screen = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
      const canvases = [...terminal.element.querySelectorAll('canvas')].map(canvas => ({
        width: canvas.width, height: canvas.height,
        cssWidth: canvas.getBoundingClientRect().width,
        cssHeight: canvas.getBoundingClientRect().height,
      }));
      return {
        before,
        after: terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)
          .translateToString(true),
        bufferLength: terminal.buffer.active.length,
        standardText,
        screen: { width: screen.width, height: screen.height },
        canvases,
        devicePixelRatio,
      };
    },
  };
</script>`;

function server() {
  return http.createServer((req, res) => {
    const files = {
      '/xterm.js': ['application/javascript', path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js')],
      '/xterm.css': ['text/css', path.join(root, 'node_modules/@xterm/xterm/css/xterm.css')],
      '/addon-webgl.js': ['application/javascript', path.join(root, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js')],
    };
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(fixtureHtml);
      return;
    }
    const file = files[req.url];
    if (!file) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', file[0]);
    res.end(fs.readFileSync(file[1]));
  });
}

async function listen(instance) {
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${instance.address().port}`;
}

const browserTest = process.env.KEEP_BROWSER_TEST ? test : test.skip;

browserTest('WebKit switches renderers both ways without losing state or high-DPR geometry', async () => {
  const instance = server();
  const url = await listen(instance);
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(url);
    const result = await page.evaluate(() => window.fixture.prepare());
    assert.equal(result.before, 'before switch');
    assert.equal(result.after, 'before switch after switch and back');
    assert.ok(result.bufferLength > 5, 'scrollback survives the renderer switch');
    assert.match(result.standardText, /before switch after switch/);
    assert.equal(result.devicePixelRatio, 2);
    assert.ok(result.canvases.length > 0, 'switching back installs GPU canvases');
    assert.ok(result.canvases.every(canvas => canvas.width >= canvas.cssWidth * 1.9
      && canvas.height >= canvas.cssHeight * 1.9), 'GPU canvases cover their CSS geometry at high pixel density');
    assert.ok(result.canvases.some(canvas => canvas.cssWidth >= result.screen.width * 0.9
      && canvas.cssHeight >= result.screen.height * 0.9), 'a GPU canvas covers the terminal screen');
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => instance.close(resolve));
  }
});
