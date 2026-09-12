const SCHEMA = 'keep-terminal-scroll-v1';
const PAINT_PROXY = 'xterm-onrender-next-animation-frame';
const CAPS = { wheel: 2048, input: 4096, output: 1024, parse: 1024, render: 1024,
  frameGap: 1024, longtask: 256, inputToOutput: 1024 };
const CLOCK_LIMIT = 1e15;

function mouseReport(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 0x1b || bytes[1] !== 0x5b) return null;
  let protocol;
  let code;
  if (bytes.length === 6 && bytes[2] === 0x4d) {
    protocol = 1;
    code = bytes[3] - 32;
  } else {
    if (bytes.length < 9 || bytes[2] !== 0x3c || (bytes.at(-1) !== 0x4d && bytes.at(-1) !== 0x6d)) return null;
    protocol = 0;
    let separator = -1;
    for (let index = 3; index < bytes.length - 1; index += 1) {
      if (bytes[index] === 0x3b) { separator = index; break; }
      if (bytes[index] < 0x30 || bytes[index] > 0x39) return null;
    }
    if (separator < 4) return null;
    code = 0;
    for (let index = 3; index < separator; index += 1) code = code * 10 + bytes[index] - 0x30;
  }
  if (!Number.isInteger(code) || code < 0 || code > 255) return null;
  const category = code & 64 ? 0 : code & 32 ? 1 : 2;
  if (protocol === 1) return { protocol, category };
  let separators = 0;
  for (let index = 3; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x3b) separators += 1;
    else if (bytes[index] < 0x30 || bytes[index] > 0x39) return null;
  }
  return separators === 2 ? { protocol, category } : null;
}

