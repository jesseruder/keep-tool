'use strict';

const crypto = require('node:crypto');
const { quote } = require('./setup');

async function launch(args, root, deps = {}) {
  const model = args[0] || process.env.KEEP_REVIEWER_MODEL || 'fable';
  const family = ['fable', 'opus', 'sonnet', 'haiku'].find((name) => model.includes(name)) || model;
  const sessionId = (deps.randomUUID || crypto.randomUUID)();
  const argv = ['claude', '--model', model, '--session-id', sessionId,
    '--settings', JSON.stringify({ promptSuggestionEnabled: false, preferredNotifChannel: 'notifications_disabled' }), ...args.slice(1)];
  const client = await (deps.connect || require('./hostclient').connect)();
  try {
    const { panes } = await client.request('list');
    if (panes.some((pane) => pane.alive && pane.meta?.reviewer)) throw new Error('a hosted reviewer is already running; use the console to open it');
    const { pane } = await client.request('spawn', {
      cmd: '/bin/zsh', args: ['-lic', `exec ${argv.map(quote).join(' ')}`],
      cwd: root, cols: 200, rows: 50,
      env: { KEEP_DIR: root, KEEP_CONFIG: require('./config').configFile(), KEEP_REVIEWER: '1', KEEP_REVIEWER_NAME: family, KEEP_REVIEWER_MODEL: family },
      meta: { agent: 'claude', reviewer: true, sessionId, project: root, launchedAt: Date.now() },
    });
    if (!pane?.id) throw new Error('terminal host did not return a reviewer pane');
    return { pane: pane.id, sessionId, model };
  } finally { client.close(); }
}

module.exports = { launch };
