import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { mono } from '../ui';

const { describeRef } = require('../terminal/refs');

// The sheet a tapped reference in the native terminal opens: the console's hover card
// for a phone. It shows what the refs view already had at once, then loads the rest
// (a card's latest check-in, who mentions a session, what a commit is) and redraws.
// Open goes to the session the reference names; Copy copies the reference itself.
export default function RefSheet({ colors, config, known, onClose, onCopy, onOpenSession, project, target }) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [loaded, setLoaded] = useState({});

  useEffect(() => {
    setLoaded({});
    if (!target) return undefined;
    let live = true;
    const load = (name, promise) => {
      setLoaded((current) => ({ ...current, [name]: { status: 'loading', value: null } }));
      promise.then(
        (value) => live && setLoaded((current) => ({ ...current, [name]: value === undefined
          ? { status: 'error', value: null } : { status: 'ready', value } })),
        () => live && setLoaded((current) => ({ ...current, [name]: { status: 'error', value: null } })),
      );
    };
    if (target.kind === 'card') load('detail', api.cardDetail(config, target.key));
    if (target.kind === 'session') load('mentions', api.sessionMentions(config, target.key));
    if (target.kind === 'sha') load('commit', api.commitInfo(config, target.key, project));
    return () => { live = false; };
  }, [config, project, target]);

  const info = target ? describeRef(target, known, loaded) : null;
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={Boolean(target)}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.scrim} />
      <View style={styles.sheet}>
        {info ? (
          <ScrollView style={styles.scroll}>
            <Text style={styles.head}>
              {info.badge ? <Text style={styles.badge}>{info.badge}  </Text> : null}
              <Text style={styles.title}>{info.title}</Text>
            </Text>
            {info.meta ? <Text style={styles.meta}>{info.meta}</Text> : null}
            {info.rows.map(([label, value], index) => (
              <View key={index} style={styles.row}>
                <Text style={styles.key}>{label}</Text>
                <Text style={styles.value}>{value}</Text>
              </View>
            ))}
            {info.quote ? <Text style={styles.quote}>{info.quote}</Text> : null}
            {(info.sections || []).map((section) => (
              <View key={section.label} style={styles.section}>
                <Text style={styles.key}>{section.label}</Text>
                {section.items.map((item, index) => <Text key={index} numberOfLines={1} style={styles.value}>{item}</Text>)}
                {section.pending ? <Text style={styles.pending}>{section.pending}</Text> : null}
              </View>
            ))}
            {info.pending ? <Text style={styles.pending}>{info.pending}</Text> : null}
          </ScrollView>
        ) : (
          <Text style={styles.pending}>Keep no longer lists this.</Text>
        )}
        <View style={styles.actions}>
          {info?.open ? (
            <Pressable accessibilityRole="button" onPress={() => onOpenSession(info.open)} style={styles.button}>
              <Text style={styles.buttonText}>Open session</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => onCopy(String(target?.text || target?.key || ''))} style={styles.button}>
            <Text style={styles.buttonText}>Copy</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    scrim: { backgroundColor: 'rgba(0,0,0,0.35)', flex: 1 },
    sheet: { backgroundColor: colors.barBg, borderColor: colors.barLine, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderTopWidth: 1, maxHeight: '60%', paddingBottom: 18, paddingHorizontal: 16, paddingTop: 14 },
    scroll: { flexGrow: 0 },
    head: { color: colors.barText, fontSize: 15, marginBottom: 4 },
    badge: { color: colors.info, fontFamily: mono, fontSize: 13 },
    title: { color: colors.barText, fontWeight: '700' },
    meta: { color: colors.info, fontSize: 12, marginBottom: 8, opacity: 0.8 },
    row: { flexDirection: 'row', marginBottom: 3 },
    key: { color: colors.barText, fontSize: 12, minWidth: 64, opacity: 0.55 },
    value: { color: colors.barText, flex: 1, fontSize: 13 },
    quote: { borderLeftColor: colors.barLine, borderLeftWidth: 2, color: colors.barText, fontSize: 13, marginTop: 6, opacity: 0.8, paddingLeft: 8 },
    section: { marginTop: 8 },
    pending: { color: colors.barText, fontSize: 12, marginTop: 6, opacity: 0.55 },
    actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 14 },
    button: { borderColor: colors.barLine, borderRadius: 6, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
    buttonText: { color: colors.barText, fontSize: 13, fontWeight: '600' },
  });
}
