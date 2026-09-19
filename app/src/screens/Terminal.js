import React, { useMemo } from 'react';

import Screen from './Screen';

// The fallback terminal viewer, reached only from the console's `openTerminal`
// message. Screen.js already draws its own header (title, pane, Back) and key bar;
// this wrapper turns the bridge's target into the props it expects. A later phase
// replaces it with a native terminal.
export default function Terminal({ colors, config, onBack, target }) {
  const session = useMemo(
    () => (target?.title ? { title: target.title } : null),
    [target?.title],
  );
  return (
    <Screen
      colors={colors}
      config={config}
      key={target?.session || target?.pane}
      onBack={onBack}
      pane={target?.pane || undefined}
      session={session}
      sessionId={target?.session || undefined}
    />
  );
}
