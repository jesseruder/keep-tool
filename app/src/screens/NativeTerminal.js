import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import * as api from '../api';
import { mono } from '../ui';

const { createEmulator } = require('../terminal/emulator');
const { encodeKey, encodePaste, encodeText, inputDelta } = require('../terminal/keys');
const { createRenderQueue } = require('../terminal/render-queue');
const { rowSegments } = require('../terminal/row');
const { openPaneSocket } = require('../terminal/socket');
const { runStyle } = require('../terminal/style');
const { clampFontSize, createPinch, MAX_FONT_SIZE, MIN_FONT_SIZE } = require('../terminal/zoom');

// The native terminal: xterm's parser runs in the app (src/terminal/emulator.js) over
// the pane relay (src/terminal/socket.js), and the parsed rows are drawn as native
// text. The phone is an observer — it never claims the pane and never resizes it, so
// attaching from here cannot reflow a session somebody is typing into on the Mac —
// but the host accepts an observer's keystrokes, so it can still answer a question.

const FONT_KEY = '@keep/terminalFont';
const DEFAULT_FONT_SIZE = 9;
// A monospace cell is about 0.6em wide in both platforms' default mono faces. It is
// an estimate, not a measurement: the rows are laid out by the text engine, and this
// only decides how wide the scrollable canvas is.
const CELL_WIDTH_EM = 0.6;
const LINE_HEIGHT_EM = 1.3;
const BODY_PADDING = 8;
// How much of the pane's own scrollback the emulator keeps, and how much of it the
// screen holds on to. Both match the daemon: bin/host.js keeps 10,000 lines per pane
// and bin/console.js's `history=full` snapshot sends up to the same, so "load earlier
// output" cannot arrive with more than either of these can hold.
const EMULATOR_SCROLLBACK = 10000;
const MAX_CACHED_SCROLLBACK = 10000;
// Rows above the screen that are actually mounted. Every one is a native view, so
// the window grows on request rather than rendering a whole buffer nobody scrolled to.
const SCROLLBACK_PAGE = 300;
const FRAME_MS = 33;
const REPEAT_MS = 110;
// What the hidden input is held at, so that a backspace on an otherwise empty field
// is still a change the app can read. Figure spaces, because a keyboard is less
// likely to treat them as a word boundary worth autocorrecting.
const SENTINEL = '    ';

// Esc/Tab and the arrows are what a terminal needs and a phone keyboard does not
// have. Ctrl and Alt are sticky: tap, then tap the key they modify.
const KEY_BAR = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: 'Alt', modifier: 'alt' },
  { label: '←', key: 'Left', repeat: true },
  { label: '↑', key: 'Up', repeat: true },
  { label: '↓', key: 'Down', repeat: true },
  { label: '→', key: 'Right', repeat: true },
  { label: 'Home', key: 'Home' },
  { label: 'End', key: 'End' },
  { label: 'PgUp', key: 'PageUp', repeat: true },
  { label: 'PgDn', key: 'PageDown', repeat: true },
  { label: '⇧⏎', key: 'ShiftEnter', hint: 'Shift+Enter' },
  { label: '⌫', key: 'Backspace', repeat: true },
  { label: '^C', key: 'CtrlC' },
  { label: 'Paste', paste: true },
];

// expo-clipboard is not a dependency of this app (adding one is a native rebuild),
// so the clipboard is React Native's own, which still ships in 0.86 behind a
// deprecation warning. If a future release drops it, copy and paste disable
// themselves rather than throwing at the user.
function clipboard() {
  try {
    // eslint-disable-next-line global-require
    return require('expo-clipboard');
  } catch {}
  try {
    // eslint-disable-next-line global-require
    const core = require('react-native').Clipboard;
    if (core && typeof core.getString === 'function') {
      return {
        getStringAsync: () => Promise.resolve(core.getString()),
        setStringAsync: (value) => Promise.resolve(core.setString(value)),
      };
    }
  } catch {}
  return null;
}

const STATUS_LABELS = {
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  history: 'loading history',
  live: 'live',
  closed: 'closed',
  exited: 'exited',
};

