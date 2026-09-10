'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configure = require('../app/app.config');
test('mobile identity stays outside source and environment overrides private config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-mobile-test-'));
  const keys = ['KEEP_MOBILE_CONFIG', 'KEEP_EXPO_OWNER', 'KEEP_EXPO_PROJECT_ID', 'KEEP_ANDROID_PACKAGE', 'KEEP_IOS_BUNDLE_IDENTIFIER'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    keys.forEach((key) => delete process.env[key]);
    process.env.KEEP_MOBILE_CONFIG = path.join(dir, 'mobile.json');
    const base = require('../app/app.json').expo;
    assert.equal(configure({ config: base }).owner, undefined);
    assert.equal(configure({ config: base }).android.package, 'dev.keeptool.mobile');
    fs.writeFileSync(process.env.KEEP_MOBILE_CONFIG, JSON.stringify({ owner: 'demo', androidPackage: 'test.demo.keep' }));
    assert.equal(configure({ config: base }).owner, 'demo');
    process.env.KEEP_ANDROID_PACKAGE = 'test.override.keep';
    assert.equal(configure({ config: base }).android.package, 'test.override.keep');
    assert.equal(configure({ config: base }).android.versionCode, base.android.versionCode);
  } finally {
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('mobile and console use the same scope implementation', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../app/src/scope-rules.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../web/app/shared/scope-rules.js'), 'utf8'));
});
