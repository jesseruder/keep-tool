import Constants from 'expo-constants';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { PALETTES } from '../../theme';
import { normalizeServer, ping } from '../api';
import { Button, InlineError } from '../ui';

const { pushStatusLine } = require('../push');
const { sameServer } = require('../servers');

const DEFAULT_SERVER = 'http://your-computer:7777';

// The version and native build number this binary was built with, from the app
// config embedded at build time (`android.versionCode` / `ios.buildNumber`).
function versionLine() {
  const config = Constants.expoConfig || {};
  const build = Platform.OS === 'android' ? config.android?.versionCode : Platform.OS === 'ios' ? config.ios?.buildNumber : null;
  const version = config.version || 'unknown';
  return build ? `Version ${version} (build ${build})` : `Version ${version}`;
}

export default function Setup({
  initialConfig, onCancel, onConnected, onDiagnostics, onForget, onPalette, onRemoveServer, onRetryPush, paletteId, push,
  savedServers = [], scheme, styles,
}) {
  const [server, setServer] = useState(initialConfig?.server || '');
  const [token, setToken] = useState(initialConfig?.token || '');
  const [connecting, setConnecting] = useState(false);
  const [switchingTo, setSwitchingTo] = useState(null);
  const [changing, setChanging] = useState(false);
  // Connect, a switch and Forget each move push between servers; two at once leave
  // a registration behind on a server nobody is using. State lags a render behind a
  // fast double tap, so the guard is a ref, checked and taken synchronously.
  const busyRef = useRef(false);
  const busy = connecting || !!switchingTo || changing;
  const begin = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    return true;
  };
  const end = () => { busyRef.current = false; };
  // A screen left with Back while its check was in flight must not save what it was
  // asked before: the user may have chosen something else on the Setup opened since.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [retryingPush, setRetryingPush] = useState(false);
  const [error, setError] = useState(null);

  const retryPush = async () => {
    if (!onRetryPush || retryingPush) return;
    setRetryingPush(true);
    try { await onRetryPush(); }
    finally { setRetryingPush(false); }
  };

  const forget = () => {
    Alert.alert(
      'Forget this server?',
      'The saved address and token go, and this phone stops receiving notifications from it.',
      [
        { style: 'cancel', text: 'Cancel' },
        {
          style: 'destructive',
          text: 'Forget',
          onPress: () => {
            if (!begin()) return;
            setServer('');
            setToken('');
            setError(null);
            setChanging(true);
            Promise.resolve(onForget && onForget())
              .catch((forgetError) => setError({ message: forgetError.message || 'Could not forget this server' }))
              .finally(() => { setChanging(false); end(); });
          },
        },
      ],
    );
  };

  // Switching goes through the same check and save as Connect, so push moves with
  // it — and a saved server whose token has gone stale fails here, before the
  // working server is given up.
  const switchTo = async (entry) => {
    if (sameServer(entry, initialConfig) || !begin()) return;
    setSwitchingTo(entry.server);
    setError(null);
    try {
      await ping(entry);
      if (!mountedRef.current) return;
      await onConnected(entry);
    } catch (switchError) {
      setError({ message: switchError.message || 'Could not switch servers', screenTail: switchError.screenTail });
    } finally {
      setSwitchingTo(null);
      end();
    }
  };

  const removeSaved = (entry) => {
    Alert.alert(
      'Remove this server?',
      `${entry.server} comes off this phone's saved list, with its token.`,
      [
        { style: 'cancel', text: 'Cancel' },
        {
          style: 'destructive',
          text: 'Remove',
          onPress: () => {
            if (!begin()) return;
            setChanging(true);
            Promise.resolve(onRemoveServer && onRemoveServer(entry.server))
              .catch((removeError) => setError({ message: removeError.message || 'Could not remove this server' }))
              .finally(() => { setChanging(false); end(); });
          },
        },
      ],
    );
  };

  const connect = async () => {
    const config = { server: normalizeServer(server), token: token.trim() };
    if (!config.server || !config.token) {
      setError({ message: 'Enter both the server URL and token.' });
      return;
    }
    if (!begin()) return;
    setConnecting(true);
    setError(null);
    try {
      // Check the address and token here so a typo fails on this form rather than
      // as an unexplained blank page inside the console's WebView.
      await ping(config);
      if (!mountedRef.current) return;
      await onConnected(config);
    } catch (connectError) {
      setError({ message: connectError.message || 'Could not connect', screenTail: connectError.screenTail });
    } finally {
      setConnecting(false);
      end();
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.setupOuter}>
      <ScrollView contentContainerStyle={styles.setupContent} keyboardShouldPersistTaps="handled">
        {/* Long-press the title for the diagnostics screens: the terminal parser
            spike lives there, out of the way of anyone setting the app up. */}
        <Text onLongPress={onDiagnostics} style={styles.setupTitle} suppressHighlighting>Connect to Keep</Text>
        <Text style={styles.setupIntro}>Open your Keep console on your phone: what needs you, the fleet, the reviewer, and every terminal.</Text>

        {savedServers.length ? (
          <>
            <Text style={styles.inputLabel}>Servers</Text>
            <View style={styles.paletteList}>
              {savedServers.map((entry) => {
                const active = sameServer(entry, initialConfig);
                return (
                  <View key={entry.server} style={[styles.serverRow, active && styles.paletteOptionSelected]}>
                    <Pressable
                      accessibilityLabel={active ? `${entry.server}, active` : `Switch to ${entry.server}`}
                      accessibilityRole="button"
                      disabled={active || busy}
                      onPress={() => switchTo(entry)}
                      style={({ pressed }) => [styles.serverPick, pressed && styles.pressed]}
                    >
                      <Text ellipsizeMode="middle" numberOfLines={1} style={styles.serverName}>{entry.server}</Text>
                      <Text style={styles.serverMark}>{active ? 'Active' : switchingTo === entry.server ? 'Switching…' : ''}</Text>
                    </Pressable>
                    {!active && onRemoveServer ? (
                      <Pressable
                        accessibilityLabel={`Remove ${entry.server}`}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => removeSaved(entry)}
                        style={({ pressed }) => [styles.pushRetry, pressed && styles.pressed]}
                      >
                        <Text style={styles.forgetText}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        <Text style={styles.inputLabel}>Server URL</Text>
        <TextInput autoCapitalize="none" autoCorrect={false} keyboardType="url" onChangeText={setServer} placeholder={DEFAULT_SERVER} placeholderTextColor={styles.colors.faint} style={styles.input} value={server} />
        <Text style={styles.inputLabel}>Token</Text>
        <TextInput autoCapitalize="none" autoCorrect={false} onChangeText={setToken} onSubmitEditing={connect} placeholder="Keep access token" placeholderTextColor={styles.colors.faint} secureTextEntry style={styles.input} value={token} />

        {/* Connect sits with the two fields it reads, not below the whole palette
            list: on a phone the keyboard is up while the token is being typed,
            and the button was off the bottom of the screen behind it. What went
            wrong belongs here too, beside the fields to correct. */}
        <InlineError error={error} styles={styles} />
        <View style={styles.setupActions}>
          <Button disabled={!!switchingTo || changing} loading={connecting} onPress={connect} style={styles.setupAction} styles={styles}>Connect</Button>
        </View>

        <Text style={styles.inputLabel}>Palette · follows system appearance</Text>
        <View style={styles.paletteList}>
          {PALETTES.map((palette) => {
            const tokens = palette[scheme];
            const selected = palette.id === paletteId;
            return (
              <Pressable key={palette.id} onPress={() => onPalette(palette.id)} style={({ pressed }) => [styles.paletteOption, selected && styles.paletteOptionSelected, pressed && styles.pressed]}>
                <View style={styles.swatches}>
                  {[tokens['bar-bg'], tokens.panel, tokens['shead-bg'], tokens.accent].map((color, index) => <View key={`${color}:${index}`} style={[styles.swatch, { backgroundColor: color }]} />)}
                </View>
                <Text style={styles.paletteName}>{palette.name}</Text>
                <Text style={styles.paletteCheck}>{selected ? '✓' : ''}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* About: what this binary is and what it is talking to. Nothing here asks
            the network; the push line is the registration state App.js holds. */}
        <Text style={styles.inputLabel}>About</Text>
        <View style={styles.aboutBox}>
          <Text selectable style={styles.aboutLine}>{versionLine()}</Text>
          <Text ellipsizeMode="middle" numberOfLines={1} selectable style={styles.aboutLine}>
            {initialConfig ? `Server ${initialConfig.server}` : 'Not connected to a server'}
          </Text>
        </View>
        {initialConfig ? (
          <View style={[styles.pushRow, styles.aboutPush]}>
            <Text style={styles.pushState}>{pushStatusLine(push)}</Text>
            {onRetryPush ? (
              <Pressable
                accessibilityLabel="Retry push registration"
                accessibilityRole="button"
                disabled={retryingPush}
                onPress={retryPush}
                style={({ pressed }) => [styles.pushRetry, (pressed || retryingPush) && styles.pressed]}
              >
                <Text style={styles.pushRetryText}>{retryingPush ? 'Retrying…' : 'Retry'}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {initialConfig ? (
          <View style={styles.setupActions}>
            <Button disabled={busy} onPress={onCancel} quiet style={styles.setupAction} styles={styles}>Cancel</Button>
          </View>
        ) : null}
        {initialConfig && onForget ? (
          <View style={styles.setupActions}>
            <Button disabled={busy} onPress={forget} quiet style={styles.setupAction} styles={styles} textStyle={styles.forgetText}>Forget this server</Button>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