function makeStyles(colors) {
  return StyleSheet.create({
    root: { backgroundColor: colors.termBg, flex: 1 },
    header: { backgroundColor: colors.barBg, borderBottomColor: colors.barLine, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 5, paddingHorizontal: 8 },
    headerTop: { alignItems: 'center', flexDirection: 'row', minHeight: 42 },
    back: { alignItems: 'flex-start', justifyContent: 'center', minHeight: 38, minWidth: 58, paddingHorizontal: 6 },
    backText: { color: colors.info, fontSize: 13, fontWeight: '700' },
    heading: { flex: 1, paddingHorizontal: 4 },
    title: { color: colors.barText, fontSize: 15, fontWeight: '700', lineHeight: 20 },
    status: { alignItems: 'center', flexDirection: 'row', justifyContent: 'flex-end', minHeight: 38, paddingHorizontal: 6 },
    statusDot: { borderRadius: 4, height: 8, marginRight: 6, width: 8 },
    statusText: { fontFamily: mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
    metaRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 6 },
    meta: { color: colors.barMuted, flexShrink: 1, fontFamily: mono, fontSize: 10, lineHeight: 15 },
    headerAction: { borderColor: colors.barLine, borderRadius: 4, borderWidth: 1, minHeight: 26, justifyContent: 'center', paddingHorizontal: 8 },
    headerActionText: { color: colors.info, fontFamily: mono, fontSize: 10, fontWeight: '700' },
    body: { backgroundColor: colors.termBg, flex: 1 },
    content: { paddingHorizontal: BODY_PADDING, paddingVertical: BODY_PADDING },
    row: { color: colors.termFg, fontFamily: mono, includeFontPadding: false },
    historyBar: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingBottom: 6 },
    historyButton: { backgroundColor: colors.barSel, borderColor: colors.termLine, borderRadius: 5, borderWidth: 1, justifyContent: 'center', minHeight: 28, paddingHorizontal: 10 },
    historyButtonText: { color: colors.info, fontFamily: mono, fontSize: 10, fontWeight: '700' },
    historyNote: { color: colors.termDim, flexShrink: 1, fontFamily: mono, fontSize: 10 },
    empty: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
    emptyText: { color: colors.termDim, fontFamily: mono, fontSize: 12, lineHeight: 18, textAlign: 'center' },
    hidden: { height: 1, left: -1000, position: 'absolute', top: -1000, width: 1 },
    keyBar: { backgroundColor: colors.barSeg, borderTopColor: colors.barLine, borderTopWidth: StyleSheet.hairlineWidth, flexGrow: 0, maxHeight: 42, minHeight: 42 },
    keyContent: { alignItems: 'center', gap: 5, paddingHorizontal: 6, paddingVertical: 6 },
    keyButton: { alignItems: 'center', backgroundColor: colors.barSel, borderColor: colors.barLine, borderRadius: 4, borderWidth: 1, height: 30, justifyContent: 'center', minWidth: 40, paddingHorizontal: 8 },
    keyButtonOn: { backgroundColor: colors.info, borderColor: colors.info },
    keyButtonPressed: { backgroundColor: colors.termLine },
    keyText: { color: colors.barText, fontFamily: mono, fontSize: 11, fontWeight: '700' },
    keyTextOn: { color: colors.termBg },
    follow: { alignSelf: 'center', backgroundColor: colors.barSel, borderColor: colors.termLine, borderRadius: 14, borderWidth: 1, bottom: 10, paddingHorizontal: 14, paddingVertical: 7, position: 'absolute' },
    followText: { color: colors.info, fontFamily: mono, fontSize: 11, fontWeight: '700' },
    toast: { alignSelf: 'center', backgroundColor: colors.barBg, borderColor: colors.barLine, borderRadius: 6, borderWidth: 1, bottom: 60, left: 18, paddingHorizontal: 12, paddingVertical: 9, position: 'absolute', right: 18 },
    toastText: { color: colors.barText, fontSize: 12, textAlign: 'center' },
  });
}

// One parsed row. Memoized on the row object, which the paint step only replaces for
// rows the parser actually touched, so a spinner repaints one line and not the screen.
const Row = React.memo(function Row({ cursor, cursorUnderline, fontSize, lineHeight, onCopy, onPress, row, styles, theme }) {
  const segments = rowSegments(row, cursor);
  const text = { fontSize, lineHeight };
  const body = segments.length === 0
    ? ' '
    : segments.map((segment, index) => {
      const base = runStyle(segment.run, theme);
      const style = segment.cursor
        ? (cursorUnderline
          // A pane whose process has exited still shows its screen; an underline
          // says the block is where the cursor stopped, not where typing goes.
          ? { ...base, textDecorationLine: 'underline' }
          : runStyle({ ...segment.run, inverse: !segment.run.inverse }, theme))
        : base;
      return <Text allowFontScaling={false} key={index} style={style}>{segment.text}</Text>;
    });
  return (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      onLongPress={onCopy ? () => onCopy(row.text.slice(0, row.trimmed)) : undefined}
      onPress={onPress}
      style={[styles.row, text]}
      suppressHighlighting
    >
      {body}
    </Text>
  );
});

