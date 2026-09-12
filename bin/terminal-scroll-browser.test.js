const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('@playwright/test');

const root = path.join(__dirname, '..');
const fixtureHtml = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/xterm.css">
<style>
  body { margin: 0; }
  .host { width: 500px; height: 180px; margin: 8px; }
</style>
<div id="old" class="host"></div><div id="enhanced" class="host"></div>
<script src="/xterm.js"></script>
<script type="module">
  import { createTrackedPixelWheelHandler } from '/terminal-scroll.js';

  const fixtures = {};
  const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
  function open(name, enhanced) {
    const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 100 });
    terminal.open(document.getElementById(name));
    const output = [];
    terminal.onData(data => output.push(data));
    terminal.onBinary(data => output.push(data));
    const wheel = enhanced ? createTrackedPixelWheelHandler(terminal) : null;
    if (wheel) terminal.attachCustomWheelEventHandler(wheel.handle);
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown') wheel?.cancel();
      return true;
    });
    terminal.element.addEventListener('pointerdown', () => wheel?.cancel(), true);
    terminal.element.addEventListener('pointerup', () => wheel?.cancel(), true);
    for (const type of ['pointermove', 'mousemove', 'focus', 'blur']) {
      terminal.element.addEventListener(type, () => wheel?.cancel(), true);
    }
    fixtures[name] = { terminal, output, wheel };
  }

  open('old', false);
  open('enhanced', true);
  await Promise.all(Object.values(fixtures).map(({ terminal }) => write(terminal, '\\x1b[?1003h\\x1b[?1004h\\x1b[?1006h')));

  function point(terminal, col = 3, row = 4) {
    const screen = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
    return {
      clientX: screen.left + screen.width / terminal.cols * (col - 0.5),
      clientY: screen.top + screen.height / terminal.rows * (row - 0.5),
    };
  }
  function wheel(name, deltaY, deltaMode = WheelEvent.DOM_DELTA_PIXEL, modifiers = {}) {
    const fixture = fixtures[name];
    fixture.terminal.element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, view: window, deltaY, deltaMode,
      ...point(fixture.terminal), ...modifiers,
    }));
  }
  function pointer(name, type, options = {}) {
    const fixture = fixtures[name];
    fixture.terminal.element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, view: window, pointerId: 1,
      ...point(fixture.terminal), ...options,
    }));
  }
  function mouse(name, type, options = {}) {
    const fixture = fixtures[name];
    fixture.terminal.element.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      ...point(fixture.terminal), ...options,
    }));
  }
  window.fixture = {
    output: name => fixtures[name].output.slice(),
    clear(name) { fixtures[name].output.length = 0; fixtures[name].wheel?.cancel(); },
    async reset(name) {
      const fixture = fixtures[name];
      fixture.terminal.reset();
      fixture.output.length = 0;
      fixture.wheel?.cancel();
      await write(fixture.terminal, '\\x1b[?1003h\\x1b[?1004h\\x1b[?1006h');
    },
    metrics(name) {
      const { terminal } = fixtures[name];
      return {
        cellHeight: terminal.element.querySelector('.xterm-screen').getBoundingClientRect().height / terminal.rows,
        mode: terminal.modes.mouseTrackingMode,
      };
    },
    wheel, pointer, mouse,
    focus(name) { fixtures[name].terminal.focus(); },
    blur(name) { fixtures[name].terminal.blur(); },
    key(name, key) {
      const { terminal } = fixtures[name];
      terminal.textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: key === 'Enter' ? 'Enter' : 'Key' + key.toUpperCase(),
        keyCode: key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0),
        which: key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0),
        bubbles: true, cancelable: true,
      }));
    },
    async sgr(name, enabled) {
      await write(fixtures[name].terminal, enabled ? '\\x1b[?1006h' : '\\x1b[?1006l');
    },
    async tracking(name, enabled) {
      await write(fixtures[name].terminal, enabled ? '\\x1b[?1003h' : '\\x1b[?1003l');
    },
    async history(name) {
      await write(fixtures[name].terminal, Array.from({ length: 15 }, (_, index) => 'line ' + index + '\\r\\n').join(''));
    },
  };
