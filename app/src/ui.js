import React from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function makeStyles(colors) {
  const sheet = StyleSheet.create({
    app: { backgroundColor: colors.bg, flex: 1 },
    loadingScreen: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, justifyContent: 'center' },
    screen: { backgroundColor: colors.bg, flex: 1 },
    scroll: { flex: 1 },
    pressed: { opacity: 0.7 },
    topBar: { alignItems: 'center', backgroundColor: colors.barBg, flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
    segmented: { backgroundColor: colors.barSeg, borderColor: colors.barLine, borderRadius: 7, borderWidth: 1, flex: 1, flexDirection: 'row', overflow: 'hidden' },
    segment: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 4, justifyContent: 'center', minHeight: 44, paddingHorizontal: 5 },
    segmentSelected: { backgroundColor: colors.barSel },
    segmentText: { color: colors.barMuted, fontSize: 12, fontWeight: '600' },
    segmentTextSelected: { color: colors.barText },
    countPill: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 10, justifyContent: 'center', minWidth: 18, paddingHorizontal: 5, paddingVertical: 1 },
    countPillText: { color: colors.accentInk, fontFamily: mono, fontSize: 10, fontWeight: '700' },
    statusDot: { borderRadius: 4, height: 8, width: 8 },
    settingsButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, width: 44 },
    settingsText: { color: colors.barMuted, fontSize: 19 },
    footer: { alignItems: 'center', backgroundColor: colors.barBg, borderTopColor: colors.barLine, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 38, paddingHorizontal: 12, paddingVertical: 7 },
    footerText: { color: colors.barMuted, fontFamily: mono, fontSize: 10 },
    metersBar: { backgroundColor: colors.barBg, borderTopColor: colors.barLine, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 5 },
    meters: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    meter: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    meterLabel: { color: colors.barMuted, fontFamily: mono, fontSize: 10 },
    meterTrack: { backgroundColor: colors.barSeg, borderRadius: 2, height: 4, overflow: 'hidden', width: 44 },
    meterFill: { backgroundColor: colors.info, borderRadius: 2, height: 4 },
    meterFillWarn: { backgroundColor: colors.bad },
    meterPercent: { color: colors.barText, fontFamily: mono, fontSize: 10, fontVariant: ['tabular-nums'] },
    connectionBanner: { alignItems: 'center', backgroundColor: colors.badSoft, justifyContent: 'center', minHeight: 44, paddingHorizontal: 14, paddingVertical: 7 },
    connectionText: { color: colors.bad, fontSize: 12, textAlign: 'center' },

    row: { backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 78, paddingBottom: 10, paddingHorizontal: 14, paddingTop: 10, position: 'relative' },
    rowAccent: { bottom: 0, left: 0, position: 'absolute', top: 0, width: 3 },
    rowTop: { alignItems: 'baseline', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
    rowTitle: { color: colors.text, flex: 1, fontSize: 15, fontWeight: '600', lineHeight: 20 },
    rowAge: { color: colors.faint, fontFamily: mono, fontSize: 11 },
    rowProject: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 4, overflow: 'hidden' },
    projectDot: { borderRadius: 4, height: 8, width: 8 },
    projectName: { color: colors.muted, fontSize: 12, fontWeight: '600' },
    cardId: { color: colors.faint, flexShrink: 1, fontFamily: mono, fontSize: 11 },
    rowSummary: { alignItems: 'baseline', flexDirection: 'row', gap: 7, marginTop: 5 },
    kindWord: { color: colors.muted, fontFamily: mono, fontSize: 11 },
    kindAction: { color: colors.accent, fontWeight: '700' },
    preview: { color: colors.muted, flex: 1, fontSize: 13, lineHeight: 17 },
    groupHeader: { alignItems: 'center', backgroundColor: colors.sheadBg, borderBottomColor: colors.line, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 14, paddingVertical: 7 },
    groupLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
    groupMeta: { color: colors.faint, fontFamily: mono, fontSize: 10 },
    queueHeader: { alignItems: 'center', backgroundColor: colors.panel, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 11 },
    queueHeading: { color: colors.text, fontSize: 13, fontWeight: '700' },
    queueOrder: { color: colors.faint, fontFamily: mono, fontSize: 10 },
    emptyState: { alignItems: 'center', backgroundColor: colors.panel, justifyContent: 'center', minHeight: 180, paddingHorizontal: 30, paddingVertical: 28 },
    emptyMark: { color: colors.ok, fontSize: 30, marginBottom: 8 },
    emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 5, textAlign: 'center' },
    emptyCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },

    sessionHeader: { backgroundColor: colors.sheadBg, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 14, paddingHorizontal: 16, paddingTop: 10 },
    backButton: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', minHeight: 44, paddingRight: 14 },
    backText: { color: colors.info, fontSize: 13, fontWeight: '700' },
    sessionTitle: { color: colors.text, fontSize: 21, fontWeight: '700', lineHeight: 27 },
    sessionMeta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
    openScreenLink: { alignItems: 'center', alignSelf: 'flex-start', justifyContent: 'center', marginTop: 5, minHeight: 44, paddingRight: 14 },
    openScreenText: { color: colors.info, fontFamily: mono, fontSize: 12, fontWeight: '700' },
    projectChip: { alignItems: 'center', backgroundColor: colors.panel2, borderRadius: 12, flexDirection: 'row', gap: 5, minHeight: 24, paddingHorizontal: 8 },
    tag: { color: colors.muted, fontFamily: mono, fontSize: 10 },
    answerArea: { backgroundColor: colors.answerBg, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, padding: 16 },
    questionBlock: { marginBottom: 11 },
    questionText: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 22 },
    options: { gap: 8, marginBottom: 12 },
    optionButton: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.line2, borderRadius: 6, borderWidth: 1, flexDirection: 'row', minHeight: 48, paddingHorizontal: 12, paddingVertical: 8 },
    optionNumber: { color: colors.accent, fontFamily: mono, fontSize: 12, fontWeight: '700', marginRight: 10, width: 18 },
    optionText: { color: colors.text, flex: 1, fontSize: 14, fontWeight: '600', lineHeight: 19 },
    replyRow: { alignItems: 'stretch', flexDirection: 'row', gap: 8 },
    replyInput: { backgroundColor: colors.bg, borderColor: colors.line2, borderRadius: 6, borderWidth: 1, color: colors.text, flex: 1, fontSize: 14, maxHeight: 96, minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 },
    lastHeader: { backgroundColor: colors.termBg, color: colors.termDim, fontFamily: mono, fontSize: 10, fontWeight: '700', letterSpacing: 1.1, paddingHorizontal: 16, paddingTop: 15, textTransform: 'uppercase' },
    terminal: { backgroundColor: colors.termBg, minHeight: 220, paddingBottom: 24, paddingHorizontal: 16, paddingTop: 10 },
    terminalText: { color: colors.termFg, fontSize: 13, lineHeight: 20 },
    terminalEmpty: { color: colors.termDim, fontSize: 13, lineHeight: 20 },
    earlierBlock: { borderTopColor: colors.termLine, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 16, paddingTop: 7 },
    earlierLink: { alignItems: 'flex-start', justifyContent: 'center', minHeight: 44 },
    earlierLinkText: { color: colors.info, fontFamily: mono, fontSize: 12, fontWeight: '700' },
    earlierTranscript: { backgroundColor: colors.termLine, borderRadius: 5, marginTop: 4, padding: 10 },
    bottomActions: { backgroundColor: colors.panel2, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 7, paddingHorizontal: 8, paddingVertical: 7 },

    button: { alignItems: 'center', backgroundColor: colors.accent, borderColor: colors.accent, borderRadius: 6, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 14, paddingVertical: 9 },
    buttonQuiet: { backgroundColor: 'transparent', borderColor: colors.line2 },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: colors.accentInk, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    buttonTextQuiet: { color: colors.muted },
    actionButton: { flex: 1, minHeight: 44, paddingHorizontal: 6 },
    sendButton: { minHeight: 44, minWidth: 68 },

    fleetFilterBar: { alignItems: 'center', backgroundColor: colors.panel2, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, padding: 10 },
    fleetFilter: { backgroundColor: colors.bg, borderColor: colors.line2, borderRadius: 6, borderWidth: 1, color: colors.text, flex: 1, fontSize: 14, minHeight: 44, paddingHorizontal: 12 },
    fleetCount: { color: colors.faint, fontFamily: mono, fontSize: 10 },
    fleetGroup: { alignItems: 'center', backgroundColor: colors.sheadBg, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 7, minHeight: 38, paddingHorizontal: 14 },
    fleetGroupName: { color: colors.text, fontSize: 13, fontWeight: '700' },
    fleetGroupMeta: { color: colors.muted, fontFamily: mono, fontSize: 10, marginLeft: 'auto' },
    fleetRow: { alignItems: 'stretch', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 66 },
    fleetOpenArea: { alignItems: 'flex-start', flex: 1, flexDirection: 'row', gap: 9, minHeight: 66, paddingBottom: 10, paddingLeft: 14, paddingTop: 10 },
    fleetStateDot: { borderRadius: 5, height: 9, marginTop: 5, width: 9 },
    fleetBody: { flex: 1 },
    fleetTitle: { color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
    fleetMeta: { color: colors.faint, fontFamily: mono, fontSize: 11, lineHeight: 17, marginTop: 3 },
    fleetScreenButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 58, paddingHorizontal: 8 },
    fleetScreenText: { color: colors.info, fontFamily: mono, fontSize: 10, fontWeight: '700' },

    statsStrip: { backgroundColor: colors.sheadBg, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
    statTile: { alignItems: 'center', borderRightColor: colors.line, borderRightWidth: StyleSheet.hairlineWidth, flex: 1, minHeight: 66, justifyContent: 'center', paddingHorizontal: 3, paddingVertical: 8 },
    statValue: { color: colors.text, fontFamily: mono, fontSize: 18, fontWeight: '700' },
    statHot: { color: colors.text },
    statLabel: { color: colors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginTop: 3, textAlign: 'center', textTransform: 'uppercase' },
    reviewerHead: { alignItems: 'center', backgroundColor: colors.panel2, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 50, paddingHorizontal: 12 },
    reviewerHeading: { color: colors.text, fontSize: 13, fontWeight: '700' },
    reviewerNew: { color: colors.info },
    toggle: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 44, paddingLeft: 8 },
    toggleLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' },
    toggleTrack: { backgroundColor: colors.line2, borderRadius: 8, height: 16, padding: 2, width: 29 },
    toggleTrackOn: { backgroundColor: colors.ok },
    toggleKnob: { backgroundColor: colors.panel, borderRadius: 6, height: 12, width: 12 },
    toggleKnobOn: { alignSelf: 'flex-end' },
    dayHeader: { alignItems: 'center', backgroundColor: colors.sheadBg, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44, paddingHorizontal: 12 },
    dayHeaderText: { color: colors.muted, fontFamily: mono, fontSize: 10, fontWeight: '700' },
    eventRow: { alignItems: 'flex-start', backgroundColor: colors.panel, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 58, paddingHorizontal: 11, paddingVertical: 9 },
    eventTime: { color: colors.faint, fontFamily: mono, fontSize: 10, paddingTop: 3, width: 34 },
    eventGlyph: { alignItems: 'center', backgroundColor: colors.panel2, borderColor: colors.line2, borderRadius: 4, borderWidth: 1, height: 24, justifyContent: 'center', width: 24 },
    eventGlyphText: { color: colors.muted, fontFamily: mono, fontSize: 12, fontWeight: '700' },
    eventBody: { flex: 1 },
    eventHeadingRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
    eventHeading: { color: colors.text, fontSize: 13, fontWeight: '700' },
    severityChip: { backgroundColor: colors.badSoft, borderRadius: 9, color: colors.bad, fontFamily: mono, fontSize: 9, overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 2 },
    eventCard: { color: colors.info, fontFamily: mono, fontSize: 10 },
    eventDetail: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
    reviewerFooter: { backgroundColor: colors.panel2, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, padding: 8 },

    newContent: { flexGrow: 1, paddingBottom: 24, paddingHorizontal: 14, paddingTop: 10 },
    newTitle: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 14, marginTop: 4 },
    newTabs: { backgroundColor: colors.barSeg, borderColor: colors.line, borderRadius: 7, borderWidth: 1, flexDirection: 'row', overflow: 'hidden' },
    newTab: { alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 },
    newTabSelected: { backgroundColor: colors.barSel },
    newTabText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
    newTabTextSelected: { color: colors.text },
    newList: { gap: 7, marginTop: 8 },
    newRow: { flexDirection: 'row', gap: 7, marginTop: 2 },
    newChoice: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.line, borderRadius: 6, borderWidth: 1, flex: 1, flexDirection: 'row', gap: 9, minHeight: 52, paddingHorizontal: 11, paddingVertical: 7 },
    newChoiceSelected: { borderColor: colors.info, borderWidth: 2 },
    newChoiceBody: { flex: 1 },
    newChoiceTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
    newChoiceMeta: { color: colors.faint, fontFamily: mono, fontSize: 10, marginTop: 3 },
    newMessage: { minHeight: 84 },
    newEmpty: { color: colors.muted, fontSize: 13, paddingVertical: 14, textAlign: 'center' },
    newHint: { color: colors.faint, fontSize: 12, lineHeight: 18, marginTop: 12 },
    newButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, width: 38 },
    newButtonText: { color: colors.info, fontSize: 24, fontWeight: '400' },
    setupOuter: { backgroundColor: colors.bg, flex: 1 },
    setupContent: { flexGrow: 1, paddingBottom: 38, paddingHorizontal: 20, paddingTop: 30 },
    setupTitle: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: 8 },
    setupIntro: { color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 22 },
    inputLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6, marginTop: 13, textTransform: 'uppercase' },
    input: { backgroundColor: colors.panel, borderColor: colors.line2, borderRadius: 6, borderWidth: 1, color: colors.text, fontSize: 15, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10 },
    setupActions: { flexDirection: 'row', gap: 8, marginTop: 18 },
    setupAction: { flex: 1 },
    paletteList: { gap: 7, marginTop: 2 },
    paletteOption: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.line, borderRadius: 6, borderWidth: 1, flexDirection: 'row', minHeight: 48, paddingHorizontal: 10 },
    paletteOptionSelected: { borderColor: colors.info, borderWidth: 2 },
    swatches: { flexDirection: 'row', marginRight: 10 },
    swatch: { height: 22, width: 12 },
    paletteName: { color: colors.text, flex: 1, fontSize: 13, fontWeight: '600' },
    paletteCheck: { color: colors.info, fontSize: 15, fontWeight: '700' },

    errorBox: { backgroundColor: colors.badSoft, borderColor: colors.bad, borderLeftWidth: 3, borderRadius: 5, marginTop: 12, padding: 10 },
    errorText: { color: colors.bad, fontSize: 13, fontWeight: '600', lineHeight: 18 },
    errorTail: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8, maxHeight: 140, paddingTop: 8 },
    monospace: { color: colors.text, fontFamily: mono, fontSize: 11, lineHeight: 17 },
    markdownBlock: { marginBottom: 8 },
    markdownBold: { fontWeight: '700' },
    markdownItalic: { fontStyle: 'italic' },
    markdownInlineCode: { backgroundColor: colors.panel2, fontFamily: mono, fontSize: 12 },
    markdownLink: { color: colors.info, textDecorationLine: 'underline' },
    markdownHeading1: { fontSize: 19, fontWeight: '700', lineHeight: 25 },
    markdownHeading2: { fontSize: 17, fontWeight: '700', lineHeight: 23 },
    markdownHeading3: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
    markdownListRow: { alignItems: 'flex-start', flexDirection: 'row' },
    markdownListPrefix: { flexShrink: 0 },
    markdownListText: { flex: 1 },
    markdownQuote: { borderLeftColor: colors.line2, borderLeftWidth: 3, paddingLeft: 9 },
    markdownQuoteText: { color: colors.muted },
    markdownCodeBlock: { backgroundColor: colors.panel2, borderRadius: 5, padding: 9 },
    markdownCodeText: { color: colors.termFg, fontFamily: mono, fontSize: 11, lineHeight: 17 },
  });
  return { ...sheet, colors };
}

