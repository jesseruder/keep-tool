'use strict';

const crypto = require('node:crypto');
const { quote } = require('./setup');

// 40k tokens × 4 chars, plus headroom for the batch preamble and per-card framing.
const REVIEWER_BASH_OUTPUT_CHARS = '200000';

// What makes a pane *the reviewer*, rather than an ordinary claude pane. A restart
// resumes with a bare `claude --resume <id>`, which inherits none of this, so the
// restart path in bin/serve.js rebuilds it from the .keep/reviewer marker instead of
// bringing the reviewer back as a nameless session with prompt suggestions on and a
// 30k Bash cap that truncates every five-card bundle.
const REVIEWER_SETTINGS = { promptSuggestionEnabled: false, preferredNotifChannel: 'notifications_disabled' };

function reviewerFlags(model) {
  return ['--model', String(model || 'fable'), '--settings', JSON.stringify(REVIEWER_SETTINGS)];
}

function reviewerEnv(root, family) {
  return {
    KEEP_DIR: root, KEEP_CONFIG: require('./config').configFile(), KEEP_REVIEWER: '1',
    KEEP_REVIEWER_NAME: String(family || 'fable'), KEEP_REVIEWER_MODEL: String(family || 'fable'),
    // Claude Code truncates a Bash result at ~30k chars by default; a five-card
    // review bundle is built to a 40k-token total budget and must land in one read.
    BASH_MAX_OUTPUT_LENGTH: process.env.KEEP_REVIEWER_BASH_OUTPUT || REVIEWER_BASH_OUTPUT_CHARS,
  };
}

async function launch(args, root, deps = {}) {
  const model = args[0] || process.env.KEEP_REVIEWER_MODEL || 'fable';
  const family = ['fable', 'opus', 'sonnet', 'haiku'].find((name) => model.includes(name)) || model;
  const sessionId = (deps.randomUUID || crypto.randomUUID)();
  const argv = ['claude', ...reviewerFlags(model), '--session-id', sessionId, ...args.slice(1)];
  const client = await (deps.connect || require('./hostclient').connect)();
  try {
    const { panes } = await client.request('list');
    if (panes.some((pane) => pane.alive && pane.meta?.reviewer)) throw new Error('a hosted reviewer is already running; use the console to open it');
    const { pane } = await client.request('spawn', {
      cmd: '/bin/zsh', args: ['-lic', `exec ${argv.map(quote).join(' ')}`],
      cwd: root, cols: 200, rows: 50,
      env: reviewerEnv(root, family),
      meta: { agent: 'claude', reviewer: true, sessionId, project: root, launchedAt: Date.now() },
    });
    if (!pane?.id) throw new Error('terminal host did not return a reviewer pane');
    return { pane: pane.id, sessionId, model };
  } finally { client.close(); }
}

module.exports = { launch, reviewerFlags, reviewerEnv, REVIEWER_BASH_OUTPUT_CHARS };
