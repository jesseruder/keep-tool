import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import * as TaskManager from 'expo-task-manager';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  BackHandler,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_PALETTE, themeFor } from './theme';
import * as api from './src/api';
import {
  eventKey,
  pinnedItems,
  queueItems,
  recentItems,
  sessionItem,
  snoozeId,
  visibleQueue,
} from './src/model';
import Fleet from './src/screens/Fleet';
import NeedsYou from './src/screens/NeedsYou';
import NewSession from './src/screens/NewSession';
import Reviewer from './src/screens/Reviewer';
import Screen from './src/screens/Screen';
import Session from './src/screens/Session';
import Setup from './src/screens/Setup';
import { makeStyles, SegmentedBar, UsageMeters } from './src/ui';

const CONFIG_KEY = '@keep/config';
const NOTIFIED_ATTENTION_KEY = '@keep/notifiedAttention';
const SNOOZE_KEY = '@keep/snoozes';
const PALETTE_KEY = 'keep.palette';
const MODE_KEY = 'keep.mode';
const RECENT_KEY = 'keep.recent.expanded';
const REVIEW_ACTIONS_KEY = 'keep.reviewer.actionsOnly';
const REVIEW_SEEN_KEY = 'keep.reviewer.seenAt';
const ATTENTION_SWEEP_TASK = 'keep-attention-sweep';
const BACKGROUND_ATTENTION_ETAG_KEY = '@keep/backgroundAttentionEtag';
const BACKGROUND_ATTENTION_STATE_KEY = '@keep/backgroundAttentionState';
const NOTIFIED_ATTENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const { createStateResultGate, stateViewKey } = require('./src/state-cache');

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

try {
  TaskManager.defineTask(ATTENTION_SWEEP_TASK, async () => {
    try {
      const savedConfig = await AsyncStorage.getItem(CONFIG_KEY);
      const config = savedConfig ? JSON.parse(savedConfig) : null;
      if (!config?.server || !config?.token) return BackgroundTask.BackgroundTaskResult.Failed;

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
            return BackgroundTask.BackgroundTaskResult.Failed;
          }
          await diffAndNotifyAttention(JSON.parse(cachedState), false, true);
          return BackgroundTask.BackgroundTaskResult.Success;
        }
      } finally { clearTimeout(timeout); }

      if (!response.ok) return BackgroundTask.BackgroundTaskResult.Failed;
      const state = await response.json();
      await Promise.all([
        response.headers.get('etag') ? AsyncStorage.setItem(BACKGROUND_ATTENTION_ETAG_KEY, response.headers.get('etag')) : Promise.resolve(),
        AsyncStorage.setItem(BACKGROUND_ATTENTION_STATE_KEY, JSON.stringify(state)),
      ]);
      await diffAndNotifyAttention(state, false, true);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
} catch {}

const EMPTY_DATA = {
  tasks: [], sessions: [], attention: [], panes: [], health: {}, usage: {}, review: { events: [], stats: {} },
};

