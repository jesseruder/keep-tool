import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';

const {
  bootstrapScript, bootstrapState, consoleUrl, decideBootstrap,
  dispatchBridgeMessage, helloScript, shellReceiveScript,
} = require('../bridge');

// A console that never posts `ready` — an older daemon, or one whose scripts fail —
// still has to become usable, so the overlay lifts shortly after the page loads.
const READY_GRACE_MS = 2500;
const TOKEN_ERROR = 'The console would not accept the saved session. Check the token in Setup.';

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
  // The depth of the console's current history entry over the page it loaded on.
  // The WebView's own canGoBack and goBack skip an entry the page pushed without a
  // user gesture (Chromium's history intervention), which is how a notification tap
  // opens a stage, so while the console reports depth Back runs the page's own
  // history.back(), which does not skip.
  const consoleDepthRef = useRef(0);
  const graceRef = useRef(null);
  const retryRef = useRef(null);
  const triggerRef = useRef(null);
  const bootstrapRef = useRef(bootstrapState());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumped by every `ready`. The shell holds messages for a console that is not up
  // yet, and this is what tells it to hand them over.
  const [readyTick, setReadyTick] = useState(0);
  // Every load of the WebView is a bootstrap: the source is always the `?token=`
  // URL, so remounting is how the shell asks the daemon for a fresh session.
  const [bootstrapKey, setBootstrapKey] = useState(0);

  const uri = useMemo(() => consoleUrl(config.server, config.token), [config.server, config.token]);
  const origin = useMemo(() => originOf(uri), [uri]);
  const source = useMemo(() => ({ uri }), [uri]);
  const injection = useMemo(() => ({
    platform: Platform.OS,
    version: Constants.expoConfig?.version || Constants.nativeAppVersion || '',
  }), []);
  const bootstrap = useMemo(() => bootstrapScript(injection), [injection]);
  const hello = useMemo(() => helloScript(injection), [injection]);

  useEffect(() => () => {
    if (graceRef.current) clearTimeout(graceRef.current);
    if (retryRef.current) clearTimeout(retryRef.current);
  }, []);

  const loadBootstrap = useCallback(() => {
    if (graceRef.current) clearTimeout(graceRef.current);
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
    readyRef.current = false;
    canGoBackRef.current = false;
    consoleDepthRef.current = 0;
    setError(null);
    setLoading(true);
    setBootstrapKey((value) => value + 1);
  }, []);

  // Every re-bootstrap trigger goes through the same decision, so the interval, the
  // ceiling and the failure count cannot be sidestepped by whichever one fires.
  const trigger = useCallback((reason, extra = {}) => {
    const { action, state, retryAt } = decideBootstrap(bootstrapRef.current, { reason, ...extra });
    bootstrapRef.current = state;
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
    if (action === 'bootstrap') loadBootstrap();
    else if (action === 'show-error') {
      if (graceRef.current) clearTimeout(graceRef.current);
      setLoading(false);
      setError(TOKEN_ERROR);
    } else if (retryAt) {
      // A refusal the interval postponed still has to happen, or a second daemon
      // restart inside ten seconds is simply lost.
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        triggerRef.current?.('retry');
      }, Math.max(0, retryAt - Date.now()));
    }
    return action;
  }, [loadBootstrap]);

  useEffect(() => { triggerRef.current = trigger; }, [trigger]);

  // A page that has not said `ready` has no `window.keepShellReceive`, so the
  // injection would be swallowed without a trace — which is exactly the cold start a
  // notification tap arrives in. Refusing here is what makes the shell queue it.
  const send = useCallback((message) => {
    if (!webRef.current || !readyRef.current) return false;
    webRef.current.injectJavaScript(shellReceiveScript(message));
    return true;
  }, []);

  // Asked for by hand, so it starts over: the failure count, the ceiling, and the
  // one-shot exemption all reset. A person pressing Retry is not a loop.
  const hardReload = useCallback(() => {
    bootstrapRef.current = bootstrapState();
    loadBootstrap();
  }, [loadBootstrap]);

  // A console that is up redraws itself from the `reload` message, which keeps its
  // scroll position and open panes; one that never came up needs the real load.
  const reload = useCallback(() => {
    if (!error && readyRef.current && send({ type: 'reload' })) return;
    hardReload();
  }, [error, hardReload, send]);

  useEffect(() => {
    registerConsole({ send, reload, hardReload });
    return () => registerConsole(null);
  }, [hardReload, readyTick, registerConsole, reload, send]);

  // Sessions live in the daemon's memory alone, so a long spell in the background is
  // reason enough to expect the session to be gone by the time the app is back.
  useEffect(() => {
    let awayAt = 0;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (awayAt) trigger('foreground', { awayMs: Date.now() - awayAt });
        awayAt = 0;
      } else if (!awayAt) awayAt = Date.now();
    });
    return () => subscription.remove();
  }, [trigger]);

  // Dismissing the keyboard (Back, or the keyboard's own hide key) leaves the page's
  // field focused, and a WebView does not raise the keyboard again for a tap on a field
  // that is already focused: the reply box went dead until the stage was reopened. So
  // the field is let go when the keyboard goes, and the next tap is a fresh focus.
  // (Android 10 and earlier with adjustResize send no keyboardDidHide, so there the
  // field is not let go; the window still resizes, so the box is at least not hidden.)
  useFocusEffect(useCallback(() => {
    let pending = null;
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      // A hide that is only a moment (a rotation, the keyboard switching) is followed by
      // a show; the field the user is typing into must not be let go then.
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        if (Keyboard.isVisible()) return;
        webRef.current?.injectJavaScript(
          "(function(){var a=document.activeElement;if(a&&a!==document.body&&typeof a.blur==='function'&&/^(INPUT|TEXTAREA)$/.test(a.tagName))a.blur();})(); true;",
        );
      }, 250);
    });
    return () => { hidden.remove(); if (pending) clearTimeout(pending); };
  }, []));

  // The console is a full app with its own history; the hardware back button walks
  // that first and only then falls through to the navigator.
  useFocusEffect(useCallback(() => {
    const onBack = () => {
      if (consoleDepthRef.current > 0 && webRef.current) {
        // Counted down here too, so a report that never comes (or a second press
        // before it does) costs one press at most, never a stuck Back button.
        consoleDepthRef.current -= 1;
        webRef.current.injectJavaScript('history.back(); true;');
        return true;
      }
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
      // `ready` arrives again whenever the console answers a `hello`, so it has to
      // be safe to repeat — and it says only that the page's scripts ran, which is
      // no evidence at all that the session behind them works.
      ready: () => {
        readyRef.current = true;
        if (graceRef.current) clearTimeout(graceRef.current);
        setLoading(false);
        setError(null);
        setReadyTick((value) => value + 1);
      },
      // The daemon answered a real request: the session is good, once per page load.
      authenticated: () => trigger('authenticated'),
      unauthorized: () => trigger('unauthorized'),
      history: (message) => { consoleDepthRef.current = message.depth; },
      badge: onBadge,
      notify: onNotify,
      openTerminal: onOpenTerminal,
      openExternal: (message) => { Linking.openURL(message.url).catch(() => {}); },
    });
  }, [onBadge, onNotify, onOpenTerminal, trigger]);

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
        key={bootstrapKey}
        mediaPlaybackRequiresUserAction={false}
        onError={(event) => failed(event.nativeEvent?.description)}
        onHttpError={(event) => {
          const { statusCode, url } = event.nativeEvent || {};
          if (originOf(url) !== origin) return;
          // The WebView reports HTTP errors for the top frame only, so a 403 here is
          // the session, not a stray request the console made.
          if (Number(statusCode) === 403) trigger('unauthorized');
          else if (Number(statusCode) >= 400) failed(`The server answered ${statusCode}.`);
        }}
        onLoadEnd={() => {
          webRef.current?.injectJavaScript(hello);
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