</script>`;

function server() {
  return http.createServer((req, res) => {
    const files = {
      '/xterm.js': ['application/javascript', path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js')],
      '/xterm.css': ['text/css', path.join(root, 'node_modules/@xterm/xterm/css/xterm.css')],
      '/terminal-scroll.js': ['application/javascript', path.join(root, 'web/app/terminal-scroll.js')],
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

for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  browserTest(`real xterm preserves proportional tracked pixels in ${name}`, async () => {
    const instance = server();
    const url = await listen(instance);
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
      await page.goto(url);
      await page.waitForFunction(() => window.fixture?.metrics('enhanced').mode === 'any');
      await page.evaluate(() => { window.fixture.clear('old'); window.fixture.clear('enhanced'); });
      const cellHeight = await page.evaluate(() => window.fixture.metrics('enhanced').cellHeight);
      const delta = cellHeight * 2.4;
      assert.ok(delta < 50, `fixture delta must use xterm's likely-trackpad path, got ${delta}`);

      await page.evaluate(value => {
        for (let index = 0; index < 3; index++) {
          window.fixture.wheel('old', value);
          window.fixture.wheel('enhanced', value);
        }
      }, delta);
      await page.waitForTimeout(100);
      const pixel = await page.evaluate(() => ({
        old: window.fixture.output('old'), enhanced: window.fixture.output('enhanced'),
      }));
      assert.deepEqual(pixel.old, Array(2).fill('\x1b[<65;3;4M'));
      assert.deepEqual(pixel.enhanced, Array(7).fill('\x1b[<65;3;4M'));

      await page.evaluate(() => { window.fixture.clear('enhanced'); });
      await page.evaluate(value => {
        window.fixture.wheel('enhanced', value * 0.6);
        window.fixture.wheel('enhanced', value * 0.6);
        window.fixture.wheel('enhanced', value * -2.2);
      }, cellHeight);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.fixture.output('enhanced')), [
        '\x1b[<65;3;4M', '\x1b[<64;3;4M', '\x1b[<64;3;4M',
      ], 'fractional remainder and direction are preserved');

      for (const [deltaMode, amount] of [[1, 3], [2, 1]]) {
        await page.evaluate(() => Promise.all([window.fixture.reset('old'), window.fixture.reset('enhanced')]));
        await page.evaluate(({ amount, deltaMode }) => {
          window.fixture.wheel('old', amount, deltaMode);
          window.fixture.wheel('enhanced', amount, deltaMode);
        }, { amount, deltaMode });
        assert.deepEqual(
          await page.evaluate(() => window.fixture.output('enhanced')),
          await page.evaluate(() => window.fixture.output('old')),
          `deltaMode ${deltaMode} stays on xterm's native path`,
        );
      }

      for (const modifier of ['altKey', 'ctrlKey', 'shiftKey', 'metaKey']) {
        await page.evaluate(() => Promise.all([window.fixture.reset('old'), window.fixture.reset('enhanced')]));
        await page.evaluate(({ delta, modifier }) => {
          const mods = { [modifier]: true };
          window.fixture.wheel('old', delta, 0, mods);
          window.fixture.wheel('enhanced', delta, 0, mods);
        }, { delta, modifier });
        assert.deepEqual(
          await page.evaluate(() => window.fixture.output('enhanced')),
          await page.evaluate(() => window.fixture.output('old')),
          `${modifier} stays on xterm's native fast-scroll/selection path`,
        );
      }

      await page.evaluate(() => { window.fixture.clear('enhanced'); });
      await page.evaluate(value => {
        window.fixture.wheel('enhanced', value * 2.4);
        window.fixture.key('enhanced', 'Enter');
      }, cellHeight);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.fixture.output('enhanced')), ['\r'], 'keyboard input cancels delayed wheel reports');

      await page.evaluate(() => { window.fixture.clear('enhanced'); });
      await page.evaluate(value => {
        window.fixture.wheel('enhanced', value * 2.4);
        window.fixture.mouse('enhanced', 'mousemove', { buttons: 0 });
      }, cellHeight);
      await page.waitForTimeout(100);
      assert.deepEqual(
        await page.evaluate(() => window.fixture.output('enhanced')),
        ['\x1b[<35;3;4M'],
        'an immediate any-motion report cancels queued wheel reports instead of overtaking them',
      );

      await page.evaluate(() => { window.fixture.blur('enhanced'); window.fixture.clear('enhanced'); });
      await page.evaluate(value => {
        window.fixture.wheel('enhanced', value * 2.4);
        window.fixture.focus('enhanced');
      }, cellHeight);
      await page.waitForTimeout(100);
      assert.deepEqual(
        await page.evaluate(() => window.fixture.output('enhanced')),
        ['\x1b[I'],
        'an immediate focus report cancels queued wheel reports instead of overtaking them',
      );

      await page.evaluate(() => { window.fixture.clear('enhanced'); });
      await page.evaluate(value => {
        window.fixture.wheel('enhanced', value * 2.4);
        window.fixture.blur('enhanced');
      }, cellHeight);
      await page.waitForTimeout(100);
      assert.deepEqual(
        await page.evaluate(() => window.fixture.output('enhanced')),
        ['\x1b[O'],
        'an immediate blur report cancels queued wheel reports instead of overtaking them',
      );

      await page.evaluate(() => { window.fixture.clear('enhanced'); });
      await page.evaluate(value => {
        window.fixture.wheel('enhanced', value * 2.4);
        window.fixture.pointer('enhanced', 'pointerdown', { button: 0, buttons: 1 });
        window.fixture.mouse('enhanced', 'mousedown', { button: 0, buttons: 1 });
        window.fixture.mouse('enhanced', 'mousemove', { button: 0, buttons: 1 });
        window.fixture.pointer('enhanced', 'pointerup', { button: 0, buttons: 0 });
        window.fixture.mouse('enhanced', 'mouseup', { button: 0, buttons: 0 });
      }, cellHeight);
      await page.waitForTimeout(100);
      const pointer = await page.evaluate(() => window.fixture.output('enhanced'));
      assert.equal(pointer.some(data => data.includes('[<65;')), false, 'click cancels queued wheel reports');
      assert.ok(pointer.some(data => data.includes('[<0;3;4M')), `click coordinates survive: ${JSON.stringify(pointer)}`);
      assert.ok(pointer.some(data => data.includes('[<32;3;4M')), `drag coordinates survive: ${JSON.stringify(pointer)}`);

      await page.evaluate(async value => {
        window.fixture.clear('enhanced');
        await window.fixture.sgr('enhanced', false);
        window.fixture.wheel('enhanced', value * 1.2);
      }, cellHeight);
      await page.waitForTimeout(100);
      const legacy = await page.evaluate(() => window.fixture.output('enhanced'));
      assert.equal(legacy.length, 1);
      assert.ok(legacy[0].startsWith('\x1b[M'), `xterm retains legacy mouse encoding: ${JSON.stringify(legacy)}`);

      await page.evaluate(async value => {
        window.fixture.clear('enhanced');
        await window.fixture.history('enhanced');
        await window.fixture.tracking('enhanced', false);
        window.fixture.wheel('enhanced', value * 2);
      }, cellHeight);
      await page.waitForTimeout(100);
      assert.deepEqual(await page.evaluate(() => window.fixture.output('enhanced')), [], 'disabled mouse tracking emits no application reports');
    } finally {
      await browser.close();
      instance.closeAllConnections();
      await new Promise(resolve => instance.close(resolve));
    }
  });
}
