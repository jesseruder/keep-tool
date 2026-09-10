import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { kindLabel, projectFor, rel } from '../model';

export default function Fleet({ data, onOpenScreen, onReopen, onSelect, styles }) {
  const [filter, setFilter] = useState('');
  const [reopening, setReopening] = useState(null);
  const { groups, total, visible } = useMemo(() => {
    const panesBySession = new Map();
    const waitingBySession = new Map();
    const paneAlive = new Map((data.panes || []).map((pane) => [pane.id, Boolean(pane.alive)]));
    for (const item of data.attention || []) {
      if (!item.sessionId || item.kind === 'health') continue;
      const prior = waitingBySession.get(item.sessionId);
      if (!prior || Number(item.pri || 0) < Number(prior.pri || 0)) waitingBySession.set(item.sessionId, item);
    }
    const rows = [];
    for (const session of data.sessions || []) {
      if (session.pane) panesBySession.set(session.id, session.pane);
      rows.push({
        ...session,
        sessionId: session.id,
        session: true,
        state: session.rateLimit ? 'limit' : session.state || 'recent',
        title: session.title || 'untitled session',
        waiting: waitingBySession.get(session.id)?.kind || '',
        // No live host pane means the agent is gone: offer to reopen it rather than
        // a terminal that will never move again. A session that is alive outside the
        // host keeps its screen button — the daemon refuses to resume that one.
        closed: Boolean(session.exited || session.state === 'exited'
          || (!paneAlive.get(session.pane) && session.alive !== true)),
      });
    }
    for (const pane of data.panes || []) {
      const sessionId = pane.meta?.sessionId;
      if (sessionId && panesBySession.has(sessionId)) continue;
      if (pane.meta?.agent !== 'shell') continue;
      rows.push({
        id: pane.id,
        pane: pane.id,
        project: pane.meta?.project || pane.cwd,
        title: pane.meta?.title || pane.title || 'shell',
        state: pane.alive ? 'running' : 'exited',
        kind: 'shell',
        gitBranch: '',
        mtime: pane.createdAt,
        session: false,
        waiting: '',
      });
    }
    const needle = filter.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (!needle) return true;
      const project = projectFor(row.project);
      return [row.title, row.id, row.taskId, project.name, project.key, project.path, row.gitBranch]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
    const map = new Map();
    for (const row of filtered) {
      const project = projectFor(row.project);
      if (!map.has(project.key)) map.set(project.key, { project, rows: [] });
      map.get(project.key).rows.push(row);
    }
    const ordered = [...map.values()].sort((a, b) => a.project.scope.localeCompare(b.project.scope) || a.project.name.localeCompare(b.project.name));
    return { groups: ordered, total: rows.length, visible: filtered.length };
  }, [data, filter]);

  return (
    <View style={styles.screen}>
      <View style={styles.fleetFilterBar}>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setFilter}
          placeholder="Filter title, card, project, or branch"
          placeholderTextColor={styles.colors.faint}
          style={styles.fleetFilter}
          value={filter}
        />
        <Text style={styles.fleetCount}>{visible} of {total}</Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        {groups.length ? groups.map((group) => {
          const waiting = group.rows.filter((row) => row.waiting || ['idle', 'waiting', 'limit'].includes(row.state)).length;
          const sessions = group.rows.filter((row) => row.session).length;
          return (
            <View key={group.project.key}>
              <View style={styles.fleetGroup}>
                <View style={[styles.projectDot, { backgroundColor: `hsl(${group.project.h}, 56%, 48%)` }]} />
                <Text style={styles.fleetGroupName}>{group.project.name}</Text>
                <Text style={styles.fleetGroupMeta}>{sessions} session{sessions === 1 ? '' : 's'} · {waiting} waiting</Text>
              </View>
              {group.rows.map((row) => {
                const stateColor = row.waiting ? styles.colors.accent : row.state === 'running' ? styles.colors.ok : styles.colors.faint;
                const meta = [row.waiting ? kindLabel(row.waiting) : row.state, row.taskId, rel(row.mtime)].filter(Boolean).join(' · ');
                return (
                  <View key={row.id} style={styles.fleetRow}>
                    <Pressable accessibilityRole="button" onPress={() => onSelect(row)} style={({ pressed }) => [styles.fleetOpenArea, pressed && styles.pressed]}>
                      <View style={[styles.fleetStateDot, { backgroundColor: stateColor }]} />
                      <View style={styles.fleetBody}>
                        <Text numberOfLines={1} style={styles.fleetTitle}>{row.title}</Text>
                        <Text numberOfLines={1} style={styles.fleetMeta}>{meta}</Text>
                      </View>
                    </Pressable>
                    {row.session && row.closed ? (
                      <Pressable
                        accessibilityLabel={`Reopen ${row.title}`}
                        accessibilityRole="button"
                        disabled={Boolean(reopening)}
                        onPress={async () => {
                          if (reopening) return;
                          setReopening(row.id);
                          try { await onReopen(row); }
                          catch (error) { Alert.alert('Could not reopen', error.message || 'The daemon refused to reopen this session'); }
                          finally { setReopening(null); }
                        }}
                        style={({ pressed }) => [styles.fleetScreenButton, (pressed || reopening === row.id) && styles.pressed]}
                      >
                        <Text style={styles.fleetScreenText}>{reopening === row.id ? 'opening…' : 'reopen'}</Text>
                      </Pressable>
                    ) : row.session ? (
                      <Pressable
                        accessibilityLabel={`Open screen for ${row.title}`}
                        accessibilityRole="button"
                        onPress={() => onOpenScreen(row)}
                        style={({ pressed }) => [styles.fleetScreenButton, pressed && styles.pressed]}
                      >
                        <Text style={styles.fleetScreenText}>screen</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          );
        }) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No fleet rows match</Text>
            <Text style={styles.emptyCopy}>Try another title, card, project, or branch.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
