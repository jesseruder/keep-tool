import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Button, InlineError } from '../ui';

const ICONS = { ack: '✓', finding: '!', idea: '◇', nudge: '→', dismiss: '✕', compact: '↓', tick: '·' };

function localDay(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function today() { return localDay(Date.now()); }
function yesterday() { return localDay(Date.now() - 86400e3); }

function eventHeading(event) {
  if (event.kind === 'nudge') return `nudged session ${String(event.sessionId || '').slice(0, 8)}`.trim();
  return ({ ack: 'acked', finding: 'finding', idea: 'idea filed', dismiss: 'dismissed', compact: 'compacted', tick: 'tick' })[event.kind]
    || event.title || event.kind || 'event';
}

function countSummary(events) {
  const counts = new Map();
  for (const event of events) counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
  const labels = { tick: 'ticks', ack: 'acks', finding: 'findings', idea: 'ideas', dismiss: 'dismissals', nudge: 'nudges', compact: 'compacts' };
  return ['tick', 'ack', 'finding', 'idea', 'dismiss', 'nudge', 'compact']
    .filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind)} ${labels[kind]}`).join(', ');
}

function weeklyText(value) {
  if (!value || !Number.isFinite(Number(value.reviewerCost))) return { cost: '—', share: '—' };
  const cost = Number(value.reviewerCost);
  const share = Number(value.shareOfLocal);
  return {
    cost: `$${cost < 10 ? cost.toFixed(2) : Math.round(cost)}`,
    share: Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : '—',
  };
}

function EventRow({ event, isNew, styles }) {
  const date = new Date(Number(event.at));
  const time = Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  return (
    <View style={[styles.eventRow, isNew && { borderLeftColor: styles.colors.info, borderLeftWidth: 3 }]}>
      <Text style={styles.eventTime}>{time}</Text>
      <View style={styles.eventGlyph}><Text style={styles.eventGlyphText}>{ICONS[event.kind] || '·'}</Text></View>
      <View style={styles.eventBody}>
        <View style={styles.eventHeadingRow}>
          <Text style={styles.eventHeading}>{eventHeading(event)}</Text>
          {event.severity ? <Text style={styles.severityChip}>{event.severity}</Text> : null}
          {event.card ? <Text style={styles.eventCard}>{event.card}</Text> : null}
        </View>
        {event.detail ? <Text style={styles.eventDetail}>{event.detail}</Text> : null}
      </View>
    </View>
  );
}

export default function Reviewer({ actionsOnly, data, onSeen, onTick, onToggleActionsOnly, seenAt, styles }) {
  const [visitSeenAt] = useState(seenAt);
  const [expandedDays, setExpandedDays] = useState(new Set());
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState(null);
  const events = useMemo(() => [...(data.review?.events || [])].sort((a, b) => Number(b.at || 0) - Number(a.at || 0)), [data.review]);
  const newest = Number(events[0]?.at || 0);
  const newCount = events.filter((event) => Number(event.at || 0) > visitSeenAt).length;
  useEffect(() => { if (newest) onSeen(newest); }, [newest, onSeen]);

  const stats = data.review?.stats || {};
  const day = stats.days?.[today()] || {};
  const actionCount = ['acks', 'notes', 'ideas', 'dismisses', 'nudges'].reduce((sum, key) => sum + Number(day[key] || 0), 0);
  const weekly = weeklyText(stats.weekly);
  const median = stats.medianContextTokens == null ? '—' : `${Math.round(Number(stats.medianContextTokens) / 1000)}k`;
  const groups = new Map();
  for (const event of events) {
    const key = localDay(event.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const toggleDay = (key) => setExpandedDays((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const tick = async () => {
    setTicking(true);
    setError(null);
    try { await onTick(); }
    catch (tickError) { setError({ message: tickError.message || 'Could not tick the reviewer' }); }
    finally { setTicking(false); }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.statsStrip}>
        <View style={styles.statTile}><Text style={styles.statValue}>{Number(day.ticks || 0)}</Text><Text style={styles.statLabel}>ticks today</Text></View>
        <View style={styles.statTile}><Text style={[styles.statValue, styles.statHot]}>{actionCount}</Text><Text style={styles.statLabel}>actions today</Text></View>
        <View style={styles.statTile}><Text style={styles.statValue}>{median}</Text><Text style={styles.statLabel}>median ctx</Text></View>
        <View style={styles.statTile}><Text style={styles.statValue}>{weekly.cost}</Text><Text style={styles.statLabel}>{weekly.share} fleet</Text></View>
      </View>
      <View style={styles.reviewerHead}>
        <Text style={styles.reviewerHeading}>Did anything · <Text style={styles.reviewerNew}>{newCount} new</Text></Text>
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: actionsOnly }} onPress={onToggleActionsOnly} style={styles.toggle}>
          <Text style={styles.toggleLabel}>actions only</Text>
          <View style={[styles.toggleTrack, actionsOnly && styles.toggleTrackOn]}><View style={[styles.toggleKnob, actionsOnly && styles.toggleKnobOn]} /></View>
        </Pressable>
      </View>
      <ScrollView style={styles.scroll}>
        {groups.size ? [...groups].map(([key, dayEvents]) => {
          const old = key !== today();
          const collapsed = old && !expandedDays.has(key);
          const label = key === today() ? `Today · ${key}` : key === yesterday() ? `Yesterday · ${key}` : key;
          const visibleEvents = actionsOnly ? dayEvents.filter((event) => !['tick', 'compact'].includes(event.kind)) : dayEvents;
          return (
            <View key={key}>
              <Pressable disabled={!old} onPress={() => toggleDay(key)} style={styles.dayHeader}>
                <Text numberOfLines={1} style={styles.dayHeaderText}>
                  {old ? (collapsed ? '▸ ' : '▾ ') : ''}{label}{old ? ` · ${countSummary(dayEvents)}` : ''}
                </Text>
              </Pressable>
              {collapsed ? null : visibleEvents.map((event, index) => <EventRow event={event} isNew={Number(event.at || 0) > visitSeenAt} key={`${event.at}:${event.kind}:${index}`} styles={styles} />)}
            </View>
          );
        }) : (
          <View style={styles.emptyState}><Text style={styles.emptyTitle}>No reviewer events yet</Text><Text style={styles.emptyCopy}>The next tick or landed review action will appear here.</Text></View>
        )}
      </ScrollView>
      <View style={styles.reviewerFooter}>
        <InlineError error={error} styles={styles} />
        <Button loading={ticking} onPress={tick} styles={styles}>Tick now</Button>
      </View>
    </View>
  );
}
