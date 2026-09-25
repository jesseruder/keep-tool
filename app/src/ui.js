import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// The console draws its own interface inside the WebView, so these styles cover only
// what stays native: the boot screen and the setup form. The terminal viewer and the
// console screen build their own sheets from the same palette.
export function makeStyles(colors) {
  const sheet = StyleSheet.create({
    app: { backgroundColor: colors.bg, flex: 1 },
    loadingScreen: { alignItems: 'center', backgroundColor: colors.bg, flex: 1, justifyContent: 'center' },
    screen: { backgroundColor: colors.bg, flex: 1 },
    pressed: { opacity: 0.7 },

    button: { alignItems: 'center', backgroundColor: colors.accent, borderColor: colors.accent, borderRadius: 6, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 14, paddingVertical: 9 },
    buttonQuiet: { backgroundColor: 'transparent', borderColor: colors.line2 },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: colors.accentInk, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    buttonTextQuiet: { color: colors.muted },

    setupOuter: { backgroundColor: colors.bg, flex: 1 },
    setupContent: { flexGrow: 1, paddingBottom: 38, paddingHorizontal: 20, paddingTop: 30 },
    setupTitle: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: 8 },
    setupIntro: { color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 22 },
    inputLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6, marginTop: 13, textTransform: 'uppercase' },
    input: { backgroundColor: colors.panel, borderColor: colors.line2, borderRadius: 6, borderWidth: 1, color: colors.text, fontSize: 15, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10 },
    setupActions: { flexDirection: 'row', gap: 8, marginTop: 18 },
    setupAction: { flex: 1 },
    pushRow: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.line, borderRadius: 6, borderWidth: 1, flexDirection: 'row', minHeight: 48, paddingLeft: 12, paddingRight: 4 },
    pushState: { color: colors.text, flex: 1, fontSize: 13, paddingVertical: 8 },
    pushRetry: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 },
    pushRetryText: { color: colors.info, fontSize: 13, fontWeight: '700' },
    forgetText: { color: colors.bad },
    serverRow: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.line, borderRadius: 6, borderWidth: 1, flexDirection: 'row', minHeight: 48, paddingRight: 4 },
    serverPick: { alignItems: 'center', alignSelf: 'stretch', flex: 1, flexDirection: 'row', paddingHorizontal: 12 },
    serverName: { color: colors.text, flex: 1, fontFamily: mono, fontSize: 12 },
    serverMark: { color: colors.info, fontSize: 12, fontWeight: '700', marginLeft: 8 },
    aboutBox: { backgroundColor: colors.panel, borderColor: colors.line, borderRadius: 6, borderWidth: 1, gap: 4, paddingHorizontal: 12, paddingVertical: 10 },
    aboutLine: { color: colors.text, fontSize: 13 },
    aboutPush: { marginTop: 7 },
    paletteList: { gap: 7, marginTop: 2 },
    paletteOption: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.line, borderRadius: 6, borderWidth: 1, flexDirection: 'row', minHeight: 48, paddingHorizontal: 10 },
    paletteOptionSelected: { borderColor: colors.info, borderWidth: 2 },
    swatches: { flexDirection: 'row', marginRight: 10 },
    swatch: { height: 22, width: 12 },
    paletteName: { color: colors.text, flex: 1, fontSize: 13, fontWeight: '600' },
    paletteCheck: { color: colors.info, fontSize: 15, fontWeight: '700' },

    errorBox: { backgroundColor: colors.badSoft, borderColor: colors.bad, borderLeftWidth: 3, borderRadius: 5, marginTop: 12, padding: 10 },
    errorText: { color: colors.bad, fontSize: 13, fontWeight: '600', lineHeight: 18 },
    monospace: { color: colors.text, fontFamily: mono, fontSize: 11, lineHeight: 17 },
  });
  return { ...sheet, colors };
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
