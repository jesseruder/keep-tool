export const TERMINAL_RENDERERS = ['dom', 'webgl'];
export const MAX_RENDERER_TRIAL_TTL = 24 * 60 * 60 * 1000;

export function terminalRendererKey(pane) {
  return `keep.console.terminalRenderer:${pane}`;
}

export function getTerminalRendererPreference(pane, storage) {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(terminalRendererKey(pane));
    return TERMINAL_RENDERERS.includes(value) ? value : null;
  } catch { return null; }
}

export function setTerminalRendererPreference(pane, renderer, storage) {
  if (!TERMINAL_RENDERERS.includes(renderer)) return false;
  try { (storage ?? globalThis.localStorage)?.setItem(terminalRendererKey(pane), renderer); }
  catch { return false; }
  return true;
}

export function rendererTrialExpiry(next, options = {}) {
  const trial = next?.meta?.terminalRendererTrial;
  const now = options.now ?? Date.now();
  const desktop = options.desktop ?? Boolean(globalThis.window?.__TAURI__);
  if (!desktop || trial?.mode !== 'dom' || trial.runtime !== 'desktop'
      || typeof next.meta?.sessionId !== 'string' || !next.meta.sessionId
      || trial.sessionId !== next.meta.sessionId || !Number.isFinite(trial.expiresAt)
      || trial.expiresAt <= now || trial.expiresAt - now > MAX_RENDERER_TRIAL_TTL) return null;
  return trial.expiresAt;
}

export function effectiveTerminalRenderer(pane, paneState) {
  return getTerminalRendererPreference(pane)
    || (rendererTrialExpiry(paneState) == null ? 'webgl' : 'dom');
}
