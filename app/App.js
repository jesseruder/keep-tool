import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as BackgroundTask from 'expo-background-task';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import * as TaskManager from 'expo-task-manager';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_PALETTE, themeFor } from './theme';
import * as api from './src/api';
import Console from './src/screens/Console';
import Setup from './src/screens/Setup';
import Spike from './src/screens/Spike';
import Terminal from './src/screens/Terminal';
import { makeStyles } from './src/ui';

const push = require('./src/push');
const { drainShellQueue, queueShellMessage } = require('./src/bridge');

const CONFIG_KEY = '@keep/config';
const NOTIFIED_ATTENTION_KEY = '@keep/notifiedAttention';
const PALETTE_KEY = 'keep.palette';
const ATTENTION_SWEEP_TASK = 'keep-attention-sweep';
const BACKGROUND_ATTENTION_ETAG_KEY = '@keep/backgroundAttentionEtag';
const BACKGROUND_ATTENTION_STATE_KEY = '@keep/backgroundAttentionState';
const NOTIFIED_ATTENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// How often coming back to the app re-checks that the daemon still lists this phone.
const DEVICE_CHECK_MS = 10 * 60 * 1000;

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
    // `local` marks what this app scheduled itself: the notification handler shows
    // those without asking, because the dedupe happened before they were scheduled.
    data: { key: attentionNotificationKey(item), local: true, sessionId: item.sessionId || null },
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
      // The daemon pushes the same rows to a registered phone, so a sweep that ran
      // anyway would notify twice. The task is unregistered when registration
      // succeeds; this is the guard for a pass the OS had already scheduled.
      if (push.isPushActive(await push.readRegistration(AsyncStorage), config?.server)) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      const swept = await sweepAttention(config, { background: true });
      return swept ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
    } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
} catch {}

// Keys announced recently, by either side. `data.local` marks the notifications this
// app scheduled itself, which have already been through the rule below.
const announced = new Map();

let notificationSetup = false;
async function setupNotifications() {
  if (notificationSetup) return;
  notificationSetup = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification?.request?.content?.data || {};
        // A push that arrives while the app is open, for something the console has
        // already announced, is shown once. Ours are let through unexamined: they
        // claimed their key when they were scheduled.
        const show = data.local === true || push.claimNotification(announced, data.key);
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show,
          shouldSetBadge: false,
        };
      },
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
}

// Permission is asked for once, by the registration pass — push and the sweep's own
// local notifications need the same grant, so a phone that cannot register still
// ends up able to show what the sweep finds.
async function ensureNotificationPermission() {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current?.granted || current?.status === 'granted') return 'granted';
    if (current?.canAskAgain === false) return 'denied';
    const asked = await Notifications.requestPermissionsAsync();
    return asked?.granted || asked?.status === 'granted' ? 'granted' : 'denied';
  } catch { return 'denied'; }
}

// The EAS project the token is minted for. A build without one — a bare Expo Go run —
// cannot get a push token at all, and says so on Setup rather than failing silently.
function easProjectId() {
  return Constants.expoConfig?.extra?.eas?.projectId
    || Constants.easConfig?.projectId
    || '';
}

async function expoPushToken() {
  const projectId = easProjectId();
  if (!projectId) throw new Error('this build has no EAS project id');
  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  return result?.data || '';
}

// The 15-minute sweep is the fallback for a phone push cannot reach. It is kept, not
// deleted, so a denied permission or an unreachable daemon still notifies.
async function applySweepTask(enabled) {
  try {
    if (enabled) await BackgroundTask.registerTaskAsync(ATTENTION_SWEEP_TASK, { minimumInterval: 15 });
    else await BackgroundTask.unregisterTaskAsync(ATTENTION_SWEEP_TASK);
  } catch {}
}

// The console owns the count; the shell only forwards changes to the launcher.
let lastBadgeCount = null;
async function applyBadge(count) {
  if (count === lastBadgeCount) return;
  lastBadgeCount = count;
  try { await Notifications.setBadgeCountAsync(count); }
  catch {}
}

// The console raises its own notification for a row that starts waiting, and
// `bin/attention-push.js` pushes the same rows from the daemon. `shouldNotifyLocally`
// is the rule for which of the two this phone actually shows.
let pushIsLive = false;

