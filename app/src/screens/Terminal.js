import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import NativeTerminal from './NativeTerminal';
import Screen from './Screen';

// The terminal, reached only from the console's `openTerminal` message. Two viewers
// live behind it: the native terminal (xterm's parser in the app, over the pane
// socket) and the old polled plain-text viewer, which stays until the native one has
// a week of use — the mobile plan's phase 3. The choice is the user's and it sticks,
// because somebody falling back to the text view is telling us the native one is
// failing them and asking again on every open would be the wrong response.
const VIEW_KEY = '@keep/terminalView';

export default function Terminal({ colors, config, onBack, onOpenSession, target }) {
  const [view, setView] = useState(null);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(VIEW_KEY)
      .then((saved) => { if (!cancelled) setView(saved === 'text' ? 'text' : 'native'); })
      .catch(() => { if (!cancelled) setView('native'); });
    return () => { cancelled = true; };
  }, []);

  const choose = useCallback((next) => {
    setView(next);
    AsyncStorage.setItem(VIEW_KEY, next).catch(() => {});
  }, []);

  const session = useMemo(
    () => (target?.title ? { title: target.title } : null),
    [target?.title],
  );

  // Nothing renders until the saved choice is known: mounting the native terminal
  // first would attach to the pane, and switching a moment later would leave the host
  // counting a viewer that was never looked at.
  if (view === null) return null;

  if (view === 'text') {
    return (
      <Screen
        colors={colors}
        config={config}
        key={target?.session || target?.pane}
        onBack={onBack}
        onSwitchView={() => choose('native')}
        pane={target?.pane || undefined}
        session={session}
        sessionId={target?.session || undefined}
        switchLabel="Live view"
      />
    );
  }

  return (
    <NativeTerminal
      colors={colors}
      config={config}
      key={target?.session || target?.pane}
      onBack={onBack}
      onOpenSession={onOpenSession}
      onUseTextView={() => choose('text')}
      storage={AsyncStorage}
      target={target}
    />
  );
}
