import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import * as TaskManager from 'expo-task-manager';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_PALETTE, themeFor } from './theme';
import * as api from './src/api';
import Console from './src/screens/Console';
import Setup from './src/screens/Setup';
import Spike from './src/screens/Spike';
import Terminal from './src/screens/Terminal';
import { makeStyles } from './src/ui';

const CONFIG_KEY = '@keep/config';
const NOTIFIED_ATTENTION_KEY = '@keep/notifiedAttention';
const PALETTE_KEY = 'keep.palette';
const ATTENTION_SWEEP_TASK = 'keep-attention-sweep';
const BACKGROUND_ATTENTION_ETAG_KEY = '@keep/backgroundAttentionEtag';
const BACKGROUND_ATTENTION_STATE_KEY = '@keep/backgroundAttentionState';
const NOTIFIED_ATTENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function projName(project) {
  return project ? String(project).split('/').filter(Boolean).pop() || '' : '';
}

function attentionNotificationKey(item) {
  return `${item.kind}:${item.sessionId}:${item.since}`;
}

function clipNotificationText(value, maxLength = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function attentionNotificationContent(item) {
  let body = '';
  if (item.kind === 'question') {
    const options = Array.isArray(item.options) ? item.options : [];
    body = `${item.question || ''}${options.length ? ` — ${options.join(' / ')}` : ''}`;
  } else if (item.kind === 'plan') {
    body = 'Plan ready for approval';
  } else if (item.kind === 'permission') {
    body = item.detail || '';
  }

  return {
    title: `Keep — ${projName(item.project) || 'Keep'}`,
    // Health items reach this path too (a failing scheduler is pri 0); without the
    // fallback they arrive as a title with no body at all.
    body: clipNotificationText(body || item.detail || item.text || ''),
    sound: 'default',
    // The sweep has no key of the console's own, so a tap carries the key it builds
    // plus the session id; the console resolves whichever of the two it knows.
    data: { key: attentionNotificationKey(item), sessionId: item.sessionId || null },
  };
}

const QUIET_HOURS_END = 8; // no notifications before 8am device time; held items deliver after

async function diffAndNotifyAttention(state, baseline = false, background = false) {
  try {
    const now = Date.now();
    const quiet = new Date().getHours() < QUIET_HOURS_END;
    // Quiet hours: in the background, hold entirely (unrecorded → delivered by the
    // first pass after 8am). In the foreground the items are on screen, so record
    // them silently — same as baseline.
    if (quiet && background && !baseline) return;
    if (quiet) baseline = true;
    const cutoff = now - NOTIFIED_ATTENTION_TTL_MS;
    let notified = {};
    let mapChanged = false;

    try {
      const saved = await AsyncStorage.getItem(NOTIFIED_ATTENTION_KEY);
      const parsed = saved ? JSON.parse(saved) : {};
      const entries = Object.entries(parsed || {});
      notified = Object.fromEntries(entries.filter(([, timestamp]) => Number(timestamp) >= cutoff));
      mapChanged = Object.keys(notified).length !== entries.length;
    } catch { notified = {}; }

    const items = (state?.attention || []).filter((item) => Number(item.pri) === 0 && !item.setAside);
    for (const item of items) {
      const key = attentionNotificationKey(item);
      if (notified[key]) continue;
      if (baseline) {
        notified[key] = now;
        mapChanged = true;
        continue;
      }
      try {
        await Notifications.scheduleNotificationAsync({
          content: attentionNotificationContent(item),
          trigger: { channelId: 'attention' },
        });
        notified[key] = now;
        mapChanged = true;
      } catch {}
    }

    if (mapChanged) {
      try { await AsyncStorage.setItem(NOTIFIED_ATTENTION_KEY, JSON.stringify(notified)); }
      catch {}
    }
  } catch {}
}

// Shared by the background task and the once-per-launch baseline, so both read the
// same etag-cached view and neither re-announces what the other already recorded.
async function sweepAttention(config, { baseline = false, background = false } = {}) {
  if (!config?.server || !config?.token) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    const [etag, cachedState] = await Promise.all([
      AsyncStorage.getItem(BACKGROUND_ATTENTION_ETAG_KEY),
      AsyncStorage.getItem(BACKGROUND_ATTENTION_STATE_KEY),
    ]);
    const headers = { 'x-keep': '1', 'x-keep-token': config.token };
    if (etag) headers['if-none-match'] = etag;
    response = await fetch(`${api.normalizeServer(config.server)}/api/state?view=notifications`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304) {
      if (!cachedState) {
        await AsyncStorage.removeItem(BACKGROUND_ATTENTION_ETAG_KEY);
        return false;
      }
      await diffAndNotifyAttention(JSON.parse(cachedState), baseline, background);
      return true;
    }
  } finally { clearTimeout(timeout); }

  if (!response.ok) return false;
  const state = await response.json();
  await Promise.all([
    response.headers.get('etag') ? AsyncStorage.setItem(BACKGROUND_ATTENTION_ETAG_KEY, response.headers.get('etag')) : Promise.resolve(),
    AsyncStorage.setItem(BACKGROUND_ATTENTION_STATE_KEY, JSON.stringify(state)),
  ]);
  await diffAndNotifyAttention(state, baseline, background);
  return true;
}

