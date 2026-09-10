import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import * as api from '../api';
import { projectFor } from '../model';
import { mono } from '../ui';

const POLL_MS = 1500;
const SCREEN_LINES = 120;
const REPEAT_MS = 120;
const CELL_WIDTH_EM = 0.6;
const BODY_PADDING = 10;
const KEY_BUTTONS = [
  ['Esc', 'Escape'],
  ['Tab', 'Tab'],
  ['↑', 'Up', true],
  ['↓', 'Down', true],
  ['←', 'Left', true],
  ['→', 'Right', true],
  ['^C', 'CtrlC'],
  ['Ctrl-L', 'CtrlL'],
  ['⌫', 'Backspace'],
];

function makeScreenStyles(colors) {
  return StyleSheet.create({
    root: { backgroundColor: colors.termBg, flex: 1 },
    header: { backgroundColor: colors.barBg, borderBottomColor: colors.barLine, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 6, paddingHorizontal: 8 },
    headerTop: { alignItems: 'center', flexDirection: 'row', minHeight: 42 },
    back: { alignItems: 'flex-start', justifyContent: 'center', minHeight: 38, minWidth: 62, paddingHorizontal: 6 },
    backText: { color: colors.info, fontSize: 13, fontWeight: '700' },
    heading: { flex: 1, paddingHorizontal: 4 },
    title: { color: colors.barText, fontSize: 16, fontWeight: '700', lineHeight: 21 },
    live: { alignItems: 'center', flexDirection: 'row', justifyContent: 'flex-end', minHeight: 38, minWidth: 98, paddingHorizontal: 6 },
    liveDot: { borderRadius: 4, height: 8, marginRight: 6, width: 8 },
    liveText: { fontFamily: mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
    meta: { color: colors.barMuted, fontFamily: mono, fontSize: 10, lineHeight: 15, paddingHorizontal: 72 },
    body: { backgroundColor: colors.termBg, flex: 1 },
    terminalContent: { padding: BODY_PADDING },
    terminalLine: { color: colors.termFg, fontFamily: mono, includeFontPadding: false },
    cursor: { backgroundColor: colors.termFg, color: colors.termBg },
    empty: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
    emptyText: { color: colors.termDim, fontFamily: mono, fontSize: 12, lineHeight: 18, textAlign: 'center' },
    // The key row is an accessory bar, not a toolbar: keep it thin so the terminal
    // keeps the height, especially with the soft keyboard open.
    keyBar: { backgroundColor: colors.barSeg, borderTopColor: colors.barLine, borderTopWidth: StyleSheet.hairlineWidth, flexGrow: 0, maxHeight: 40, minHeight: 40 },
    keyContent: { alignItems: 'center', gap: 5, paddingHorizontal: 6, paddingVertical: 5 },
    keyButton: { alignItems: 'center', backgroundColor: colors.barSel, borderColor: colors.barLine, borderRadius: 4, borderWidth: 1, height: 30, justifyContent: 'center', minWidth: 40, paddingHorizontal: 8 },
    keyButtonDisabled: { opacity: 0.42 },
    keyButtonPressed: { backgroundColor: colors.termLine },
    keyText: { color: colors.barText, fontFamily: mono, fontSize: 11, fontWeight: '700' },
    inputBar: { alignItems: 'stretch', backgroundColor: colors.barBg, borderTopColor: colors.barLine, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, padding: 6 },
    input: { backgroundColor: colors.termBg, borderColor: colors.termLine, borderRadius: 5, borderWidth: 1, color: colors.termFg, flex: 1, fontSize: 14, minHeight: 38, paddingHorizontal: 10, paddingVertical: 6 },
    enter: { alignItems: 'center', backgroundColor: colors.info, borderRadius: 5, justifyContent: 'center', minHeight: 38, minWidth: 60, paddingHorizontal: 12 },
    enterDisabled: { opacity: 0.42 },
    enterPressed: { opacity: 0.72 },
    enterText: { color: colors.termBg, fontSize: 13, fontWeight: '700' },
    toast: { alignSelf: 'center', backgroundColor: colors.bad, borderRadius: 5, bottom: 92, left: 18, paddingHorizontal: 13, paddingVertical: 10, position: 'absolute', right: 18 },
    toastText: { color: colors.barText, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  });
}

function TerminalLine({ cols, cursor, index, line, lineHeight, styles, textStyle }) {
  const rowCursor = cursor && Number(cursor.y) === index ? cursor : null;
  // Terminal columns use fixed cell geometry; scaling only the glyphs would overflow the server-reported width.
  if (!rowCursor) return <Text allowFontScaling={false} numberOfLines={1} style={[styles.terminalLine, textStyle, { lineHeight }]}>{line || ' '}</Text>;

  const characters = Array.from(String(line || ''));
  const cursorX = Math.max(0, Math.min(Number(cols || 1) - 1, Math.floor(Number(rowCursor.x) || 0)));
  while (characters.length <= cursorX) characters.push(' ');
  return (
    <Text allowFontScaling={false} numberOfLines={1} style={[styles.terminalLine, textStyle, { lineHeight }]}>
      {characters.slice(0, cursorX).join('')}
      <Text allowFontScaling={false} style={styles.cursor}>{characters[cursorX]}</Text>
      {characters.slice(cursorX + 1).join('')}
    </Text>
  );
}

function KeyButton({ disabled, label, name, onKey, repeat, styles }) {
  const repeatTimer = useRef(null);
  const longPress = useRef(false);

  const stopRepeating = () => {
    if (repeatTimer.current) clearInterval(repeatTimer.current);
    repeatTimer.current = null;
  };

  useEffect(() => stopRepeating, []);

  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      delayLongPress={350}
      onLongPress={repeat ? () => {
        if (disabled) return;
        longPress.current = true;
        onKey(name);
        repeatTimer.current = setInterval(() => onKey(name), REPEAT_MS);
      } : undefined}
      onPress={() => {
        if (!disabled && !longPress.current) onKey(name);
        longPress.current = false;
      }}
      onPressIn={() => { longPress.current = false; }}
      onPressOut={stopRepeating}
      style={({ pressed }) => [styles.keyButton, disabled && styles.keyButtonDisabled, pressed && !disabled && styles.keyButtonPressed]}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );
}

export default function Screen({ colors, config, onBack, pane, project: projectPath, session, sessionId }) {
  const styles = useMemo(() => makeScreenStyles(colors), [colors]);
  // Either an agent session or a bare shell pane; the daemon takes one or the other.
  const target = useMemo(() => (sessionId ? { sessionId } : { pane }), [pane, sessionId]);
  const [frame, setFrame] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [pollMessage, setPollMessage] = useState('');
  const [bodyWidth, setBodyWidth] = useState(0);
  const [draft, setDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [inputBusy, setInputBusy] = useState(false);
  const [toast, setToast] = useState('');
  const keyBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const toastTimer = useRef(null);

  const showToast = useCallback((error) => {
    if (!mountedRef.current) return;
    const message = error?.message || 'Terminal command failed';
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3200);
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    let mounted = true;
    let active = AppState.currentState === 'active';
    let inFlight = null;
    let timer = null;

    const poll = async () => {
      if (!mounted || !active || inFlight) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const next = await api.screen(config, target, SCREEN_LINES, controller.signal);
        if (mounted && active) {
          setFrame(next);
          setPollMessage('');
          setReconnecting(false);
        }
      } catch (error) {
        if (!controller.signal.aborted && mounted && active) {
          setPollMessage(error.message || 'Could not load the terminal');
          setReconnecting(true);
        }
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    };

    const cancelPoll = () => {
      if (inFlight) inFlight.abort();
      inFlight = null;
    };

    const start = () => {
      if (timer) clearInterval(timer);
      poll();
      timer = setInterval(poll, POLL_MS);
    };

    if (active) start();
    const subscription = AppState.addEventListener('change', (nextState) => {
      active = nextState === 'active';
      if (active) start();
      else if (timer) {
        clearInterval(timer);
        timer = null;
        cancelPoll();
      }
    });

    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
      cancelPoll();
      subscription.remove();
    };
  }, [config, target]);

  const sendKey = useCallback(async (name) => {
    if (keyBusyRef.current) return;
    keyBusyRef.current = true;
    setKeyBusy(true);
    try { await api.keys(config, target, [name]); }
    catch (error) { showToast(error); }
    finally {
      keyBusyRef.current = false;
      if (mountedRef.current) setKeyBusy(false);
    }
  }, [config, showToast, target]);

  const submitInput = useCallback(async () => {
    if (inputBusy || keyBusyRef.current) return;
    if (!draft.length) {
      await sendKey('Enter');
      return;
    }
    setInputBusy(true);
    try {
      await api.send(config, target, draft);
      if (mountedRef.current) setDraft('');
    } catch (error) { showToast(error); }
    finally { if (mountedRef.current) setInputBusy(false); }
  }, [config, draft, inputBusy, sendKey, showToast, target]);

  const project = projectFor(session?.project || projectPath || '');
  const title = frame?.title || session?.title || (sessionId ? 'untitled session' : 'shell');
  const paneLabel = String(frame?.pane || session?.pane || pane || '—').slice(0, 8);
  const cols = Number(frame?.cols) || 80;
  const rows = Number(frame?.rows) || 24;
  const lines = Array.isArray(frame?.lines) ? frame.lines : [];
  const cursorRow = Math.floor(Number(frame?.cursor?.y));
  const rowOffset = Math.max(0, rows - lines.length);
  const cursor = frame?.cursor && Number.isFinite(cursorRow)
    && cursorRow >= rowOffset && cursorRow < rowOffset + lines.length
    ? { ...frame.cursor, y: cursorRow - rowOffset }
    : null;
  const usableWidth = Math.max(0, bodyWidth - BODY_PADDING * 2);
  const fitted = usableWidth ? usableWidth / (cols * CELL_WIDTH_EM) : 13;
  const fontSize = Math.max(9, Math.min(13, fitted));
  const lineHeight = Math.ceil(fontSize * 1.35);
  const terminalWidth = Math.max(bodyWidth, cols * fontSize * CELL_WIDTH_EM + BODY_PADDING * 2);
  const inputDisabled = inputBusy || keyBusy;

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <View style={styles.heading}>
            <Text numberOfLines={1} style={styles.title}>{title}</Text>
          </View>
          <View accessibilityLabel={reconnecting ? 'Reconnecting' : 'Live'} style={styles.live}>
            <View style={[styles.liveDot, { backgroundColor: reconnecting ? colors.barMuted : colors.ok }]} />
            <Text style={[styles.liveText, { color: reconnecting ? colors.barMuted : colors.ok }]}>{reconnecting ? 'reconnecting' : 'live'}</Text>
          </View>
        </View>
        <Text numberOfLines={1} style={styles.meta}>{project.name} · pane {paneLabel} · viewing at {cols}×{rows}</Text>
      </View>

      <View onLayout={(event) => setBodyWidth(event.nativeEvent.layout.width)} style={styles.body}>
        {frame ? (
          <ScrollView horizontal nestedScrollEnabled style={styles.body}>
            <ScrollView
              contentContainerStyle={styles.terminalContent}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              style={{ width: terminalWidth }}
            >
              {lines.map((line, index) => (
                <TerminalLine
                  cols={cols}
                  cursor={cursor}
                  index={index}
                  key={index}
                  line={line}
                  lineHeight={lineHeight}
                  styles={styles}
                  textStyle={{ fontSize }}
                />
              ))}
            </ScrollView>
          </ScrollView>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{pollMessage || 'Connecting to terminal…'}</Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.keyContent} horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={styles.keyBar}>
        {KEY_BUTTONS.map(([label, name, repeat]) => (
          <KeyButton disabled={keyBusy} key={name} label={label} name={name} onKey={sendKey} repeat={repeat} styles={styles} />
        ))}
      </ScrollView>

      <View style={styles.inputBar}>
        <TextInput
          autoCapitalize="sentences"
          editable={!inputBusy}
          maxLength={2000}
          onChangeText={setDraft}
          onSubmitEditing={submitInput}
          placeholder="Type into the session…"
          placeholderTextColor={colors.termDim}
          returnKeyType="send"
          style={styles.input}
          value={draft}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: inputDisabled }}
          disabled={inputDisabled}
          onPress={submitInput}
          style={({ pressed }) => [styles.enter, inputDisabled && styles.enterDisabled, pressed && styles.enterPressed]}
        >
          <Text style={styles.enterText}>Enter</Text>
        </Pressable>
      </View>
      {toast ? <View pointerEvents="none" style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </KeyboardAvoidingView>
  );
}