function createRecorder(options, config, initialWheel) {
  const env = options.env;
  const startPerf = env.now();
  const startWall = env.wallNow();
  const events = { wheel: [], input: [], output: [], parse: [], render: [], frameGap: [], longtask: [], inputToOutput: [] };
  const counts = { wheel: 0, input: 0, output: 0, parse: 0, render: 0, frame: 0,
    frameGap: 0, longtask: 0, inputToOutput: 0, unknownEventTimeStamp: 0 };
  for (const key of Object.keys(events)) counts[`dropped${key[0].toUpperCase()}${key.slice(1)}`] = 0;
  const totals = { inputBytes: 0, outputBytes: 0 };
  const timestampDomains = new Set();
  const clockDiagnostics = {};
  const renderFrames = new Set();
  const documentWheelAt = typeof WeakMap === 'function' ? new WeakMap() : null;
  let stopped = false;
  let timer = null;
  let frame = null;
  let lastFrame = startPerf;
  let renderDisposable = null;
  let longtaskObserver = null;
  let pendingInputCount = 0;
  let pendingInputFirst = 0;
  let pendingInputLast = 0;

  const round = (value) => Math.round(value * 10) / 10;
  const clockValue = (value) => Number.isFinite(value) && Math.abs(value) <= CLOCK_LIMIT ? round(value) : null;
  const pushClock = (key, tuple, max) => {
    if (tuple.some((value) => value == null)) return;
    const values = clockDiagnostics[key] ||= [];
    if (values.length < max) values.push(tuple);
  };
  const sampleClocks = (phase) => {
    if (typeof env.WheelEvent === 'function') {
      try {
        const before = env.now();
        const stamp = Number(new env.WheelEvent('wheel').timeStamp);
        const after = env.now();
        pushClock('wheelConstruct', [phase, clockValue(stamp - before), clockValue(stamp - after)], 2);
      } catch {}
    }
    if (Number.isFinite(env.timeOrigin)) {
      const before = env.now();
      const wall = env.wallNow();
      const after = env.now();
      pushClock('wallTimeOrigin', [phase, clockValue(wall - (env.timeOrigin + before)),
        clockValue(wall - (env.timeOrigin + after))], 2);
    }
  };
  const relative = (at = env.now()) => round(Math.max(0, at - startPerf));
  const push = (key, tuple) => {
    counts[key] += 1;
    if (events[key].length < CAPS[key]) events[key].push(tuple);
    else counts[`dropped${key[0].toUpperCase()}${key.slice(1)}`] += 1;
  };
  const wheelTimestamp = (event, handlerAt) => {
    const stamp = Number(event.timeStamp);
    let normalized = stamp;
    let domain = 'performance';
    if (!Number.isFinite(stamp)) domain = 'unknown';
    else if (stamp > 1e12 && Number.isFinite(env.timeOrigin)) {
      normalized = stamp - env.timeOrigin;
      domain = 'epoch';
    }
    const delay = domain === 'unknown' ? null : handlerAt - normalized;
    if (delay == null || !Number.isFinite(delay) || delay < -5 || delay > 60e3) {
      timestampDomains.add('unknown');
      counts.unknownEventTimeStamp += 1;
      return null;
    }
    timestampDomains.add(domain);
    return round(Math.max(0, delay));
  };
  const recordWheel = (event) => {
    if (stopped) return;
    const at = env.now();
    const deltaY = Number(event.deltaY);
    const deltaMode = Number(event.deltaMode);
    if (!Number.isFinite(deltaY) || !Number.isFinite(deltaMode)) return;
    const wheelIndex = counts.wheel;
    if (wheelIndex < CAPS.wheel) {
      const documentAt = documentWheelAt?.get(event);
      if (Number.isFinite(documentAt)) {
        pushClock('wheelDocumentToWrapper', [wheelIndex, clockValue(at - documentAt)], CAPS.wheel);
        documentWheelAt.delete(event);
      } else {
        pushClock('wheelDocumentCaptureMissing', [wheelIndex], CAPS.wheel);
      }
    }
    push('wheel', [relative(at), wheelTimestamp(event, at), round(deltaY), deltaMode]);
  };
  const documentWheel = (event) => {
    if (!stopped && event.isTrusted) documentWheelAt?.set(event, env.now());
  };
  let documentListening = false;
  if (documentWheelAt && typeof env.document?.addEventListener === 'function'
      && typeof env.document?.removeEventListener === 'function') {
    try {
      env.document.addEventListener('wheel', documentWheel, { capture: true, passive: true });
      documentListening = true;
    } catch {}
  }
  const activeWheel = (event) => { if (event !== initialWheel && event.isTrusted) recordWheel(event); };
  options.wrapper.addEventListener('wheel', activeWheel, true);
  recordWheel(initialWheel);
  sampleClocks(0);

  const frameTick = (at) => {
    if (stopped) return;
    counts.frame += 1;
    const gap = at - lastFrame;
    if (gap > 20) push('frameGap', [relative(at), round(gap)]);
    lastFrame = at;
    frame = env.requestAnimationFrame(frameTick);
  };
  frame = env.requestAnimationFrame(frameTick);

  if (typeof options.terminal.onRender === 'function') {
    renderDisposable = options.terminal.onRender(() => {
      if (stopped) return;
      const renderAt = env.now();
      const id = env.requestAnimationFrame((paintAt) => {
        renderFrames.delete(id);
        if (!stopped) push('render', [relative(renderAt), round(Math.max(0, paintAt - renderAt))]);
      });
      renderFrames.add(id);
    });
  }
  if (env.PerformanceObserver && (!Array.isArray(env.PerformanceObserver.supportedEntryTypes)
      || env.PerformanceObserver.supportedEntryTypes.includes('longtask'))) {
    try {
      longtaskObserver = new env.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType !== 'longtask' || !Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration)) continue;
          if (entry.startTime + entry.duration < startPerf) continue;
          push('longtask', [relative(Math.max(startPerf, entry.startTime)), round(entry.duration)]);
        }
      });
      longtaskObserver.observe({ type: 'longtask', buffered: false });
    } catch { longtaskObserver = null; }
  }

  const stop = (reason) => {
    if (stopped) return null;
    stopped = true;
    env.clearTimeout(timer);
    env.cancelAnimationFrame(frame);
    for (const id of renderFrames) env.cancelAnimationFrame(id);
    renderFrames.clear();
    options.wrapper.removeEventListener('wheel', activeWheel, true);
    if (documentListening) env.document.removeEventListener('wheel', documentWheel, true);
    renderDisposable?.dispose();
    longtaskObserver?.disconnect();
    sampleClocks(1);
    const endedPerf = env.now();
    const endedAt = env.wallNow();
    const domains = [...timestampDomains].filter((value) => value !== 'unknown');
    const eventTimeStampDomain = timestampDomains.has('unknown') ? 'unknown'
      : domains.length > 1 ? 'mixed' : domains[0] || 'unknown';
    return {
      schema: SCHEMA, runtime: options.runtime, reason, partial: reason !== 'duration',
      startedAt: startWall, endedAt, durationMs: Math.min(config.durationMs + 5000, Math.max(0, endedPerf - startPerf)),
      eventTimeStampDomain, inputToOutputApproximate: true, paintProxy: PAINT_PROXY,
      capabilities: { longtask: Boolean(longtaskObserver), onRender: Boolean(renderDisposable) },
      counts, totals, events,
      ...(Object.keys(clockDiagnostics).length ? { clockDiagnostics } : {}),
    };
  };
  timer = env.setTimeout(() => options.onStop(stop('duration')), config.durationMs);

  return {
    stop,
    inputSent(bytes, bufferedAmount) {
      if (stopped) return;
      const mouse = mouseReport(bytes);
      if (!mouse) return;
      const at = env.now();
      const byteLength = bytes.byteLength;
      totals.inputBytes += byteLength;
      push('input', [relative(at), mouse.protocol, mouse.category, byteLength,
        Number.isFinite(bufferedAmount) ? bufferedAmount : null]);
      if (mouse.category === 0) {
        if (!pendingInputCount) pendingInputFirst = at;
        pendingInputLast = at;
        pendingInputCount += 1;
      }
    },
    outputReceived(byteLength) {
      if (stopped || !Number.isInteger(byteLength) || byteLength < 0) return null;
      const at = env.now();
      totals.outputBytes += byteLength;
      push('output', [relative(at), byteLength]);
      if (pendingInputCount) {
        push('inputToOutput', [relative(at), pendingInputCount,
          round(Math.max(0, at - pendingInputFirst)), round(Math.max(0, at - pendingInputLast))]);
        pendingInputCount = 0;
      }
      return { at, byteLength };
    },
    outputParsed(token) {
      if (stopped || !token) return;
      const at = env.now();
      push('parse', [relative(at), token.byteLength, round(Math.max(0, at - token.at))]);
    },
  };
}

