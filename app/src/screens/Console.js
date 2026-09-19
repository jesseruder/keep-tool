import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';

const { bootstrapScript, consoleUrl, dispatchBridgeMessage, shellReceiveScript } = require('../bridge');

// A console that never posts `ready` — an older daemon, or one whose scripts fail —
// still has to become usable, so the overlay lifts shortly after the page loads.
const READY_GRACE_MS = 2500;

function makeConsoleStyles(colors) {
  return StyleSheet.create({
    root: { backgroundColor: colors.bg, flex: 1 },
    bar: { alignItems: 'center', backgroundColor: colors.barBg, borderBottomColor: colors.barLine, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 4, minHeight: 36, paddingLeft: 12, paddingRight: 2 },
    barHost: { color: colors.barMuted, flex: 1, fontSize: 11 },
    barButton: { alignItems: 'center', justifyContent: 'center', minHeight: 36, width: 40 },
    barButtonText: { color: colors.barMuted, fontSize: 17 },
    pressed: { opacity: 0.6 },
    web: { backgroundColor: colors.bg, flex: 1 },
    overlay: { alignItems: 'center', backgroundColor: colors.bg, bottom: 0, justifyContent: 'center', left: 0, padding: 28, position: 'absolute', right: 0, top: 0 },
    overlayText: { color: colors.muted, fontSize: 13, marginTop: 14, textAlign: 'center' },
    errorTitle: { color: colors.text, fontSize: 19, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
    errorText: { color: colors.bad, fontSize: 13, lineHeight: 19, marginBottom: 20, textAlign: 'center' },
    errorActions: { flexDirection: 'row', gap: 10 },
    action: { alignItems: 'center', backgroundColor: colors.accent, borderColor: colors.accent, borderRadius: 6, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 18 },
    actionQuiet: { backgroundColor: 'transparent', borderColor: colors.line2 },
    actionText: { color: colors.accentInk, fontSize: 13, fontWeight: '700' },
    actionTextQuiet: { color: colors.muted },
  });
}

function originOf(url) {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
  return match ? match[1].toLowerCase() : '';
}

export default function Console({ colors, config, onBadge, onNotify, onOpenSetup, onOpenTerminal, registerConsole }) {
  const styles = useMemo(() => makeConsoleStyles(colors), [colors]);
  const webRef = useRef(null);
  const readyRef = useRef(false);
  const canGoBackRef = useRef(false);
  const graceRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const uri = useMemo(() => consoleUrl(config.server, config.token), [config.server, config.token]);
  const origin = useMemo(() => originOf(uri), [uri]);
  const source = useMemo(() => ({ uri }), [uri]);
  const bootstrap = useMemo(() => bootstrapScript({
    platform: Platform.OS,
    version: Constants.expoConfig?.version || Constants.nativeAppVersion || '',
  }), []);

  useEffect(() => () => { if (graceRef.current) clearTimeout(graceRef.current); }, []);

  const send = useCallback((message) => {
    if (!webRef.current) return false;
    webRef.current.injectJavaScript(shellReceiveScript(message));
    return true;
  }, []);

  const hardReload = useCallback(() => {
    readyRef.current = false;
    canGoBackRef.current = false;
    setError(null);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  // A console that is up redraws itself from the `reload` message, which keeps its
  // scroll position and open panes; one that never came up needs the real reload.
  const reload = useCallback(() => {
    if (!error && readyRef.current && send({ type: 'reload' })) return;
    hardReload();
  }, [error, hardReload, send]);

  useEffect(() => {
    registerConsole({ send, reload, hardReload });
    return () => registerConsole(null);
  }, [hardReload, registerConsole, reload, send]);

  // The console is a full app with its own history; the hardware back button walks
  // that first and only then falls through to the navigator.
  useFocusEffect(useCallback(() => {
    const onBack = () => {
      if (canGoBackRef.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  }, []));

  const onMessage = useCallback((event) => {
    dispatchBridgeMessage(event.nativeEvent?.data, {
      ready: () => {
        readyRef.current = true;
        if (graceRef.current) clearTimeout(graceRef.current);
        setLoading(false);
        setError(null);
      },
      badge: onBadge,
      notify: onNotify,
      openTerminal: onOpenTerminal,
      openExternal: (message) => { Linking.openURL(message.url).catch(() => {}); },
    });
  }, [onBadge, onNotify, onOpenTerminal]);

  const failed = useCallback((description) => {
    if (graceRef.current) clearTimeout(graceRef.current);
    readyRef.current = false;
    setLoading(false);
    setError(String(description || '').trim() || 'The console could not be loaded.');
  }, []);

  // Anything that is not the daemon's own origin belongs to the phone's browser or
  // mail client, not to this WebView.
  const onShouldStartLoadWithRequest = useCallback((request) => {
    const url = String(request.url || '');
    if (!/^https?:/i.test(url)) {
      if (!/^about:/i.test(url)) Linking.openURL(url).catch(() => {});
      return /^about:/i.test(url);
    }
    if (originOf(url) === origin) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  }, [origin]);

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Text numberOfLines={1} style={styles.barHost}>{origin.replace(/^https?:\/\//, '') || config.server}</Text>
        <Pressable
          accessibilityLabel="Reload the console"
          accessibilityRole="button"
          onLongPress={hardReload}
          onPress={reload}
          style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
        >
          <Text style={styles.barButtonText}>⟳</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Connection and palette settings"
          accessibilityRole="button"
          onPress={onOpenSetup}
          style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
        >
          <Text style={styles.barButtonText}>⚙</Text>
        </Pressable>
      </View>

      <WebView
        allowsBackForwardNavigationGestures
        applicationNameForUserAgent="KeepShell"
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        onError={(event) => failed(event.nativeEvent?.description)}
        onHttpError={(event) => {
          const { statusCode, url } = event.nativeEvent || {};
          if (Number(statusCode) >= 400 && originOf(url) === origin) {
            failed(`The server answered ${statusCode}. The saved token may no longer be valid.`);
          }
        }}
        onLoadEnd={() => {
          if (graceRef.current) clearTimeout(graceRef.current);
          graceRef.current = setTimeout(() => setLoading(false), READY_GRACE_MS);
        }}
        onLoadStart={() => setLoading(true)}
        onMessage={onMessage}
        onNavigationStateChange={(state) => { canGoBackRef.current = Boolean(state.canGoBack); }}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        originWhitelist={['http://*', 'https://*']}
        ref={webRef}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled
        source={source}
        style={styles.web}
        thirdPartyCookiesEnabled
      />

      {error ? (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Can’t reach the console</Text>
          <Text style={styles.errorText}>{error}</Text>
          <View style={styles.errorActions}>
            <Pressable accessibilityRole="button" onPress={hardReload} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <Text style={styles.actionText}>Retry</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onOpenSetup} style={({ pressed }) => [styles.action, styles.actionQuiet, pressed && styles.pressed]}>
              <Text style={[styles.actionText, styles.actionTextQuiet]}>Setup</Text>
            </Pressable>
          </View>
        </View>
      ) : loading ? (
        <View pointerEvents="none" style={styles.overlay}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.overlayText}>Loading the console…</Text>
        </View>
      ) : null}
    </View>
  );
}