export function Row({ accent = false, children, onPress, styles }) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {accent ? <View style={[styles.rowAccent, { backgroundColor: styles.colors.accent }]} /> : null}
      {children}
    </Pressable>
  );
}

export function Chip({ children, dotHue, styles }) {
  return (
    <View style={styles.projectChip}>
      {dotHue == null ? null : <View style={[styles.projectDot, { backgroundColor: `hsl(${dotHue}, 56%, 48%)` }]} />}
      <Text style={styles.projectName}>{children}</Text>
    </View>
  );
}

export function KindWord({ action = false, children, styles }) {
  return <Text style={[styles.kindWord, action && styles.kindAction]}>{children}</Text>;
}

export function UsageMeters({ styles, usage }) {
  const meters = [
    ...(Array.isArray(usage?.claude?.limits) ? usage.claude.limits : []),
    ...(Array.isArray(usage?.codex?.windows) ? usage.codex.windows : []).map((window) => ({ ...window, label: `Codex ${window.label}` })),
  ];
  if (!meters.length) return null;

  return (
    <View style={styles.metersBar}>
      <View style={styles.meters}>
        {meters.map((meter, index) => {
          const percent = Math.max(0, Math.min(100, Number(meter.percent) || 0));
          return (
            <View key={`${meter.label}-${index}`} style={styles.meter}>
              <Text style={styles.meterLabel}>{meter.label}</Text>
              <View style={styles.meterTrack}>
                <View style={[styles.meterFill, percent >= 75 && styles.meterFillWarn, { width: `${Math.round(percent)}%` }]} />
              </View>
              <Text style={styles.meterPercent}>{Math.round(percent)}%</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function SegmentedBar({ daemonHealthy, mode, needsCount, onNew, onSelect, onSettings, reviewerHealthy, styles }) {
  const segments = [
    { id: 'needs', label: 'Needs you' },
    { id: 'fleet', label: 'Fleet' },
    { id: 'reviewer', label: 'Reviewer' },
  ];
  return (
    <View style={styles.topBar}>
      <View accessibilityRole="tablist" style={styles.segmented}>
        {segments.map((segment) => {
          const selected = mode === segment.id;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              key={segment.id}
              onPress={() => onSelect(segment.id)}
              style={({ pressed }) => [styles.segment, selected && styles.segmentSelected, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={[styles.segmentText, selected && styles.segmentTextSelected]}>{segment.label}</Text>
              {segment.id === 'needs' ? (
                <View style={styles.countPill}><Text style={styles.countPillText}>{needsCount}</Text></View>
              ) : null}
              {segment.id === 'reviewer' ? (
                <View style={[styles.statusDot, { backgroundColor: reviewerHealthy ? styles.colors.ok : styles.colors.faint }]} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <View accessibilityLabel={daemonHealthy ? 'Daemon healthy' : 'Daemon unhealthy'} style={[
        styles.statusDot,
        { backgroundColor: daemonHealthy ? styles.colors.ok : styles.colors.bad },
      ]} />
      <Pressable
        accessibilityLabel="Start a new session or shell"
        accessibilityRole="button"
        onPress={onNew}
        style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
      >
        <Text style={styles.newButtonText}>+</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Connection and palette settings"
        accessibilityRole="button"
        onPress={onSettings}
        style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
      >
        <Text style={styles.settingsText}>⚙</Text>
      </Pressable>
    </View>
  );
}

export function Button({ children, disabled, loading, onPress, quiet = false, style, styles, textStyle }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        quiet && styles.buttonQuiet,
        style,
        (disabled || loading) && styles.buttonDisabled,
        pressed && !disabled && !loading && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={quiet ? styles.colors.muted : styles.colors.accentInk} size="small" />
      ) : typeof children === 'string' || typeof children === 'number' ? (
        <Text style={[styles.buttonText, quiet && styles.buttonTextQuiet, textStyle]}>{children}</Text>
      ) : children}
    </Pressable>
  );
}

export function InlineError({ error, styles }) {
  if (!error) return null;
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{error.message}</Text>
      {error.screenTail ? <Text selectable style={styles.monospace}>{error.screenTail}</Text> : null}
    </View>
  );
}

function markdownInline(text, styles, keyPrefix) {
  const nodes = [];
  const pattern = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\n]+?)\*/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-${match.index}`;
    if (match[1] !== undefined) nodes.push(<Text key={key} style={styles.markdownBold}>{match[1]}</Text>);
    else if (match[2] !== undefined) nodes.push(<Text key={key} style={styles.markdownInlineCode}>{match[2]}</Text>);
    else if (match[3] !== undefined) {
      const url = match[4];
      nodes.push(/^https?:\/\//i.test(url) ? (
        <Text key={key} onPress={async () => { try { await Linking.openURL(url); } catch {} }} style={styles.markdownLink}>
          {match[3]}
        </Text>
      ) : match[0]);
    } else {
      const before = text[match.index - 1];
      const after = text[match.index + match[0].length];
      nodes.push(before === '*' || after === '*' ? match[0] : <Text key={key} style={styles.markdownItalic}>{match[5]}</Text>);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function Markdown({ base, styles, text }) {
  let raw;
  try {
    raw = String(text ?? '');
    const lines = raw.split('\n');
    const blocks = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*```/.test(line)) {
        const code = [];
        for (index += 1; index < lines.length && !/^\s*```\s*$/.test(lines[index]); index += 1) code.push(lines[index]);
        blocks.push({ kind: 'code', text: code.join('\n') });
      } else if (/^\s*\|/.test(line)) {
        if (/^\s*[|:\s-]+$/.test(line)) continue;
        if (index + 1 < lines.length && /^\s*\|[|:\s-]+$/.test(lines[index + 1])) continue;
        const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
        if (cells.length) blocks.push({ kind: 'bullet', text: cells.join(' — ') });
      } else if (/^### /.test(line)) blocks.push({ kind: 'heading', level: 3, text: line.slice(4) });
      else if (/^## /.test(line)) blocks.push({ kind: 'heading', level: 2, text: line.slice(3) });
      else if (/^# /.test(line)) blocks.push({ kind: 'heading', level: 1, text: line.slice(2) });
      else if (/^- /.test(line)) blocks.push({ kind: 'bullet', text: line.slice(2) });
      else if (/^(\d+)\. /.test(line)) {
        const number = line.match(/^(\d+)\. /)[1];
        blocks.push({ kind: 'ordered', prefix: `${number}. `, text: line.replace(/^\d+\. /, '') });
      } else if (/^> /.test(line)) blocks.push({ kind: 'quote', text: line.slice(2) });
      else if (line.trim()) {
        const paragraph = [line];
        while (index + 1 < lines.length && lines[index + 1].trim()
          && !/^\s*```|^\s*\||^#{1,3} |^- |^\d+\. |^> /.test(lines[index + 1])) paragraph.push(lines[index += 1]);
        blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      }
    }
    return (
      <View>
        {blocks.map((block, index) => {
          const blockStyle = index === blocks.length - 1 ? null : styles.markdownBlock;
          const content = markdownInline(block.text, styles, `md-${index}`);
          if (block.kind === 'code') return <View key={index} style={[styles.markdownCodeBlock, blockStyle]}><Text selectable style={styles.markdownCodeText}>{block.text}</Text></View>;
          if (block.kind === 'heading') return <Text key={index} style={[base, styles[`markdownHeading${block.level}`], blockStyle]}>{content}</Text>;
          if (block.kind === 'bullet' || block.kind === 'ordered') return (
            <View key={index} style={[styles.markdownListRow, blockStyle]}>
              <Text style={[base, styles.markdownListPrefix]}>{block.kind === 'bullet' ? '• ' : block.prefix}</Text>
              <Text style={[base, styles.markdownListText]}>{content}</Text>
            </View>
          );
          if (block.kind === 'quote') return <View key={index} style={[styles.markdownQuote, blockStyle]}><Text style={[base, styles.markdownQuoteText]}>{content}</Text></View>;
          return <Text key={index} style={[base, blockStyle]}>{content}</Text>;
        })}
      </View>
    );
  } catch {
    return <Text style={base}>{typeof raw === 'string' ? raw : ''}</Text>;
  }
}
