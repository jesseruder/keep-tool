'use strict';
// Run the existing Tauri shell against a disposable backend, with a separate
// application identity/storage. Never load the production launcher's port 7777.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFixture } = require('./fixture.cjs');
(async () => {
  const fixture = await createFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ui-shell-'));
  const configPath = path.join(dir, 'tauri.qa.json');
  const base = require('../../desktop/src-tauri/tauri.conf.json');
  fs.writeFileSync(configPath, JSON.stringify({
    productName: 'Keep UI Sandbox', identifier: 'games.castle.keep.ui-sandbox',
    app: { windows: [{ ...base.app.windows[0], title: 'Keep UI Sandbox — fake sessions', url: `${fixture.url}/app` }] },
  }));
  console.log(`Native sandbox: ${fixture.url}/app\nControls: ${fixture.url}/__fixture`);
  const child = spawn(path.resolve(__dirname, '../../desktop/node_modules/.bin/tauri'), ['dev', '--no-watch', '--config', configPath], {
    cwd: path.resolve(__dirname, '../../desktop'), stdio: 'inherit', detached: true,
  });
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  };
  let cleaned = false;
  async function cleanup(code) {
    if (cleaned) return;
    cleaned = true;
    // Tauri CLI can exit before its app. Its dedicated group owns both.
    signalGroup('SIGTERM');
    await fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  }
  child.once('error', error => { console.error(error.message); cleanup(1); });
  child.once('exit', code => cleanup(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => signalGroup(signal));
})().catch(error => { console.error(error); process.exit(1); });
