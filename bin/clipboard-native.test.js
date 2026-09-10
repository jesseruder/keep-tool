const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('macOS clipboard detects image formats without treating text/files as images', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-clipboard-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'clipboard-test');
  const root = path.resolve(__dirname, '../desktop/src-tauri');
  execFileSync('clang', ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'Foundation', path.join(root, 'src/clipboard.m'), path.join(root, 'tests/clipboard.m'), '-o', binary]);
  execFileSync(binary);
});
