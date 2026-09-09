'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { headlessSettingsArgs } = require('./summarize.js');

function withDisabledPlugins(value, fn) {
  const previous = process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
  if (value === undefined) delete process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
  else process.env.KEEP_HEADLESS_DISABLED_PLUGINS = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
    else process.env.KEEP_HEADLESS_DISABLED_PLUGINS = previous;
  }
}

test('headless settings disable the Codex plugin by default', () => {
  withDisabledPlugins(undefined, () => {
    assert.deepEqual(headlessSettingsArgs(), [
      '--settings',
      JSON.stringify({ enabledPlugins: { 'codex@openai-codex': false } }),
    ]);
  });
});

test('headless settings disable a custom comma-separated plugin list', () => {
  withDisabledPlugins('first@example, second@example', () => {
    assert.deepEqual(JSON.parse(headlessSettingsArgs()[1]), {
      enabledPlugins: {
        'first@example': false,
        'second@example': false,
      },
    });
  });
});

test('an empty disabled plugin setting opts out', () => {
  withDisabledPlugins('', () => {
    assert.deepEqual(headlessSettingsArgs(), []);
  });
});
