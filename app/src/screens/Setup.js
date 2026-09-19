import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { PALETTES } from '../../theme';
import { normalizeServer, ping } from '../api';
import { Button, InlineError } from '../ui';

const { pushStatusLine } = require('../push');

const DEFAULT_SERVER = 'http://your-computer:7777';

export default function Setup({ initialConfig, onCancel, onConnected, onDiagnostics, onForget, onPalette, onRetryPush, paletteId, push, scheme, styles }) {
  const [server, setServer] = useState(initialConfig?.server || '');
  const [token, setToken] = useState(initialConfig?.token || '');
  const [connecting, setConnecting] = useState(false);
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
            setServer('');
            setToken('');
            setError(null);
            Promise.resolve(onForget && onForget()).catch(() => {});
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
    setConnecting(true);
    setError(null);
    try {
      // Check the address and token here so a typo fails on this form rather than
      // as an unexplained blank page inside the console's WebView.
      await ping(config);
      await onConnected(config);
    } catch (connectError) {
      setError({ message: connectError.message || 'Could not connect', screenTail: connectError.screenTail });
    } finally { setConnecting(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.setupOuter}>
      <ScrollView contentContainerStyle={styles.setupContent} keyboardShouldPersistTaps="handled">
        {/* Long-press the title for the diagnostics screens: the terminal parser
            spike lives there, out of the way of anyone setting the app up. */}
        <Text onLongPress={onDiagnostics} style={styles.setupTitle} suppressHighlighting>Connect to Keep</Text>
        <Text style={styles.setupIntro}>Open your Keep console on your phone: what needs you, the fleet, the reviewer, and every terminal.</Text>

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
          <Button loading={connecting} onPress={connect} style={styles.setupAction} styles={styles}>Connect</Button>
        </View>

        {initialConfig ? (
          <>
            <Text style={styles.inputLabel}>Notifications</Text>
            <View style={styles.pushRow}>
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
          </>
        ) : null}

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

        {initialConfig ? (
          <View style={styles.setupActions}>
            <Button onPress={onCancel} quiet style={styles.setupAction} styles={styles}>Cancel</Button>
          </View>
        ) : null}
        {initialConfig && onForget ? (
          <View style={styles.setupActions}>
            <Button onPress={forget} quiet style={styles.setupAction} styles={styles} textStyle={styles.forgetText}>Forget this server</Button>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
