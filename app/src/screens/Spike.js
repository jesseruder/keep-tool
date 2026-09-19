import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Button, mono } from '../ui';

const { createEmulator } = require('../terminal/emulator');
const { fixture, frameData, expectedRuns, sameRun } = require('../terminal/fixture');
const { runStyle } = require('../terminal/style');

// Phase 3 step 0: does xterm's parser run under Hermes, and how fast? The fixture is a
// synthetic relay stream built by src/terminal/fixtures/generate.js, with the expected
// final screen baked in by @xterm/addon-serialize on the Mac — the device does not
// carry the serializer, only the parser it would actually ship with.
//
// The verdict covers the styling, not only the text. The fixture deliberately carries
// palette, 256-colour and truecolour, and every attribute, because a colour mapping
// that broke under Hermes would render a screen that still reads correctly — and a
// PASS on text alone would be a lie about exactly the part hardest to eyeball.

function now() {
  if (typeof global !== 'undefined' && global.performance && typeof global.performance.now === 'function') {
    return global.performance.now();
  }
  return Date.now();
}

async function runSpike() {
  const started = now();
  const emulator = createEmulator({
    cols: fixture.cols, rows: fixture.rows, scrollback: fixture.expected.scrollback || 1000,
  });
  const frames = fixture.frames.filter((frame) => frame.kind !== 'json');
  const decodeStart = now();
  const payloads = frames.map(frameData);
  const decodeMs = now() - decodeStart;
  const bytes = payloads.reduce((total, data) => total + (data.length || 0), 0);

  const writeStart = now();
  for (const data of payloads) emulator.write(data);
  await emulator.flush();
  const writeMs = now() - writeStart;

  const rowsStart = now();
  const rows = emulator.rows();
  const rowsMs = now() - rowsStart;

  const mine = rows.map((row) => row.text.slice(0, row.trimmed));
  const wantRuns = expectedRuns();
  const diffs = [];
  let firstDiff = null;
  for (let y = 0; y < fixture.expected.rows.length; y++) {
    const wantText = fixture.expected.rows[y];
    const want = wantRuns[y] || [];
    const got = rows[y] ? rows[y].runs : [];
    let detail = null;
    if (mine[y] !== wantText) {
      detail = { kind: 'text', got: mine[y], want: wantText };
    } else if (got.length !== want.length) {
      detail = { kind: 'runs', got: `${got.length} runs`, want: `${want.length} runs` };
    } else {
      for (let i = 0; i < want.length; i++) {
        if (sameRun(got[i], want[i])) continue;
        detail = { kind: 'run', index: i, got: got[i], want: want[i] };
        break;
      }
    }
    if (!detail) continue;
    diffs.push(y);
    if (!firstDiff) firstDiff = { row: y, ...detail };
  }
  const cursor = emulator.cursor();
  const alternate = emulator.isAlternate();
  const cursorOk = cursor.x === fixture.expected.cursor.x
    && cursor.y === fixture.expected.cursor.y
    && cursor.visible === fixture.expected.cursor.visible;

  emulator.dispose();
  return {
    pass: diffs.length === 0 && cursorOk && alternate === fixture.expected.alternate,
    diffs,
    firstDiff,
    runs: wantRuns.reduce((total, row) => total + row.length, 0),
    rows,
    mine,
    frames: frames.length,
    bytes,
    decodeMs,
    writeMs,
    rowsMs,
    totalMs: now() - started,
    cursor,
    cursorOk,
    alternate,
  };
}

function Row({ row, style, theme }) {
  if (row.runs.length <= 1) return <Text style={style}>{row.text.slice(0, row.trimmed) || ' '}</Text>;
  return (
    <Text style={style}>
      {row.runs.map((run, index) => {
        const text = row.text.slice(run.start, Math.min(run.end, row.trimmed));
        if (!text) return null;
        return <Text key={`${index}:${run.start}`} style={runStyle(run, theme)}>{text}</Text>;
      })}
    </Text>
  );
}