function serverHost(server) {
  return String(server || '').replace(/^https?:\/\//, '').split('/')[0] || server;
}

function daemonSummary(health) {
  const unhealthy = (health?.schedulers || []).find((row) => ['failing', 'silent', 'never'].includes(row.state));
  if (!health?.daemon?.running) return { healthy: false, text: 'daemon: offline' };
  if (unhealthy) return { healthy: false, text: `daemon: ${unhealthy.name} ${unhealthy.state}` };
  return { healthy: true, text: 'daemon: healthy' };
}

export default function App() {
  return (
    <SafeAreaProvider>
      <KeepApp />
    </SafeAreaProvider>
  );
}

function KeepApp() {
  const colorScheme = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const [paletteId, setPaletteId] = useState(DEFAULT_PALETTE);
  const colors = useMemo(() => themeFor(paletteId, scheme), [paletteId, scheme]);
  const terminalColors = useMemo(() => themeFor(paletteId, 'dark'), [paletteId]);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [booting, setBooting] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [config, setConfig] = useState(null);
  const [data, setData] = useState(EMPTY_DATA);
  const [layouts, setLayouts] = useState([]);
  const [mode, setMode] = useState('needs');
  const [selection, setSelection] = useState(null);
  const [route, setRoute] = useState(null);
  const [handledVersion, setHandledVersion] = useState(0);
  const [recentOpen, setRecentOpen] = useState(false);
  const [actionsOnly, setActionsOnly] = useState(true);
  const [reviewSeenAt, setReviewSeenAt] = useState(0);
  const [pollError, setPollError] = useState(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [screenTop, setScreenTop] = useState(0);
  const handledRef = useRef(new Set());
  const reviewerSeenPersistedRef = useRef(0);
  const notificationSetupRef = useRef(false);
  const backgroundRegistrationRef = useRef(false);
  const foregroundBaselineRef = useRef(true);
  const notificationWorkRef = useRef(Promise.resolve());
  const activeStateViewRef = useRef({ view: 'needs' });
  const stateRequestAbortRef = useRef(null);
  const stateResultGateRef = useRef(createStateResultGate());
  const integratedStateKeyRef = useRef(null);

  const activeStateView = useMemo(() => {
    if (route?.name === 'screen') return null;
    if (route?.name === 'new') return { view: 'new' };
    if (selection?.sessionId) return { view: 'session', id: selection.sessionId };
    return { view: mode === 'reviewer' ? 'reviewer' : mode === 'fleet' ? 'fleet' : 'needs' };
  }, [mode, route, selection?.sessionId]);
  const activeStateKey = activeStateView ? stateViewKey(activeStateView) : null;
  activeStateViewRef.current = activeStateView;
  stateResultGateRef.current.activate(activeStateKey);

  const integrateState = useCallback((state) => {
    const fresh = queueItems(state);
    const freshKeys = new Set(fresh.map(snoozeId));
    for (const key of handledRef.current) if (!freshKeys.has(key)) handledRef.current.delete(key);
    // Once the daemon confirms an item is set aside, its filter takes over from the
    // optimistic handled set; otherwise the item stays hidden after expiry or Restore.
    for (const item of fresh) if (item.setAside) handledRef.current.delete(snoozeId(item));
    setData({ ...EMPTY_DATA, ...state, review: { ...EMPTY_DATA.review, ...(state.review || {}) } });
    setHandledVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const saved = await Promise.all([
          AsyncStorage.getItem(CONFIG_KEY),
          AsyncStorage.removeItem(SNOOZE_KEY).then(() => null),
          AsyncStorage.getItem(PALETTE_KEY),
          AsyncStorage.getItem(MODE_KEY),
          AsyncStorage.getItem(RECENT_KEY),
          AsyncStorage.getItem(REVIEW_ACTIONS_KEY),
          AsyncStorage.getItem(REVIEW_SEEN_KEY),
        ]);
        if (cancelled) return;
        if (saved[2]) setPaletteId(saved[2]);
        if (['needs', 'fleet', 'reviewer'].includes(saved[3])) setMode(saved[3]);
        setRecentOpen(saved[4] === '1');
        setActionsOnly(saved[5] == null ? true : saved[5] === '1');
        const seen = Number(saved[6] || 0) || 0;
        reviewerSeenPersistedRef.current = seen;
        setReviewSeenAt(seen);
        const nextConfig = saved[0] ? JSON.parse(saved[0]) : null;
        if (nextConfig?.server && nextConfig?.token) {
          nextConfig.server = api.normalizeServer(nextConfig.server);
          setConfig(nextConfig);
        } else setShowSetup(true);
      } catch { setShowSetup(true); }
      finally { if (!cancelled) setBooting(false); }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const setupNotifications = useCallback(async () => {
    if (notificationSetupRef.current) return;
    notificationSetupRef.current = true;
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
  }, []);

  const registerAttentionSweep = useCallback(async () => {
    if (backgroundRegistrationRef.current) return;
    backgroundRegistrationRef.current = true;
    try { await BackgroundTask.registerTaskAsync(ATTENTION_SWEEP_TASK, { minimumInterval: 15 }); }
    catch {}
  }, []);

  const handleSuccessfulState = useCallback((state) => {
    const baseline = foregroundBaselineRef.current;
    foregroundBaselineRef.current = false;
    notificationWorkRef.current = notificationWorkRef.current.then(async () => {
      if (baseline) await diffAndNotifyAttention(state, true);
      await setupNotifications();
      if (!baseline) await diffAndNotifyAttention(state, false);
      await registerAttentionSweep();
    }).catch(() => {});
  }, [registerAttentionSweep, setupNotifications]);

  const refreshState = useCallback(async () => {
    const descriptor = activeStateViewRef.current;
    if (!config || !descriptor) return null;
    const key = stateViewKey(descriptor);
    const ticket = stateResultGateRef.current.begin(key);
    if (stateRequestAbortRef.current) stateRequestAbortRef.current.abort();
    const controller = new AbortController();
    stateRequestAbortRef.current = controller;
    try {
      const [result, layoutData] = await Promise.all([
        api.getState(config, descriptor, { signal: controller.signal }),
        descriptor.view === 'needs' ? api.getLayouts(config).catch(() => null) : Promise.resolve(null),
      ]);
      if (!stateResultGateRef.current.accepts(ticket)) return null;
      const shouldIntegrate = !result.unchanged || integratedStateKeyRef.current !== key;
      if (shouldIntegrate) {
        integrateState(result.state);
        integratedStateKeyRef.current = key;
      }
      if (Array.isArray(layoutData?.layouts)) setLayouts(layoutData.layouts);
      if (shouldIntegrate && Array.isArray(result.state?.attention)) handleSuccessfulState(result.state);
      setPollError(null);
      return result.state;
    } catch (error) {
      if (stateResultGateRef.current.accepts(ticket) && !controller.signal.aborted) setPollError(error.message || 'Connection failed');
      return null;
    } finally {
      if (stateRequestAbortRef.current === controller) stateRequestAbortRef.current = null;
    }
  }, [config, handleSuccessfulState, integrateState]);

  useEffect(() => {
    if (!config || showSetup || !activeStateView) return undefined;
    let interval = null;
    const startPolling = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(refreshState, 8000);
    };
    if (activeStateView.view === 'needs') setInitialLoading(true);
    refreshState().finally(() => setInitialLoading(false));
    if (AppState.currentState === 'active') startPolling();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refreshState();
        startPolling();
      } else if (interval) {
        clearInterval(interval);
        interval = null;
      }
    });
    return () => {
      if (interval) clearInterval(interval);
      if (stateRequestAbortRef.current) stateRequestAbortRef.current.abort();
      subscription.remove();
    };
  }, [activeStateKey, config, refreshState, showSetup]);

  const allQueue = useMemo(() => queueItems(data, handledRef.current), [data, handledVersion]);
  const waiting = useMemo(() => visibleQueue(allQueue), [allQueue]);
  const pinned = useMemo(() => pinnedItems(data, layouts, allQueue), [allQueue, data, layouts]);
  const recent = useMemo(() => recentItems(data, allQueue, pinned), [allQueue, data, pinned]);
  const setAsideCount = allQueue.filter((item) => item.setAside).length;

  const selectedItem = useMemo(() => {
    if (!selection) return null;
    const candidates = [...waiting, ...pinned, ...recent];
    const exact = candidates.find((item) => eventKey(item) === eventKey(selection));
    if (exact) return exact;
    const sameSession = selection.sessionId && candidates.find((item) => item.sessionId === selection.sessionId && item.kind === selection.kind);
    if (sameSession) return sameSession;
    const session = (data.sessions || []).find((candidate) => candidate.id === selection.sessionId);
    return session ? { ...sessionItem(selection.kind || 'recent', session), _task: (data.tasks || []).find((task) => task.id === session.taskId) } : selection;
  }, [data, pinned, recent, selection, waiting]);

  const advance = useCallback((item) => {
    handledRef.current.add(snoozeId(item));
    setHandledVersion((value) => value + 1);
    const currentIndex = waiting.findIndex((candidate) => snoozeId(candidate) === snoozeId(item));
    const remaining = waiting.filter((candidate) => snoozeId(candidate) !== snoozeId(item));
    const next = remaining[currentIndex] || remaining[0] || null;
    setSelection(next);
    setMode('needs');
    AsyncStorage.setItem(MODE_KEY, 'needs').catch(() => {});
    refreshState();
  }, [refreshState, waiting]);

  const sendReply = useCallback(async (item, text) => {
    await api.send(config, { sessionId: item.sessionId }, text);
    advance(item);
  }, [advance, config]);

  const answerItem = useCallback(async (item, option, label) => {
    await api.answer(config, item.sessionId, option, label);
    advance(item);
  }, [advance, config]);

  const dismissItem = useCallback(async (item) => {
    if (item.key) await api.setAside(config, item.key, 'dismiss');
    else await api.ack(config, item);
    advance(item);
  }, [advance, config]);

  const snoozeItem = useCallback(async (item) => {
    if (!item.key) throw new Error('This item cannot be snoozed');
    await api.setAside(config, item.key, 'snooze', 60);
    advance(item);
  }, [advance, config]);

  const restoreAll = useCallback(async () => {
    const results = await Promise.allSettled(allQueue
      .filter((item) => item.setAside && item.key)
      .map((item) => api.setAside(config, item.key, 'clear')));
    await refreshState();
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) Alert.alert('Restore failed', `${failed.length} ${failed.length === 1 ? 'item' : 'items'} could not be restored: ${failed[0].reason?.message || failed[0].reason}`);
  }, [allQueue, config, refreshState]);

  const pullRefresh = async () => {
    setRefreshing(true);
    await refreshState();
    setRefreshing(false);
  };

  const selectMode = (nextMode) => {
    setSelection(null);
    setMode(nextMode);
    AsyncStorage.setItem(MODE_KEY, nextMode).catch(() => {});
  };

  const selectFleetSession = (session) => {
    if (session.session === false) {
      setSelection(session);
      return;
    }
    const active = waiting.find((item) => item.sessionId === session.id)
      || pinned.find((item) => item.sessionId === session.id)
      || recent.find((item) => item.sessionId === session.id);
    setSelection(active || { ...sessionItem('recent', session), _task: (data.tasks || []).find((task) => task.id === session.taskId) });
  };

  const openScreen = (sessionId, from) => setRoute({ name: 'screen', sessionId, from });
  const openPane = (pane, project, from) => setRoute({ name: 'screen', pane, project, from });

  // Reopening resumes a closed session in a fresh host pane — the same thing the
  // console's Reopen button and `keep open` do — then lands on its terminal.
  const reopenSession = useCallback(async (item) => {
    const session = item._session || (data.sessions || []).find((candidate) => candidate.id === item.sessionId);
    const agent = session?.kind || session?.agent;
    const result = await api.openSession(config, {
      sessionId: item.sessionId,
      ...(['claude', 'codex'].includes(agent) ? { agent } : {}),
    });
    await refreshState();
    setSelection(null);
    openScreen(result?.sessionId || item.sessionId, 'reopen');
    return result;
  }, [config, data.sessions, refreshState]);

  // Both start something that did not exist a moment ago, so they land on its terminal
  // rather than dropping you back on a list that has not polled yet.
  const startSession = useCallback(async ({ taskId, agent, message }) => {
    const result = await api.openSession(config, {
      taskId,
      fresh: true,
      ...(['claude', 'codex'].includes(agent) ? { agent } : {}),
      ...(message ? { message } : {}),
    });
    await refreshState();
    setSelection(null);
    if (result?.sessionId) openScreen(result.sessionId, 'new');
    else if (result?.pane) openPane(result.pane, null, 'new');
    else setRoute(null);
    return result;
  }, [config, refreshState]);

  const startShell = useCallback(async (cwd) => {
    const result = await api.spawnShell(config, cwd);
    await refreshState();
    setSelection(null);
    openPane(result?.pane?.id || result?.pane, cwd, 'new');
    return result;
  }, [config, refreshState]);

  // The Android back button walks the same stack the on-screen back arrows do.
  useEffect(() => {
    const onBack = () => {
      if (route) { setRoute(null); return true; }
      if (showSetup && config) { setShowSetup(false); return true; }
      if (selection) { setSelection(null); return true; }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  }, [route, selection, showSetup, config]);

  const toggleRecent = () => setRecentOpen((current) => {
    const next = !current;
    AsyncStorage.setItem(RECENT_KEY, next ? '1' : '0').catch(() => {});
    return next;
  });

  const toggleActionsOnly = () => setActionsOnly((current) => {
    const next = !current;
    AsyncStorage.setItem(REVIEW_ACTIONS_KEY, next ? '1' : '0').catch(() => {});
    return next;
  });

  const markReviewerSeen = useCallback((at) => {
    if (at <= reviewerSeenPersistedRef.current) return;
    reviewerSeenPersistedRef.current = at;
    setReviewSeenAt(at);
    AsyncStorage.setItem(REVIEW_SEEN_KEY, String(at)).catch(() => {});
  }, []);

  const changePalette = (nextPalette) => {
    setPaletteId(nextPalette);
    AsyncStorage.setItem(PALETTE_KEY, nextPalette).catch(() => {});
  };

  const onConnected = async (nextConfig, state) => {
    await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(nextConfig));
    handledRef.current.clear();
    setConfig(nextConfig);
    setPollError(null);
    integrateState(state);
    integratedStateKeyRef.current = 'needs';
    handleSuccessfulState(state);
    const nextLayouts = await api.getLayouts(nextConfig).catch(() => null);
    if (Array.isArray(nextLayouts?.layouts)) setLayouts(nextLayouts.layouts);
    setShowSetup(false);
  };

  const daemon = daemonSummary(data.health);
  const reviewerStats = data.review?.stats || {};
  const reviewerMarker = reviewerStats.reviewer;
  const reviewerFresh = Number(reviewerStats.lastTickAt || 0) && Date.now() - Number(reviewerStats.lastTickAt) <= 90 * 60e3;
  const reviewerHealthy = Boolean(reviewerMarker && reviewerMarker.state !== 'gone'
    && ['running', 'idle'].includes(reviewerMarker.state) && reviewerFresh);
  const reportedPaneCount = Number.isFinite(Number(data.paneCount)) ? Number(data.paneCount) : Array.isArray(data.panes) ? data.panes.length : 0;
  const paneCount = reportedPaneCount || new Set((data.sessions || []).map((session) => session.pane).filter(Boolean)).size;
  const insets = useSafeAreaInsets();
  const statusInset = insets.top;

  if (booting) {
    return (
      <View style={[styles.loadingScreen, { backgroundColor: colors.barBg, paddingTop: statusInset, paddingBottom: insets.bottom }]}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.barText} />
      </View>
    );
  }

  if (showSetup || !config) {
    return (
      <View style={[styles.app, { backgroundColor: colors.barBg, paddingTop: statusInset, paddingBottom: insets.bottom }]}>
        <StatusBar style="light" />
        <Setup
          initialConfig={config}
          onCancel={config ? () => setShowSetup(false) : undefined}
          onConnected={onConnected}
          onPalette={changePalette}
          paletteId={paletteId}
          scheme={scheme}
          styles={styles}
        />
      </View>
    );
  }

  if (route?.name === 'new') {
    return (
      <View style={[styles.app, { backgroundColor: colors.barBg, paddingTop: statusInset, paddingBottom: insets.bottom }]}>
        <StatusBar style="light" />
        <NewSession
          data={data}
          keyboardOffset={statusInset}
          onBack={() => setRoute(null)}
          onStartSession={startSession}
          onStartShell={startShell}
          styles={styles}
        />
      </View>
    );
  }

  if (route?.name === 'screen') {
    const routedSession = (data.sessions || []).find((session) => session.id === route.sessionId) || null;
    return (
      <View style={[styles.app, { backgroundColor: terminalColors.barBg, paddingTop: statusInset, paddingBottom: insets.bottom }]}>
        <StatusBar style="light" />
        <Screen
          colors={terminalColors}
          config={config}
          key={route.sessionId || route.pane}
          onBack={() => setRoute(null)}
          pane={route.pane}
          project={route.project}
          session={routedSession}
          sessionId={route.sessionId}
        />
      </View>
    );
  }

  return (
    <View style={[styles.app, { backgroundColor: colors.barBg, paddingTop: statusInset, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <SegmentedBar
        daemonHealthy={daemon.healthy}
        mode={mode}
        needsCount={waiting.length}
        onNew={() => setRoute({ name: 'new' })}
        onSelect={selectMode}
        onSettings={() => setShowSetup(true)}
        reviewerHealthy={reviewerHealthy}
        styles={styles}
      />
      {pollError ? (
        <Pressable onPress={refreshState} style={styles.connectionBanner}>
          <Text style={styles.connectionText}>Can’t reach {serverHost(config.server)} — retrying</Text>
        </Pressable>
      ) : null}
      <View onLayout={(event) => setScreenTop(event.nativeEvent.layout.y)} style={styles.screen}>
        {selectedItem ? (
          <Session
            config={config}
            data={data}
            detailLoading={Boolean(selection?.sessionId && !(data.view === 'session' && data.id === selection.sessionId))}
            item={selectedItem}
            onAnswer={answerItem}
            onBack={() => setSelection(null)}
            onDismiss={dismissItem}
            onFocus={(item) => api.focus(config, item.sessionId)}
            keyboardOffset={screenTop}
            onOpenScreen={(item) => openScreen(item.sessionId, 'session')}
            onReopen={reopenSession}
            onSend={sendReply}
            onSnooze={snoozeItem}
            styles={styles}
          />
        ) : mode === 'needs' ? (
          <NeedsYou
            initialLoading={initialLoading}
            onRefresh={pullRefresh}
            onSelect={setSelection}
            onToggleRecent={toggleRecent}
            onRestoreAll={restoreAll}
            pinned={pinned}
            recent={recent}
            recentOpen={recentOpen}
            refreshing={refreshing}
            snoozedCount={setAsideCount}
            styles={styles}
            waiting={waiting}
          />
        ) : mode === 'fleet' ? (
          <Fleet data={data} onOpenScreen={(session) => openScreen(session.id, 'fleet')} onReopen={reopenSession} onSelect={selectFleetSession} styles={styles} />
        ) : (
          <Reviewer
            actionsOnly={actionsOnly}
            data={data}
            onSeen={markReviewerSeen}
            onTick={async () => { const result = await api.reviewTick(config); await refreshState(); return result; }}
            onToggleActionsOnly={toggleActionsOnly}
            seenAt={reviewSeenAt}
            styles={styles}
          />
        )}
      </View>
      <UsageMeters styles={styles} usage={data.usage} />
      <View style={styles.footer}>
        <Text numberOfLines={1} style={styles.footerText}>{daemon.text}</Text>
        <Text style={styles.footerText}>{paneCount} pane{paneCount === 1 ? '' : 's'}</Text>
      </View>
    </View>
  );
}
