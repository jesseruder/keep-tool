'use strict';

const crypto = require('node:crypto');

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

// `bashOutput` is the limit this reviewer was actually launched with, recorded in the
// pane meta: a restart must not silently swap in the daemon's own environment.
function reviewerBashOutput(bashOutput) {
  return String(bashOutput || process.env.KEEP_REVIEWER_BASH_OUTPUT || REVIEWER_BASH_OUTPUT_CHARS);
}

function reviewerEnv(root, family, bashOutput) {
  return {
    KEEP_DIR: root, KEEP_CONFIG: require('./config').configFile(), KEEP_REVIEWER: '1',
    KEEP_REVIEWER_NAME: String(family || 'fable'), KEEP_REVIEWER_MODEL: String(family || 'fable'),
    // Claude Code truncates a Bash result at ~30k chars by default; a five-card
    // review bundle is built to a 40k-token total budget and must land in one read.
    BASH_MAX_OUTPUT_LENGTH: reviewerBashOutput(bashOutput),
  };
}

async function launch(args, root, deps = {}) {
  const model = args[0] || process.env.KEEP_REVIEWER_MODEL || 'fable';
  const family = ['fable', 'opus', 'sonnet', 'haiku'].find((name) => model.includes(name)) || model;
  const sessionId = (deps.randomUUID || crypto.randomUUID)();
  const argv = ['claude', ...reviewerFlags(model), '--session-id', sessionId, ...args.slice(1)];
  const accountApi = deps.accounts || require('./accounts.js');
  const account = deps.account || accountApi.automationFor('claude', 'reviewer');
  const profileCommand = (deps.profileCommand || require('./agent-launcher').profileCommand)(argv, account);
  const client = await (deps.connect || require('./hostclient').connect)();
  try {
    const { panes } = await client.request('list');
    if (panes.some((pane) => pane.alive && pane.meta?.reviewer)) throw new Error('a hosted reviewer is already running; use the console to open it');
    const { pane } = await client.request('spawn', {
      cmd: '/bin/zsh', args: ['-lic', `exec ${profileCommand}`],
      cwd: root, cols: 200, rows: 50,
      env: reviewerEnv(root, family),
      // The marker keeps only the family (the budget governor matches on it), so the
      // exact model and Bash limit this pane was launched with are recorded here —
      // a restart resumes from them rather than unfreezing a deliberately pinned id.
      meta: { agent: 'claude', reviewer: true, sessionId, project: root, launchedAt: Date.now(),
        accountId: account.id, accountLabel: account.label,
        reviewerModel: model, reviewerBashOutput: reviewerBashOutput() },
    });
    if (!pane?.id) throw new Error('terminal host did not return a reviewer pane');
    return { pane: pane.id, sessionId, model, accountId: account.id };
  } finally { client.close(); }
}

module.exports = { launch, reviewerFlags, reviewerEnv, reviewerBashOutput, REVIEWER_BASH_OUTPUT_CHARS };
