import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { PALETTES } from '../../theme';
import { getState, normalizeServer } from '../api';
import { Button, InlineError } from '../ui';

const DEFAULT_SERVER = 'http://your-computer:7777';

export default function Setup({ initialConfig, onCancel, onConnected, onPalette, paletteId, scheme, styles }) {
  const [server, setServer] = useState(initialConfig?.server || '');
  const [token, setToken] = useState(initialConfig?.token || '');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const connect = async () => {
    const config = { server: normalizeServer(server), token: token.trim() };
    if (!config.server || !config.token) {
      setError({ message: 'Enter both the server URL and token.' });
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const state = await getState(config);
      await onConnected(config, state);
    } catch (connectError) {
      setError({ message: connectError.message || 'Could not connect', screenTail: connectError.screenTail });
    } finally { setConnecting(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.setupOuter}>
      <ScrollView contentContainerStyle={styles.setupContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.setupTitle}>Connect to Keep</Text>
        <Text style={styles.setupIntro}>See what needs you, follow the fleet, and check the reviewer from your phone.</Text>

        <Text style={styles.inputLabel}>Server URL</Text>
        <TextInput autoCapitalize="none" autoCorrect={false} keyboardType="url" onChangeText={setServer} placeholder={DEFAULT_SERVER} placeholderTextColor={styles.colors.faint} style={styles.input} value={server} />
        <Text style={styles.inputLabel}>Token</Text>
        <TextInput autoCapitalize="none" autoCorrect={false} onChangeText={setToken} onSubmitEditing={connect} placeholder="Keep access token" placeholderTextColor={styles.colors.faint} secureTextEntry style={styles.input} value={token} />

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

        <InlineError error={error} styles={styles} />
        <View style={styles.setupActions}>
          {initialConfig ? <Button onPress={onCancel} quiet style={styles.setupAction} styles={styles}>Cancel</Button> : null}
          <Button loading={connecting} onPress={connect} style={styles.setupAction} styles={styles}>Connect</Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