try {
  TaskManager.defineTask(ATTENTION_SWEEP_TASK, async () => {
    try {
      const savedConfig = await AsyncStorage.getItem(CONFIG_KEY);
      const config = savedConfig ? JSON.parse(savedConfig) : null;
      const swept = await sweepAttention(config, { background: true });
      return swept ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
    } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
} catch {}

let notificationSetup = false;
async function setupNotifications() {
  if (notificationSetup) return;
  notificationSetup = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {}
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('attention', {
        name: 'Needs you',
        importance: Notifications.AndroidImportance.HIGH,
      });
    } catch {}
  }
  try { await Notifications.requestPermissionsAsync(); }
  catch {}
}

// The console owns the count; the shell only forwards changes to the launcher.
let lastBadgeCount = null;
async function applyBadge(count) {
  if (count === lastBadgeCount) return;
  lastBadgeCount = count;
  try { await Notifications.setBadgeCountAsync(count); }
  catch {}
}

async function notifyFromConsole(message) {
  await setupNotifications();
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: message.title,
        body: message.body,
        sound: 'default',
        ...(message.key ? { data: { key: message.key } } : {}),
      },
      trigger: { channelId: 'attention' },
    });
  } catch {}
}

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <SafeAreaProvider>
      <KeepShell />
    </SafeAreaProvider>
  );
}

function Frame({ background, children }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: background, flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
      {children}
    </View>
  );
}

