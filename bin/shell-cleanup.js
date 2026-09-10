'use strict';
const { IDLE_MS } = require('./session-cleanup');

function refusal(pane, state, now = Date.now()) {
  if (!pane?.alive || pane.cmd !== '/bin/zsh' || JSON.stringify(pane.args) !== '["-l"]') return 'Not a managed interactive shell';
  if (state.pinned.has(pane.id) || pane.attached !== 0) return 'Pinned or attached pane is protected';
  if (!Number.isFinite(Date.parse(pane.lastOutputAt)) || now - Date.parse(pane.lastOutputAt) < IDLE_MS) return 'Recent or unknown shell activity';
  const session = state.sessions.find(s => s.pane === pane.id || s.id === pane.meta?.sessionId);
  if (session?.reviewer) return 'Fleet reviewer is protected';
  if (session && session.state !== 'exited') return 'Agent session has not exited';
  if (!session && (pane.meta?.agent !== 'shell' || pane.meta?.sessionId)) return 'Unknown agent state';
  return null;
}

function emptyPrompt(screen) {
  const lines = String(screen?.text || '').split('\n');
  const last = lines.findLastIndex(line => line.trim());
  const line = lines[last] || '';
  return /^\s*(?:\([^)]*\) )?(?:~|\/)[^>\n]* >\s*$/.test(line)
    && Number.isInteger(screen?.cursor?.x) && screen.cursor.y === last
    && screen.cursor.x >= line.trimEnd().length && screen.cursor.x <= line.trimEnd().length + 1;
}

// Recheck after reading the prompt. EOF never executes text or signals a process.
async function close(pane, { snapshot, processes, screen, eof, now = Date.now }) {
  async function verify() {
    const state = await snapshot();
    const current = state.panes.find(p => p.id === pane.id);
    const reason = refusal(current, state, now());
    if (reason) throw Error(reason);
    if (current.pid !== pane.pid || current.createdAt !== pane.createdAt
        || current.lastOutputAt !== pane.lastOutputAt || current.meta?.sessionId !== pane.meta?.sessionId
        || current.meta?.agent !== pane.meta?.agent) throw Error('Shell identity or activity changed');
    const rows = await processes();
    const shell = rows.find(p => p.pid === pane.pid);
    if (!shell || !/^(?:\/bin\/zsh|-zsh)(?:\s+-l)?$/.test(shell.args)
        || rows.some(p => p.ppid === pane.pid)) throw Error('Shell has child processes or its identity is unverified');
    if (!emptyPrompt(await screen(pane))) throw Error('Shell prompt is not verified empty');
  }
  await verify();
  await verify();
  await eof(pane);
}
module.exports = { refusal, emptyPrompt, close };