function KeyButton({ entry, on, onPress, styles }) {
  const timer = useRef(null);
  const repeated = useRef(false);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  return (
    <Pressable
      accessibilityLabel={entry.hint || entry.label}
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(on) }}
      delayLongPress={320}
      onLongPress={entry.repeat ? () => {
        repeated.current = true;
        onPress();
        timer.current = setInterval(onPress, REPEAT_MS);
      } : undefined}
      onPress={() => {
        if (!repeated.current) onPress();
        repeated.current = false;
      }}
      onPressIn={() => { repeated.current = false; }}
      onPressOut={stop}
      style={({ pressed }) => [styles.keyButton, on && styles.keyButtonOn, pressed && !on && styles.keyButtonPressed]}
    >
      <Text style={[styles.keyText, on && styles.keyTextOn]}>{entry.label}</Text>
    </Pressable>
  );
}

export default function NativeTerminal({ colors, config, onBack, onUseTextView, storage, target }) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const theme = useMemo(() => ({ fg: colors.termFg, bg: colors.termBg }), [colors]);

  const [pane, setPane] = useState(target?.pane || '');
  const [paneError, setPaneError] = useState('');
  const [status, setStatus] = useState('connecting');
  const [paneState, setPaneState] = useState(null);
  const [rows, setRows] = useState([]);
  const [scrollback, setScrollback] = useState([]);
  const [scrollbackWindow, setScrollbackWindow] = useState(SCROLLBACK_PAGE);
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });
  const [alternate, setAlternate] = useState(false);
  const [moreHistory, setMoreHistory] = useState(false);
  const [fullHistory, setFullHistory] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [modifiers, setModifiers] = useState({ ctrl: false, alt: false });
  const [following, setFollowing] = useState(true);
  const [toast, setToast] = useState('');

  const emulatorRef = useRef(null);
  const queueRef = useRef(null);
  const socketRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const followRef = useRef(true);
  const scrollbackRef = useRef({ seq: 0, rows: [], sliding: false });
  // The mounted window, as a ref as well, because the paint step runs off a timer
  // and must read the current one rather than the one its closure was made with.
  const windowRef = useRef(SCROLLBACK_PAGE);
  const scrollbackStaleRef = useRef(false);
  const modifiersRef = useRef(modifiers);
  const fontRef = useRef(DEFAULT_FONT_SIZE);
  const toastTimer = useRef(null);
  const mounted = useRef(true);

  modifiersRef.current = modifiers;
  fontRef.current = fontSize;

  const note = useCallback((message) => {
    if (!mounted.current) return;
    setToast(String(message || ''));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => mounted.current && setToast(''), 2600);
  }, []);

  useEffect(() => () => {
    mounted.current = false;
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // The zoom level is a preference, not session state: it survives leaving the screen.
  useEffect(() => {
    let cancelled = false;
    if (!storage) return undefined;
    storage.getItem(FONT_KEY).then((saved) => {
      const size = Number(saved);
      if (!cancelled && Number.isFinite(size)) setFontSize(clampFontSize(size));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [storage]);

  // A target that names only a session has no pane to attach to yet.
  useEffect(() => {
    if (target?.pane) { setPane(target.pane); return undefined; }
    if (!target?.session) { setPaneError('This terminal has no pane and no session.'); return undefined; }
    const controller = new AbortController();
    setPaneError('');
    api.terminalView(config, target.session, controller.signal).then((view) => {
      if (controller.signal.aborted) return;
      const found = view?.panes?.[0]?.id || view?.sessions?.[0]?.pane || '';
      if (found) setPane(found);
      else setPaneError('That session has no terminal pane on the host.');
    }).catch((error) => {
      if (!controller.signal.aborted) setPaneError(error?.message || 'Could not find the session’s pane');
    });
    return () => controller.abort();
  }, [config, target?.pane, target?.session]);

  // Everything the mounted scrollback rows are read from, in one place: the append
  // path while the emulator's buffer still has room, and a straight read of the
  // mounted window once it is full. Once the buffer is dropping its oldest line for
  // every new one, what was collected earlier is no longer contiguous with what is on
  // screen, and appending to it would show the reader a seam without saying so.
  const syncScrollback = useCallback((emulator, window) => {
    if (emulator.isAlternate()) return;
    const { length, saturated } = emulator.normalScrollback();
    const cache = scrollbackRef.current;
    if (saturated) {
      const want = Math.max(SCROLLBACK_PAGE, window);
      const rows = emulator.scrollbackRows(want, want);
      // These rows are a window onto a buffer that slides under them, so a key can
      // only be a position in the window; nothing here is the same line it was a
      // moment ago. The prefix keeps them from ever colliding with the collected
      // rows' keys, which are positions in the pane's output.
      scrollbackRef.current = {
        seq: length, rows: rows.map((row, index) => ({ key: `sbw:${index}`, row })), sliding: true,
      };
      setScrollback(scrollbackRef.current.rows);
      return;
    }
    if (cache.sliding) {
      // The buffer is back under its limit, which only a reset does, and its lines are
      // numbered from zero again; start collecting from there.
      scrollbackRef.current = { seq: 0, rows: [], sliding: false };
      setScrollback([]);
    }
    const held = scrollbackRef.current;
    const grown = length - (held.seq + held.rows.length);
    if (grown <= 0) return;
    const added = emulator.scrollbackRows(grown, grown).map((row, index) => ({
      key: `sb:${held.seq + held.rows.length + index}`,
      row,
    }));
    let next = [...held.rows, ...added];
    let seq = held.seq;
    if (next.length > MAX_CACHED_SCROLLBACK) {
      const dropped = next.length - MAX_CACHED_SCROLLBACK;
      next = next.slice(dropped);
      seq += dropped;
    }
    scrollbackRef.current = { seq, rows: next, sliding: false };
    setScrollback(next);
  }, []);

  // One paint: the rows the parser touched since the last frame, plus everything the
  // cursor and the scrollback need. `rows()` is only called for those rows, so an
  // idle pane costs a timer and nothing else.
  const paint = useCallback(({ rows: dirty, full }) => {
    const emulator = emulatorRef.current;
    if (!emulator || !mounted.current) return;
    // `emulator.rows` is the reader; the pane's height comes off the terminal itself.
    const height = emulator.term.rows;
    if (full) setRows(emulator.rows());
    else if (dirty.length) {
      setRows((current) => {
        if (current.length !== height) return emulator.rows();
        const next = current.slice();
        for (const y of dirty) {
          if (y < 0 || y >= height) continue;
          next[y] = emulator.rows({ start: y, end: y })[0];
        }
        return next;
      });
    }

    const nextCursor = emulator.cursor();
    setCursor((current) => (current.x === nextCursor.x && current.y === nextCursor.y
      && current.visible === nextCursor.visible && current.offset === nextCursor.offset
      && current.length === nextCursor.length ? current : nextCursor));
    setAlternate(emulator.isAlternate());

    // A saturated buffer has to be re-read rather than added to, and re-reading the
    // mounted window on every frame of a build log would be the most expensive thing
    // on screen. While the reader is following the output the rows above are off the
    // screen, so the read waits until they scroll up (onScroll does it then).
    if (emulator.normalScrollback().saturated && followRef.current) {
      scrollbackStaleRef.current = true;
      return;
    }
    scrollbackStaleRef.current = false;
    syncScrollback(emulator, windowRef.current);
  }, [syncScrollback]);

  // A reattach replays the screen from scratch (the replay opens with a reset), so
  // what was collected describes a buffer that no longer exists, and the new one
  // numbers its lines from zero again.
  const resetCaches = useCallback(() => {
    scrollbackRef.current = { seq: 0, rows: [], sliding: false };
    scrollbackStaleRef.current = false;
    windowRef.current = SCROLLBACK_PAGE;
    setScrollback([]);
    setScrollbackWindow(SCROLLBACK_PAGE);
  }, []);

  useEffect(() => {
    if (!pane || !config?.server || !config?.token) return undefined;
    const emulator = createEmulator({ cols: 80, rows: 24, scrollback: EMULATOR_SCROLLBACK });
    emulatorRef.current = emulator;
    const queue = createRenderQueue({ intervalMs: FRAME_MS, onFlush: paint });
    queueRef.current = queue;
    setStatus('connecting');

    const socket = openPaneSocket({
      server: config.server,
      token: config.token,
      pane,
      // Every mount is its own viewer: the host counts viewers, and reusing one id
      // across two phones or two mounts would hide one of them.
      viewer: `mobile-${Math.random().toString(36).slice(2, 10)}`,
      drain: (done) => emulator.drain(done),
      onAttached: (message) => {
        const state = message.pane || {};
        setPaneState(state);
        setMoreHistory(message.history?.truncated === true);
        // The pane's geometry is the pane's: this client adopts it and never sends a
        // resize of its own.
        if (Number.isInteger(state.cols) && Number.isInteger(state.rows)) {
          emulator.resize(state.cols, state.rows);
        }
        resetCaches();
        queue.invalidateAll();
      },
      onReplay: (data) => emulator.write(data),
      onReplayEnd: () => {
        queue.invalidateAll();
        queue.flush();
        setStatus('live');
      },
      onData: (data) => {
        // The dirty list is only complete once the parser has applied the chunk;
        // xterm's write queue is asynchronous, so the frame is scheduled from its
        // callback rather than from the frame's arrival.
        emulator.write(data, () => queue.invalidate(emulator.takeDirty()));
      },
      onPaneState: (next, message) => {
        if (next) {
          setPaneState(next);
          // The primary viewer on the Mac owns the geometry; an observer follows it.
          // Without this the rows keep the size they attached at and every line wraps
          // in a different place than it does on the desktop.
          if (Number.isInteger(next.cols) && Number.isInteger(next.rows)
            && (next.cols !== emulator.cols || next.rows !== emulator.term.rows)) {
            emulator.resize(next.cols, next.rows);
            queue.invalidateAll();
          }
        }
        if (message?.t === 'exit') setStatus('exited');
        if (message?.t === 'error' && message.message) note(message.message);
      },
      onStatus: (state) => {
        if (state === 'closed') return;
        setStatus((current) => (state === 'live' && current === 'exited' ? current : state));
      },
      onClose: () => setStatus('closed'),
    });
    socketRef.current = socket;

    return () => {
      socketRef.current = null;
      queueRef.current = null;
      emulatorRef.current = null;
      socket.close();
      queue.dispose();
      emulator.dispose();
      setRows([]);
      setPaneState(null);
    };
  }, [config?.server, config?.token, note, paint, pane, resetCaches]);

  const send = useCallback((bytes) => {
    if (!bytes) return;
    const socket = socketRef.current;
    if (!socket) return;
    socket.sendInput(bytes);
    // Typing is a reason to be looking at the bottom of the screen.
    followRef.current = true;
    setFollowing(true);
  }, []);

  const clearModifiers = useCallback(() => {
    if (modifiersRef.current.ctrl || modifiersRef.current.alt) setModifiers({ ctrl: false, alt: false });
  }, []);

  const pressKey = useCallback((name) => {
    const emulator = emulatorRef.current;
    const modes = emulator ? emulator.modes() : { applicationCursor: false };
    send(encodeKey(name, { ...modifiersRef.current, applicationCursor: modes.applicationCursor }));
    clearModifiers();
  }, [clearModifiers, send]);

  const paste = useCallback(() => {
    const board = clipboard();
    if (!board) { note('This build has no clipboard access.'); return; }
    board.getStringAsync().then((text) => {
      if (!text) { note('The clipboard is empty.'); return; }
      const emulator = emulatorRef.current;
      send(encodePaste(text, { bracketedPaste: emulator ? emulator.modes().bracketedPaste : false }));
    }).catch(() => note('Could not read the clipboard.'));
  }, [note, send]);

  const copyRow = useCallback((text) => {
    const board = clipboard();
    if (!board) { note('This build has no clipboard access.'); return; }
    board.setStringAsync(text ?? '').then(() => note('Row copied.')).catch(() => note('Could not copy that row.'));
  }, [note]);

  // The hidden field is held at a sentinel so a backspace on an empty field is still
  // a change the app can see; see inputDelta in src/terminal/keys.js.
  const onChangeText = useCallback((next) => {
    const delta = inputDelta(SENTINEL, next);
    if (delta.backspaces) send('\x7f'.repeat(delta.backspaces));
    if (delta.text) {
      send(encodeText(delta.text, modifiersRef.current));
      clearModifiers();
    }
    // Put the field back the way it was, natively rather than through state: the
    // next keystroke has to be a delta against the sentinel again, and a re-render
    // between two fast keystrokes would lose one.
    if (inputRef.current) inputRef.current.setNativeProps({ text: SENTINEL });
  }, [clearModifiers, send]);

  const openOnMac = useCallback(() => {
    if (!target?.session) return;
    api.focus(config, target.session)
      .then(() => note('Brought forward on the Mac.'))
      .catch((error) => note(error?.message || 'Could not focus the console.'));
  }, [config, note, target?.session]);

  const loadEarlier = useCallback(() => {
    // First mount more of what the app already holds, then ask the host for the rest:
    // `history=full` reattaches with the pane's whole scrollback in the snapshot,
    // which is how the desktop console's own history button works.
    if (scrollbackWindow < scrollbackRef.current.rows.length) {
      windowRef.current = scrollbackWindow + SCROLLBACK_PAGE;
      setScrollbackWindow(windowRef.current);
      const emulator = emulatorRef.current;
      if (emulator) syncScrollback(emulator, windowRef.current);
      return;
    }
    const socket = socketRef.current;
    if (!socket || !socket.loadFullHistory()) return;
    setFullHistory(true);
    setStatus('history');
  }, [scrollbackWindow, syncScrollback]);

  // Pinch, without a gesture library: the responder only takes the gesture when a
  // second finger lands, so one-finger scrolling still belongs to the ScrollViews.
  const pinch = useMemo(() => createPinch({ min: MIN_FONT_SIZE, max: MAX_FONT_SIZE }), []);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length >= 2,
    onMoveShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length >= 2,
    onPanResponderGrant: (event) => { pinch.begin(event.nativeEvent.touches, fontRef.current); },
    onPanResponderMove: (event) => {
      const touches = event.nativeEvent.touches;
      if (!pinch.active()) { pinch.begin(touches, fontRef.current); return; }
      const next = pinch.move(touches);
      if (next !== null && next !== fontRef.current) {
        fontRef.current = next;
        setFontSize(next);
      }
    },
    onPanResponderRelease: () => {
      pinch.end();
      if (storage) storage.setItem(FONT_KEY, String(fontRef.current)).catch(() => {});
    },
    onPanResponderTerminate: () => pinch.end(),
  }), [pinch, storage]);

  const onScroll = useCallback((event) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
    if (atBottom === followRef.current) return;
    followRef.current = atBottom;
    setFollowing(atBottom);
    // Leaving the bottom is the moment the rows above become worth reading again.
    const emulator = emulatorRef.current;
    if (!atBottom && emulator && scrollbackStaleRef.current) {
      scrollbackStaleRef.current = false;
      syncScrollback(emulator, windowRef.current);
    }
  }, [syncScrollback]);

  // Tapping the screen is how the soft keyboard is asked for; the field itself is
  // off-screen, so there is nothing else to tap.
  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  const toBottom = useCallback(() => {
    followRef.current = true;
    setFollowing(true);
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  const cols = Number(paneState?.cols) || 80;
  const alive = paneState ? paneState.alive !== false : true;
  const title = paneState?.title || target?.title || 'terminal';
  const lineHeight = Math.ceil(fontSize * LINE_HEIGHT_EM);
  const canvasWidth = Math.ceil(cols * fontSize * CELL_WIDTH_EM) + BODY_PADDING * 2;
  const visibleScrollback = alternate ? [] : scrollback.slice(-scrollbackWindow);
  const canLoadEarlier = !alternate && (scrollbackWindow < scrollback.length || (moreHistory && !fullHistory));
  const statusColor = status === 'live' ? colors.ok
    : status === 'closed' || status === 'exited' ? colors.bad : colors.warn;

  return (
    // Android resizes the window for the soft keyboard on its own; asking for padding
    // as well leaves a second gap the size of the keyboard under the key bar.
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <View style={styles.heading}>
            <Text numberOfLines={1} style={styles.title}>{title}</Text>
          </View>
          <View accessibilityLabel={`Connection ${STATUS_LABELS[status] || status}`} style={styles.status}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{STATUS_LABELS[status] || status}</Text>
          </View>
        </View>
        <View style={styles.metaRow}>
          <Text numberOfLines={1} style={styles.meta}>
            {`viewing at ${cols}×${Number(paneState?.rows) || 24} · typing goes to the session`}
          </Text>
          {target?.session ? (
            <Pressable accessibilityRole="button" onPress={openOnMac} style={({ pressed }) => [styles.headerAction, pressed && { opacity: 0.7 }]}>
              <Text style={styles.headerActionText}>Open on Mac</Text>
            </Pressable>
          ) : null}
          {onUseTextView ? (
            <Pressable accessibilityRole="button" onPress={onUseTextView} style={({ pressed }) => [styles.headerAction, pressed && { opacity: 0.7 }]}>
              <Text style={styles.headerActionText}>Text view</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.body} {...panResponder.panHandlers}>
        {paneError ? (
          <View style={styles.empty}><Text style={styles.emptyText}>{paneError}</Text></View>
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{status === 'closed' ? 'The terminal connection closed.' : 'Attaching to the pane…'}</Text>
          </View>
        ) : (
          <ScrollView horizontal nestedScrollEnabled style={styles.body}>
            <ScrollView
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="always"
              nestedScrollEnabled
              onContentSizeChange={() => { if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false }); }}
              onScroll={onScroll}
              ref={scrollRef}
              scrollEventThrottle={64}
              // Rows appear above the visible ones both when output scrolls the screen
              // and when earlier output is loaded; without this the reader is carried
              // away from the line they were reading. Index 0 is the history bar.
              maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
              style={{ width: canvasWidth }}
            >
              <View style={styles.historyBar}>
                {alternate ? (
                  <Text style={styles.historyNote}>A full-screen program is running; its screen has no scrollback.</Text>
                ) : canLoadEarlier ? (
                  <Pressable accessibilityRole="button" onPress={loadEarlier} style={({ pressed }) => [styles.historyButton, pressed && { opacity: 0.7 }]}>
                    <Text style={styles.historyButtonText}>Load earlier output</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.historyNote}>
                    {moreHistory ? 'Start of the loaded output' : 'Start of the pane’s buffer'}
                  </Text>
                )}
              </View>
              {visibleScrollback.map((entry) => (
                <Row
                  cursor={null}
                  fontSize={fontSize}
                  key={entry.key}
                  lineHeight={lineHeight}
                  onCopy={copyRow}
                  onPress={focusInput}
                  row={entry.row}
                  styles={styles}
                  theme={theme}
                />
              ))}
              {rows.map((row, index) => (
                <Row
                  cursor={cursor.visible && cursor.y === index ? cursor : null}
                  cursorUnderline={!alive}
                  fontSize={fontSize}
                  key={index}
                  lineHeight={lineHeight}
                  onCopy={copyRow}
                  onPress={focusInput}
                  row={row}
                  styles={styles}
                  theme={theme}
                />
              ))}
            </ScrollView>
          </ScrollView>
        )}
        {!following ? (
          <Pressable accessibilityRole="button" onPress={toBottom} style={styles.follow}>
            <Text style={styles.followText}>Jump to the live screen</Text>
          </Pressable>
        ) : null}
        {toast ? <View pointerEvents="none" style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View> : null}
      </View>

      <TextInput
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        blurOnSubmit={false}
        caretHidden
        defaultValue={SENTINEL}
        importantForAutofill="no"
        // visible-password is the Android keyboard with no suggestion strip and no
        // autocorrect, which is the only reliable way to stop the keyboard rewriting
        // what is typed into a terminal.
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        onChangeText={onChangeText}
        onSubmitEditing={() => pressKey('Enter')}
        ref={inputRef}
        returnKeyType="send"
        spellCheck={false}
        style={styles.hidden}
        textContentType="none"
      />

      <ScrollView
        contentContainerStyle={styles.keyContent}
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.keyBar}
      >
        {KEY_BAR.map((entry) => (
          <KeyButton
            entry={entry}
            key={entry.label}
            on={entry.modifier ? modifiers[entry.modifier] : false}
            onPress={() => {
              if (entry.modifier) {
                setModifiers((current) => ({ ...current, [entry.modifier]: !current[entry.modifier] }));
                inputRef.current?.focus();
                return;
              }
              if (entry.paste) { paste(); return; }
              pressKey(entry.key);
            }}
            styles={styles}
          />
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
