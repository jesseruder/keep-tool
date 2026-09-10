import React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { itemSummary, kindLabel, projectFor, rel, waitText } from '../model';
import { Button, KindWord, Row } from '../ui';

const ACTION_KINDS = new Set(['question', 'permission', 'plan']);

function QueueRow({ item, onPress, styles }) {
  const session = item._session;
  const project = projectFor(item.project || session?.project || '');
  const passive = item.kind === 'pinned' || item.kind === 'recent';
  const title = item.title || session?.title || 'untitled session';
  const age = passive && item.kind !== 'recent' ? '' : passive ? rel(item.since) : waitText(item.since);
  const tags = item._task?.fm?.tags || [];
  return (
    <Row accent={ACTION_KINDS.has(item.kind)} onPress={onPress} styles={styles}>
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={styles.rowTitle}>{title}</Text>
        {age ? <Text style={styles.rowAge}>{age}</Text> : null}
      </View>
      <View style={styles.rowProject}>
        <View style={[styles.projectDot, { backgroundColor: `hsl(${project.h}, 56%, 48%)` }]} />
        <Text style={styles.projectName}>{project.name}</Text>
        {item.taskId ? <Text numberOfLines={1} style={styles.cardId}>{item.taskId}</Text> : null}
        {tags.map((tag) => <Text key={tag} style={styles.tag}>#{tag}</Text>)}
      </View>
      <View style={styles.rowSummary}>
        <KindWord action={ACTION_KINDS.has(item.kind)} styles={styles}>
          {passive ? item.state || 'unknown' : kindLabel(item.kind)}
        </KindWord>
        {!passive ? <Text numberOfLines={1} style={styles.preview}>{itemSummary(item, session)}</Text> : null}
      </View>
    </Row>
  );
}

export default function NeedsYou({
  initialLoading,
  onRefresh,
  onRestoreAll,
  onSelect,
  onToggleRecent,
  pinned,
  recent,
  recentOpen,
  refreshing,
  snoozedCount,
  styles,
  waiting,
}) {
  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl colors={[styles.colors.accent]} onRefresh={onRefresh} refreshing={refreshing} tintColor={styles.colors.accent} />}
      style={styles.scroll}
    >
      <View style={styles.queueHeader}>
        <Text style={styles.queueHeading}>{waiting.length} waiting on you</Text>
        <Text style={styles.queueOrder}>oldest first</Text>
      </View>
      {initialLoading && !waiting.length ? (
        <View style={styles.emptyState}>
          <ActivityIndicator color={styles.colors.accent} />
          <Text style={[styles.emptyCopy, { marginTop: 10 }]}>Checking what needs you…</Text>
        </View>
      ) : waiting.length ? waiting.map((item) => (
        <QueueRow item={item} key={`${item.kind}:${item.sessionId || item.taskId}:${item.since}`} onPress={() => onSelect(item)} styles={styles} />
      )) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyMark}>✓</Text>
          <Text style={styles.emptyTitle}>Nothing needs you right now</Text>
          <Text style={styles.emptyCopy}>
            {snoozedCount
              ? `${snoozedCount} ${snoozedCount === 1 ? 'item is' : 'items are'} set aside.`
              : 'You’re caught up. Pull down whenever you want to check again.'}
          </Text>
          {snoozedCount ? <Button onPress={onRestoreAll} quiet styles={styles}>Restore all</Button> : null}
        </View>
      )}

      {pinned.length ? (
        <>
          <View style={styles.groupHeader}>
            <Text style={styles.groupLabel}>Pinned</Text>
            <Text style={styles.groupMeta}>{pinned.length}</Text>
          </View>
          {pinned.map((item) => <QueueRow item={item} key={`pinned:${item.sessionId || item.pane}`} onPress={() => onSelect(item)} styles={styles} />)}
        </>
      ) : null}

      <Pressable accessibilityRole="button" onPress={onToggleRecent} style={({ pressed }) => [styles.groupHeader, pressed && styles.pressed]}>
        <Text style={styles.groupLabel}>{recentOpen ? '▾' : '▸'} Recent</Text>
        <Text style={styles.groupMeta}>{recent.length}</Text>
      </Pressable>
      {recentOpen ? recent.map((item) => <QueueRow item={item} key={`recent:${item.sessionId}`} onPress={() => onSelect(item)} styles={styles} />) : null}
    </ScrollView>
  );
}