function KeepShell() {
  const colorScheme = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE);
  const colors = useMemo(() => themeFor(paletteId, scheme), [paletteId, scheme]);
  const terminalColors = useMemo(() => themeFor(paletteId, 'dark'), [paletteId]);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [booting, setBooting] = useState(true);
  const [config, setConfig] = useState(null);
  const consoleRef = useRef(null);
  // A notification tapped from a cold start arrives before the WebView exists, so
  // the message waits here until the console registers itself.
  const pendingRef = useRef([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [savedConfig, savedPalette] = await Promise.all([
          AsyncStorage.getItem(CONFIG_KEY),
          AsyncStorage.getItem(PALETTE_KEY),
        ]);
        if (cancelled) return;
        if (savedPalette) setPaletteId(savedPalette);
        const nextConfig = savedConfig ? JSON.parse(savedConfig) : null;
        if (nextConfig?.server && nextConfig?.token) {
          nextConfig.server = api.normalizeServer(nextConfig.server);
          setConfig(nextConfig);
        }
      } catch {}
      finally { if (!cancelled) setBooting(false); }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const toConsole = useCallback((message) => {
    if (consoleRef.current?.send(message)) return;
    pendingRef.current = [...pendingRef.current.slice(-4), message];
  }, []);

  const registerConsole = useCallback((instance) => {
    consoleRef.current = instance;
    if (!instance || !pendingRef.current.length) return;
    const queued = pendingRef.current;
    pendingRef.current = [];
    for (const message of queued) instance.send(message);
  }, []);

  // Notifications, the background sweep, and the once-per-launch baseline. The
  // baseline records what is already waiting without announcing it, so the first
  // sweep after a fresh install does not fire for the whole backlog.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    (async () => {
      await setupNotifications();
      if (cancelled) return;
      try { await BackgroundTask.registerTaskAsync(ATTENTION_SWEEP_TASK, { minimumInterval: 15 }); }
      catch {}
      try { await sweepAttention(config, { baseline: true }); }
      catch {}
    })();
    return () => { cancelled = true; };
  }, [config]);

  useEffect(() => {
    const deliver = (response) => {
      const data = response?.notification?.request?.content?.data;
      const key = data?.key || data?.sessionId;
      if (key) toConsole({ type: 'notificationClick', key: String(key) });
    };
    // A tap that launched the app is only available through this one-shot lookup.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) deliver(response);
    }).catch(() => {});
    const subscription = Notifications.addNotificationResponseReceivedListener(deliver);
    return () => subscription.remove();
  }, [toConsole]);

  const saveConfig = useCallback(async (next) => {
    await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    lastBadgeCount = null;
    setConfig(next);
  }, []);

  const changePalette = useCallback((next) => {
    setPaletteId(next);
    AsyncStorage.setItem(PALETTE_KEY, next).catch(() => {});
  }, []);

  const navigationTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: colors.bg,
        border: colors.line,
        card: colors.barBg,
        primary: colors.accent,
        text: colors.text,
      },
    };
  }, [colors, scheme]);

  if (booting) {
    return (
      <View style={[styles.loadingScreen, { backgroundColor: colors.barBg }]}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.barText} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName={config ? 'Console' : 'Setup'}
        screenOptions={{ animation: 'slide_from_right', headerShown: false }}
      >
        <Stack.Screen name="Console">
          {({ navigation: nav }) => (
            <Frame background={colors.barBg}>
              {config ? (
                <Console
                  colors={colors}
                  config={config}
                  key={`${config.server}\n${config.token}`}
                  onBadge={(message) => { applyBadge(message.count); }}
                  onNotify={(message) => { notifyFromConsole(message); }}
                  onOpenSetup={() => nav.navigate('Setup')}
                  onOpenTerminal={(message) => nav.navigate('Terminal', { target: message })}
                  registerConsole={registerConsole}
                />
              ) : (
                <View style={styles.loadingScreen}><ActivityIndicator color={colors.barText} /></View>
              )}
            </Frame>
          )}
        </Stack.Screen>

        <Stack.Screen name="Terminal">
          {({ navigation: nav, route }) => (
            <Frame background={terminalColors.barBg}>
              <Terminal
                colors={terminalColors}
                config={config}
                onBack={() => nav.goBack()}
                target={route.params?.target}
              />
            </Frame>
          )}
        </Stack.Screen>

        <Stack.Screen name="Spike">
          {({ navigation: nav }) => (
            <Frame background={colors.barBg}>
              <Spike colors={colors} onBack={() => nav.goBack()} styles={styles} />
            </Frame>
          )}
        </Stack.Screen>

        <Stack.Screen name="Setup">
          {({ navigation: nav }) => (
            <Frame background={colors.barBg}>
              <Setup
                initialConfig={config}
                onCancel={nav.canGoBack() ? () => nav.goBack() : undefined}
                onConnected={async (next) => {
                  await saveConfig(next);
                  if (nav.canGoBack()) nav.goBack();
                  else nav.replace('Console');
                }}
                onDiagnostics={() => nav.navigate('Spike')}
                onPalette={changePalette}
                paletteId={paletteId}
                scheme={scheme}
                styles={styles}
              />
            </Frame>
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}