export function createTerminalProfiler(options) {
  const runtime = options.runtime || (window.__TAURI__ ? 'desktop' : 'web');
  const defaultPerformance = globalThis.performance;
  const env = {
    fetch: globalThis.fetch?.bind(globalThis), now: () => defaultPerformance?.now?.() || 0, wallNow: Date.now,
    timeOrigin: defaultPerformance?.timeOrigin, setTimeout: globalThis.setTimeout?.bind(globalThis) || (() => 0),
    clearTimeout: globalThis.clearTimeout?.bind(globalThis) || (() => {}),
    requestAnimationFrame: globalThis.requestAnimationFrame?.bind(globalThis) || (() => 0),
    cancelAnimationFrame: globalThis.cancelAnimationFrame?.bind(globalThis) || (() => {}),
    PerformanceObserver: globalThis.PerformanceObserver, AbortController: globalThis.AbortController,
    document: globalThis.document, WheelEvent: globalThis.WheelEvent,
    randomNonce: () => globalThis.crypto?.randomUUID?.().replaceAll('-', '') || null,
    ...(options.env || {}),
  };
  const pane = options.pane;
  const claimNonce = env.randomNonce();
  let phase = 'checking';
  let config = null;
  let recorder = null;
  let expiryTimer = null;
  let report = null;
  let claimAccepted = false;
  let statusTimer = null;

  const setStatus = (value) => options.status?.(value);
  const clearEligibility = () => {
    env.clearTimeout(expiryTimer);
    options.wrapper.removeEventListener('wheel', claimOnWheel, true);
  };
  const post = async (body, timeoutMs = 5000) => {
    const controller = env.AbortController ? new env.AbortController() : null;
    const timeout = env.setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const response = await env.fetch('/api/terminal-profile', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller?.signal,
        headers: { 'content-type': 'application/json', 'x-keep': '1' }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = new Error(`terminal profile request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    } finally { env.clearTimeout(timeout); }
  };
  const finishStatus = (message) => {
    setStatus(message);
    env.clearTimeout(statusTimer);
    statusTimer = env.setTimeout(() => setStatus(null), 3000);
  };
  const submit = async () => {
    if (!report || !claimAccepted) return;
    for (const delay of [0, 250, 1000]) {
      if (delay) await new Promise((resolve) => env.setTimeout(resolve, delay));
      try {
        await post({ action: 'report', pane, runtime, runId: config.runId, claimNonce, report });
        finishStatus('Scroll profile captured');
        phase = 'done';
        return;
      } catch {}
    }
    finishStatus('Scroll profile could not be saved');
    phase = 'done';
  };
  const recorderStopped = (value) => {
    if (!value || report) return;
    options.capture?.(null);
    report = value;
    void submit();
  };
  const claimOnWheel = (event) => {
    if (phase !== 'armed' || !event.isTrusted || env.wallNow() >= config.expiresAt
        || !options.active() || !options.focused()) return;
    phase = 'claiming';
    clearEligibility();
    recorder = createRecorder({ ...options, runtime, env, onStop: recorderStopped }, config, event);
    options.capture?.(recorder);
    setStatus('Scroll profile recording…');
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await post({ action: 'start', pane, runtime, runId: config.runId, claimNonce }, 3000);
          claimAccepted = true;
          if (phase === 'claiming') phase = 'recording';
          void submit();
          return;
        } catch (error) {
          if (error.status) break;
        }
      }
      recorder?.stop('error');
      options.capture?.(null);
      recorder = null;
      report = null;
      phase = 'done';
      setStatus(null);
    })();
  };

  const check = async () => {
    if (!env.fetch) { phase = 'done'; return; }
    try {
      const query = new URLSearchParams({ pane, runtime });
      const response = await env.fetch(`/api/terminal-profile?${query}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok || phase !== 'checking') { phase = 'done'; return; }
      const body = await response.json();
      if (!/^[a-f0-9]{32}$/.test(claimNonce || '') || !body.config
          || body.config.pane !== pane || body.config.runtime !== runtime
          || body.config.durationMs !== 15000 || !body.config.runId || body.config.expiresAt <= env.wallNow()) {
        phase = 'done'; return;
      }
      config = body.config;
      phase = 'armed';
      options.wrapper.addEventListener('wheel', claimOnWheel, true);
      expiryTimer = env.setTimeout(() => {
        if (phase === 'armed') { phase = 'done'; clearEligibility(); }
      }, Math.max(0, config.expiresAt - env.wallNow()));
    } catch { phase = 'done'; }
  };
  void check();

  return {
    get state() { return phase; },
    inputSent(bytes, bufferedAmount) { recorder?.inputSent(bytes, bufferedAmount); },
    outputReceived(byteLength) { return recorder?.outputReceived(byteLength) || null; },
    outputParsed(token) { recorder?.outputParsed(token); },
    stop(reason = 'hidden') {
      if (phase === 'done') return;
      if (phase === 'armed' || phase === 'checking') {
        phase = 'done';
        clearEligibility();
        return;
      }
      recorderStopped(recorder?.stop(reason));
    },
  };
}

export { mouseReport };