async function notifyFromConsole(message) {
  if (!push.shouldNotifyLocally(announced, { key: message.key, pushActive: pushIsLive })) return;
  await setupNotifications();
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: message.title,
        body: message.body,
        sound: 'default',
        data: { local: true, ...(message.key ? { key: message.key } : {}) },
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
  const [pushState, setPushState] = useState({ status: 'idle', sweep: true });
  const consoleRef = useRef(null);
  // A notification tapped from a cold start arrives before the WebView exists, so
  // the message waits here until the console takes it.
  const pendingRef = useRef([]);
  // Bumped whenever the config this phone is registered under goes away, so a
  // registration still in flight knows it no longer speaks for anything.
  const pushGenRef = useRef(0);
  const verifiedAtRef = useRef(0);

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

  // A message is only off the queue once the console has actually taken it. `send`
  // refuses until the page has posted `ready`, and the Console screen re-registers on
  // every `ready`, which is what brings the drain back around.
  const drainConsole = useCallback(() => {
    const instance = consoleRef.current;
    if (!instance || !pendingRef.current.length) return;
    pendingRef.current = drainShellQueue(pendingRef.current, (message) => {
      try { return instance.send(message); }
      catch { return false; }
    });
  }, []);

  const toConsole = useCallback((message) => {
    pendingRef.current = queueShellMessage(pendingRef.current, message);
    drainConsole();
  }, [drainConsole]);

  const registerConsole = useCallback((instance) => {
    consoleRef.current = instance;
    drainConsole();
  }, [drainConsole]);

  // Registration: on every launch with a saved config, and again when Setup saves
  // one. `force` is Setup's Retry, which re-registers even when the record is fresh.
  //
  // Every pass carries the generation it started in. Forgetting a server, or moving
  // to another one, bumps it, and a pass that finds itself superseded writes nothing
  // — otherwise a POST that was already in flight when Forget sent its DELETE would
  // land afterwards and quietly register the phone all over again.
  const syncPush = useCallback(async (target, { force = false } = {}) => {
    const generation = pushGenRef.current;
    const isCurrent = () => pushGenRef.current === generation;
    const next = await push.syncRegistration({
      appVersion: Constants.expoConfig?.version || Constants.nativeAppVersion || '',
      config: target,
      force,
      getToken: expoPushToken,
      isCurrent,
      permission: ensureNotificationPermission,
      platform: Platform.OS,
      post: api.registerDevice,
      remove: api.unregisterDevice,
      storage: AsyncStorage,
    });
    if (!isCurrent() || next.status === 'superseded') return next;
    pushIsLive = next.status === 'registered';
    setPushState(next);
    await applySweepTask(next.sweep);
    return next;
  }, []);

  // Notifications, registration, the background sweep, and the once-per-launch
  // baseline. The baseline runs whether or not push is live: it records what is
  // already waiting without announcing it, so if registration ever fails later the
  // sweep that takes over does not fire for the whole backlog.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    (async () => {
      await setupNotifications();
      if (cancelled) return;
      try { await syncPush(config); }
      catch {}
      if (cancelled) return;
      try { await sweepAttention(config, { baseline: true }); }
      catch {}
    })();
    return () => { cancelled = true; };
  }, [config, syncPush]);

  // The launcher badge can be moved behind the app's back by a push that arrived
  // while it was away, so coming back to the foreground forgets what was applied and
  // the console's next `badge` message wins.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      lastBadgeCount = null;
      // Pushes delivered while the app was away were shown by the system, with
      // nothing running to record them. Claiming what is still in the tray keeps the
      // console from announcing the same rows a second time now that it is back.
      Notifications.getPresentedNotificationsAsync().then((shown) => {
        for (const item of shown || []) push.claimNotification(announced, item?.request?.content?.data?.key);
      }).catch(() => {});

      // And ask the daemon whether it still holds this phone. A device evicted by the
      // 16-device cap, or lost with `.keep/devices.json`, leaves a record here that
      // looks perfectly good and a phone that never hears anything again.
      const now = Date.now();
      if (!config || now - verifiedAtRef.current < DEVICE_CHECK_MS) return;
      verifiedAtRef.current = now;
      const generation = pushGenRef.current;
      push.verifyRegistration({
        config,
        isCurrent: () => pushGenRef.current === generation,
        list: api.listDevices,
        storage: AsyncStorage,
      }).then((result) => {
        if (!result.checked || result.present || pushGenRef.current !== generation) return;
        pushIsLive = false;
        return syncPush(config, { force: true });
      }).catch(() => {});
    });
    return () => subscription.remove();
  }, [config, syncPush]);

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
    // Moving to another server: the old daemon still holds this phone, and only the
    // config being replaced can authenticate the removal, so it happens here.
    if (config?.server && api.normalizeServer(config.server) !== api.normalizeServer(next.server)) {
      pushGenRef.current += 1;
      await push.unregisterDevice({ config, remove: api.unregisterDevice, storage: AsyncStorage });
      pushIsLive = false;
    }
    await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    lastBadgeCount = null;
    setConfig(next);
  }, [config]);

  // Forget: unregister from the daemon best-effort, then drop the config. The sweep
  // goes with it — there is no server left for it to read.
  const forgetConfig = useCallback(async () => {
    // Before the DELETE, not after: a registration in flight has to be superseded
    // while it can still be stopped from writing the record back.
    pushGenRef.current += 1;
    verifiedAtRef.current = 0;
    if (config) await push.unregisterDevice({ config, remove: api.unregisterDevice, storage: AsyncStorage });
    pushIsLive = false;
    await applySweepTask(false);
    try { await AsyncStorage.multiRemove([CONFIG_KEY, NOTIFIED_ATTENTION_KEY, BACKGROUND_ATTENTION_ETAG_KEY, BACKGROUND_ATTENTION_STATE_KEY]); }
    catch {}
    lastBadgeCount = null;
    applyBadge(0);
    setPushState({ status: 'idle', sweep: true });
    setConfig(null);
  }, [config]);

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
                onForget={async () => {
                  await forgetConfig();
                  // The Console screen underneath has no server left to load.
                  nav.reset({ index: 0, routes: [{ name: 'Setup' }] });
                }}
                onPalette={changePalette}
                onRetryPush={config ? () => syncPush(config, { force: true }) : undefined}
                paletteId={paletteId}
                push={pushState}
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
