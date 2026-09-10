import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import * as api from '../api';
import { isClosedSession, kindLabel, optionLabel, projectFor, rateLimitFor, tagsFor } from '../model';
import { Button, Chip, InlineError, Markdown } from '../ui';

export default function Session({ config, data, item, keyboardOffset = 0, onAnswer, onBack, onDismiss, onFocus, onOpenScreen, onReopen, onSend, onSnooze, styles }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [reply, setReply] = useState('');
  const [replyHeight, setReplyHeight] = useState(44);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [conversation, setConversation] = useState(null);
  const [tailLoading, setTailLoading] = useState(false);
  const tailRequestRef = useRef(0);
  useEffect(() => {
    tailRequestRef.current += 1;
    setBusy(null);
    setError(null);
    setReply('');
    setReplyHeight(44);
    setConversationOpen(false);
    setConversation(null);
    setTailLoading(false);
    return () => { tailRequestRef.current += 1; };
  }, [item.sessionId, item.kind, item.since]);

  const session = item._session || (data.sessions || []).find((candidate) => candidate.id === item.sessionId);
  const project = projectFor(item.project || session?.project || '');
  const tags = tagsFor(data, item);
  const title = item.title || session?.title || 'untitled session';
  const transcript = session?.lastAssistantFull || session?.lastAssistant || item.detail || '';
  const options = Array.isArray(item.options) ? item.options : [];
  const passive = item.kind === 'pinned' || item.kind === 'recent' || item.kind === 'shell';
  // A session whose agent is gone has nothing to focus on the Mac; it needs reopening first.
  const closed = isClosedSession(data, item);
  const rateLimit = rateLimitFor(data, item);

  const perform = async (name, action) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try { await action(); }
    catch (actionError) { setError({ message: actionError.message || 'Something went wrong', screenTail: actionError.screenTail }); }
    finally { setBusy(null); }
  };
  const sendReply = () => {
    const text = reply.trim();
    if (text) perform('send', () => onSend(item, text));
  };
  const toggleConversation = async () => {
    const opening = !conversationOpen;
    setConversationOpen(opening);
    if (!opening || conversation !== null || tailLoading) return;

    const requestId = ++tailRequestRef.current;
    setTailLoading(true);
    setError(null);
    try {
      const result = await api.getSessionTail(config, item.sessionId);
      if (tailRequestRef.current === requestId) setConversation(result.text || 'No recent conversation.');
    } catch (tailError) {
      if (tailRequestRef.current === requestId) {
        setError({ message: tailError.message || 'Could not load the conversation', screenTail: tailError.screenTail });
        setConversationOpen(false);
      }
    } finally {
      if (tailRequestRef.current === requestId) setTailLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={keyboardOffset} style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <View style={styles.sessionHeader}>
          <Button onPress={onBack} quiet style={styles.backButton} styles={styles} textStyle={styles.backText}>‹ Back</Button>
          <Text style={styles.sessionTitle}>{title}</Text>
          <View style={styles.sessionMeta}>
            <Chip dotHue={project.h} styles={styles}>{project.name}</Chip>
            {item.taskId ? <Text style={styles.cardId}>{item.taskId}</Text> : null}
            {tags.map((tag) => <Text key={tag} style={styles.tag}>#{tag}</Text>)}
            <Text style={styles.tag}>{kindLabel(item.kind)}</Text>
          </View>
          {item.sessionId ? (
            <Pressable accessibilityRole="button" onPress={() => onOpenScreen(item)} style={({ pressed }) => [styles.openScreenLink, pressed && styles.pressed]}>
              <Text style={styles.openScreenText}>{closed ? 'Open last screen ›' : 'Open screen ›'}</Text>
            </Pressable>
          ) : null}
        </View>

        {item.sessionId ? (
          <View style={styles.answerArea}>
            {rateLimit ? (
              <View style={styles.options}>
                <Button
                  disabled={Boolean(busy)}
                  loading={busy === 'continue'}
                  onPress={() => perform('continue', () => onSend(item, 'continue'))}
                  quiet
                  style={styles.optionButton}
                  styles={styles}
                >
                  <Text style={styles.optionNumber}>1</Text>
                  <Text style={styles.optionText}>Continue</Text>
                </Button>
                <Button
                  disabled={Boolean(busy)}
                  loading={busy === 'parked'}
                  onPress={() => perform('parked', () => onDismiss({ ...item, key: item.key || rateLimit.key }))}
                  quiet
                  style={styles.optionButton}
                  styles={styles}
                >
                  <Text style={styles.optionNumber}>2</Text>
                  <Text style={styles.optionText}>Leave parked</Text>
                </Button>
              </View>
            ) : null}
            {item.kind === 'question' ? (
              <>
                <View style={styles.questionBlock}>
                  <Markdown base={styles.questionText} styles={styles} text={item.question || item.detail || 'Choose an answer'} />
                </View>
                <View style={styles.options}>
                  {options.map((option, index) => (
                    <Button
                      disabled={Boolean(busy)}
                      key={`${index}:${optionLabel(option)}`}
                      loading={busy === `answer-${index}`}
                      onPress={() => perform(`answer-${index}`, () => onAnswer(item, index + 1, optionLabel(option)))}
                      quiet
                      style={styles.optionButton}
                      styles={styles}
                    >
                      <Text style={styles.optionNumber}>{index + 1}</Text>
                      <Text style={styles.optionText}>
                        {optionLabel(option)}{option?.recommended || option?.rec ? ' · recommended' : ''}
                      </Text>
                    </Button>
                  ))}
                </View>
              </>
            ) : null}
            <View style={styles.replyRow}>
              <TextInput
                autoCapitalize="sentences"
                maxLength={2000}
                multiline
                onChangeText={setReply}
                onContentSizeChange={(event) => setReplyHeight(Math.max(44, Math.min(96, event.nativeEvent.contentSize.height + 2)))}
                placeholder={item.kind === 'question' ? 'Or type your own answer…' : 'Reply to this session…'}
                placeholderTextColor={styles.colors.faint}
                style={[styles.replyInput, { height: replyHeight }]}
                textAlignVertical="top"
                value={reply}
              />
              <Button disabled={!reply.trim() || Boolean(busy)} loading={busy === 'send'} onPress={sendReply} style={styles.sendButton} styles={styles}>Send</Button>
            </View>
            <InlineError error={error} styles={styles} />
          </View>
        ) : <View style={styles.answerArea}><InlineError error={error} styles={styles} /></View>}

        <Text style={styles.lastHeader}>Last from the agent</Text>
        <View style={styles.terminal}>
          {transcript
            ? <Markdown base={styles.terminalText} styles={styles} text={transcript} />
            : <Text style={styles.terminalEmpty}>No assistant message available.</Text>}
          {item.sessionId ? (
            <View style={styles.earlierBlock}>
              <Pressable accessibilityRole="button" onPress={toggleConversation} style={({ pressed }) => [styles.earlierLink, pressed && styles.pressed]}>
                <Text style={styles.earlierLinkText}>{conversationOpen ? 'Hide earlier conversation' : 'Earlier in this conversation'}</Text>
              </Pressable>
              {tailLoading ? <ActivityIndicator color={styles.colors.info} size="small" /> : null}
              {conversationOpen && conversation !== null ? (
                <View style={styles.earlierTranscript}>
                  <Markdown base={styles.terminalText} styles={styles} text={conversation} />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <View style={styles.bottomActions}>
        <Button disabled={passive || Boolean(busy)} loading={busy === 'snooze'} onPress={() => perform('snooze', () => onSnooze(item))} quiet style={styles.actionButton} styles={styles}>Snooze 1h</Button>
        <Button disabled={passive || Boolean(busy)} loading={busy === 'dismiss'} onPress={() => perform('dismiss', () => onDismiss(item))} quiet style={styles.actionButton} styles={styles}>Dismiss</Button>
        {closed ? (
          <Button disabled={!item.sessionId || Boolean(busy)} loading={busy === 'reopen'} onPress={() => perform('reopen', () => onReopen(item))} quiet style={styles.actionButton} styles={styles}>Reopen</Button>
        ) : (
          <Button disabled={!item.sessionId || Boolean(busy)} loading={busy === 'focus'} onPress={() => perform('focus', () => onFocus(item))} quiet style={styles.actionButton} styles={styles}>On Mac</Button>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
