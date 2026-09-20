// Keep's Pi adapter. Loaded by Pi from ~/.pi/agent/extensions/keep.ts.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.env.KEEP_DIR || join(homedir(), 'keep');
const directory = join(root, '.keep', 'pi-events');
const instance = randomUUID();
let activeId = '';

function hook(action: string, id: string, extra: Record<string, unknown> = {}) {
  try {
    const executable = process.env.KEEP_PI_KEEP_CLI;
    execFileSync(executable ? process.execPath : 'keep', executable
      ? [executable, 'hook', 'pi', action] : ['hook', 'pi', action], {
      input: JSON.stringify({ session_id: id, cwd: process.cwd(), instance, ...extra }),
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, KEEP_PI_SESSION_ID: id },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (error: any) {
    return String(error?.stderr || error?.message || 'Keep hook failed').trim();
  }
}

function phase(id: string, value: string, sessionFile?: string | null, leafId?: string | null) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${id}.json`);
  if (value !== 'start') {
    try {
      const prior = JSON.parse(readFileSync(file, 'utf8'));
      if (prior.instance !== instance) return false;
    } catch { return false; }
  }
  const temporary = `${file}.${process.pid}.${instance}.tmp`;
  writeFileSync(temporary, JSON.stringify({ id, phase: value, at: new Date().toISOString(),
    pid: process.pid, instance, sessionFile: sessionFile || null, leafId: leafId || null }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

export default function (pi: any) {
  pi.on('session_start', async (_event: any, ctx: any) => {
    const id = ctx.sessionManager.getSessionId();
    if (activeId && activeId !== id && process.env.KEEP_PANE) {
      // /new and /resume can replace the session without ending the Pi process.
      // Release the old pane owner before the new start hook tries to bind it.
      if (phase(activeId, 'shutdown')) hook('end', activeId);
    }
    activeId = id;
    // Pi may have been started from an interactive Claude or Codex session.
    // Its Keep commands must resolve to the Pi session, including in a raw Pi
    // process that did not pass through Keep's profile launcher.
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    process.env.KEEP_PI_SESSION_ID = id;
    if (!process.env.KEEP_PANE) return;
    const error = hook('start', id);
    if (error) {
      ctx.ui.notify(`Keep could not bind this Pi session: ${error.slice(0, 300)}`, 'error');
      return;
    }
    phase(id, 'start', ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId());
  });

  pi.on('session_shutdown', async (_event: any, ctx: any) => {
    const id = activeId;
    if (!id || !process.env.KEEP_PANE) return;
    if (phase(id, 'shutdown', ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId())) hook('end', id);
    activeId = '';
  });

  pi.on('agent_start', async (_event: any, ctx: any) => {
    if (process.env.KEEP_PI_OPENING_FILE) {
      try { unlinkSync(process.env.KEEP_PI_OPENING_FILE); } catch {}
      delete process.env.KEEP_PI_OPENING_FILE;
    }
    if (activeId && process.env.KEEP_PANE) phase(activeId, 'running', ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId());
  });
  pi.on('agent_settled', async (_event: any, ctx: any) => {
    if (activeId && process.env.KEEP_PANE) phase(activeId, 'settled', ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId());
  });
  pi.on('ui_prompt_start', async (_event: any, ctx: any) => {
    if (activeId && process.env.KEEP_PANE) phase(activeId, 'prompt', ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId());
  });
  pi.on('ui_prompt_end', async (_event: any, ctx: any) => {
    if (activeId && process.env.KEEP_PANE) phase(activeId, ctx.isIdle() ? 'settled' : 'running', ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId());
  });
  pi.on('session_tree', async (_event: any, ctx: any) => {
    if (!activeId || !process.env.KEEP_PANE) return;
    let current = 'settled';
    try { current = JSON.parse(readFileSync(join(directory, `${activeId}.json`), 'utf8')).phase || current; } catch {}
    phase(activeId, current, ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId());
  });

  // Keep's shared-step and self-repair guards apply to Pi's shell tool too.
  pi.on('tool_call', (event: any) => {
    if (event.toolName !== 'bash' || !activeId || !process.env.KEEP_PANE) return;
    const reason = hook('pre-tool', activeId, { tool_name: 'Bash', tool_input: { command: event.input?.command } });
    if (reason) return { block: true, reason };
  });
}