export default function Spike({ colors, onBack, styles: appStyles }) {
  const [state, setState] = useState({ status: 'running' });

  const run = useCallback(() => {
    setState({ status: 'running' });
    // A throw here is the answer to the spike's question, so it is shown, not swallowed.
    runSpike().then(
      (result) => setState({ status: 'done', result }),
      (error) => setState({ status: 'failed', error }),
    );
  }, []);

  useEffect(() => { run(); }, [run]);

  const styles = {
    screen: { backgroundColor: colors.bg, flex: 1 },
    content: { padding: 14, paddingBottom: 40 },
    title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 4 },
    sub: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
    verdict: { borderRadius: 6, marginBottom: 12, padding: 10 },
    verdictText: { fontSize: 15, fontWeight: '700' },
    stat: { color: colors.text, fontFamily: mono, fontSize: 12, lineHeight: 19 },
    screenRow: { color: colors.text, fontFamily: mono, fontSize: 7, lineHeight: 10 },
    actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  };

  const result = state.result;
  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.title}>Terminal parser spike</Text>
      <Text style={styles.sub}>
        {`@xterm/headless under Hermes, replaying ${fixture.frames.length} frames of ${fixture.pane} `
          + `(${fixture.cols}x${fixture.rows}), rebuilt by ${fixture.generatedBy}.`}
      </Text>

      {state.status === 'running' ? <Text style={styles.stat}>running…</Text> : null}

      {state.status === 'failed' ? (
        <View style={[styles.verdict, { backgroundColor: colors.badSoft }]}>
          <Text style={[styles.verdictText, { color: colors.bad }]}>
            {`the parser did not run: ${state.error?.message || state.error}`}
          </Text>
          <Text style={styles.stat}>{String(state.error?.stack || '').slice(0, 800)}</Text>
        </View>
      ) : null}

      {state.status === 'done' ? (
        <>
          <View style={[styles.verdict, { backgroundColor: result.pass ? colors.accentSoft : colors.badSoft }]}>
            <Text style={[styles.verdictText, { color: result.pass ? colors.ok : colors.bad }]}>
              {result.pass
                ? 'PASS — text and styling both match the serializer'
                : `FAIL — ${result.diffs.length} rows differ`}
            </Text>
          </View>
          <Text style={styles.stat}>{`frames        ${result.frames}`}</Text>
          <Text style={styles.stat}>{`bytes         ${result.bytes}`}</Text>
          <Text style={styles.stat}>{`base64 decode ${result.decodeMs.toFixed(1)} ms`}</Text>
          <Text style={styles.stat}>{`write+parse   ${result.writeMs.toFixed(1)} ms`}</Text>
          <Text style={styles.stat}>{`rows()        ${result.rowsMs.toFixed(2)} ms for ${result.rows.length} rows`}</Text>
          <Text style={styles.stat}>{`style runs    ${result.runs} compared`}</Text>
          <Text style={styles.stat}>{`total         ${result.totalMs.toFixed(1)} ms`}</Text>
          <Text style={styles.stat}>
            {`cursor        ${result.cursor.x},${result.cursor.y} visible=${result.cursor.visible} `
              + `${result.cursorOk ? 'ok' : `expected ${fixture.expected.cursor.x},${fixture.expected.cursor.y}`}`}
          </Text>
          <Text style={styles.stat}>
            {`alt buffer    ${result.alternate} ${result.alternate === fixture.expected.alternate ? 'ok' : 'MISMATCH'}`}
          </Text>
          {result.firstDiff ? (
            <Text style={styles.stat}>
              {`first diff at row ${result.firstDiff.row}`
                + `${result.firstDiff.kind === 'run' ? `, run ${result.firstDiff.index}` : ''} `
                + `(${result.firstDiff.kind})\n  got  ${JSON.stringify(result.firstDiff.got)}`
                + `\n  want ${JSON.stringify(result.firstDiff.want)}`}
            </Text>
          ) : null}

          <Text style={[styles.sub, { marginTop: 14 }]}>The parsed screen, drawn as native text rows:</Text>
          <ScrollView horizontal>
            <View>
              {result.rows.map((row, index) => (
                <Row key={index} row={row} style={styles.screenRow} theme={{ bg: colors.bg, fg: colors.text }} />
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}

      <View style={styles.actions}>
        <Button onPress={run} quiet style={{ flex: 1 }} styles={appStyles}>Run again</Button>
        <Button onPress={onBack} quiet style={{ flex: 1 }} styles={appStyles}>Back</Button>
      </View>
    </ScrollView>
  );
}
