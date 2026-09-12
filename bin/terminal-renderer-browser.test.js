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
  const webgl = new WebglAddon.WebglAddon();
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
      await new Promise(requestAnimationFrame);
      await write(' after switch');
      await new Promise(requestAnimationFrame);
      return {
        before,
        after: terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)
          .translateToString(true),
        bufferLength: terminal.buffer.active.length,
        domText: terminal.element.querySelector('.xterm-rows')?.textContent || '',
        canvases: terminal.element.querySelectorAll('canvas').length,
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

browserTest('disposing the WebGL addon restores DOM rendering without replacing terminal state in WebKit', async () => {
  const instance = server();
  const url = await listen(instance);
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const result = await page.evaluate(() => window.fixture.prepare());
    assert.equal(result.before, 'before switch');
    assert.equal(result.after, 'before switch after switch');
    assert.ok(result.bufferLength > 5, 'scrollback survives the renderer switch');
    assert.match(result.domText, /before switch after switch/);
    assert.equal(result.canvases, 0, 'the disposed WebGL canvas is removed');
  } finally {
    await browser.close();
    await new Promise(resolve => instance.close(resolve));
  }
});
