import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { knownProjects, projectFor } from '../model';
import { Button, InlineError } from '../ui';

const AGENTS = [['claude', 'Claude'], ['codex', 'Codex']];

function Choice({ children, onPress, selected, styles }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.newChoice, selected && styles.newChoiceSelected, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

export default function NewSession({ data, keyboardOffset = 0, onBack, onStartShell, onStartSession, styles }) {
  const [tab, setTab] = useState('card');
  const [filter, setFilter] = useState('');
  const [cardId, setCardId] = useState(null);
  const [agent, setAgent] = useState('claude');
  const [message, setMessage] = useState('');
  const [projectPath, setProjectPath] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const projects = useMemo(() => knownProjects(data), [data]);
  const cards = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (data.tasks || [])
      .filter((task) => ['active', 'waiting', 'blocked', 'review'].includes(task.fm?.status))
      .filter((task) => !needle || [task.id, task.fm?.title, task.fm?.project]
        .some((value) => String(value || '').toLowerCase().includes(needle)))
      .slice(0, 40);
  }, [data.tasks, filter]);

  // A selection only counts while it is on screen: a filter or a state poll can drop
  // the chosen card or project, and Start must not launch something invisible.
  const selectedCard = cards.find((task) => task.id === cardId) || null;
  const selectedProject = projects.find((project) => project.path === projectPath) || null;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === 'card') {
        if (!selectedCard) throw new Error('Pick a card first');
        await onStartSession({ taskId: selectedCard.id, agent, message: message.trim() });
      } else {
        if (!selectedProject) throw new Error('Pick a project first');
        await onStartShell(selectedProject.path);
      }
    } catch (startError) {
      setError({ message: startError.message || 'Could not start it' });
    } finally { setBusy(false); }
  };

  const ready = tab === 'card' ? Boolean(selectedCard) : Boolean(selectedProject);

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={keyboardOffset} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.newContent} keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <Button onPress={onBack} quiet style={styles.backButton} styles={styles} textStyle={styles.backText}>‹ Back</Button>
        <Text style={styles.newTitle}>Start something new</Text>

        <View style={styles.newTabs}>
          {[['card', 'Agent on a card'], ['shell', 'Shell in a project']].map(([id, label]) => (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === id }}
              key={id}
              onPress={() => { setTab(id); setError(null); }}
              style={({ pressed }) => [styles.newTab, tab === id && styles.newTabSelected, pressed && styles.pressed]}
            >
              <Text style={[styles.newTabText, tab === id && styles.newTabTextSelected]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {tab === 'card' ? (
          <>
            <Text style={styles.inputLabel}>Card</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setFilter}
              placeholder="Filter cards"
              placeholderTextColor={styles.colors.faint}
              style={styles.input}
              value={filter}
            />
            <View style={styles.newList}>
              {cards.length ? cards.map((task) => {
                const project = projectFor(task.fm?.project || '');
                return (
                  <Choice key={task.id} onPress={() => setCardId(task.id)} selected={cardId === task.id} styles={styles}>
                    <View style={[styles.projectDot, { backgroundColor: `hsl(${project.h}, 56%, 48%)` }]} />
                    <View style={styles.newChoiceBody}>
                      <Text numberOfLines={1} style={styles.newChoiceTitle}>{task.fm?.title || task.id}</Text>
                      <Text numberOfLines={1} style={styles.newChoiceMeta}>{project.name} · {task.fm?.status} · {task.id}</Text>
                    </View>
                  </Choice>
                );
              }) : <Text style={styles.newEmpty}>No open cards match that filter.</Text>}
            </View>

            <Text style={styles.inputLabel}>Agent</Text>
            <View style={styles.newRow}>
              {AGENTS.map(([id, label]) => (
                <Choice key={id} onPress={() => setAgent(id)} selected={agent === id} styles={styles}>
                  <Text style={styles.newChoiceTitle}>{label}</Text>
                </Choice>
              ))}
            </View>

            <Text style={styles.inputLabel}>Opening message (optional)</Text>
            <TextInput
              autoCapitalize="sentences"
              maxLength={2000}
              multiline
              onChangeText={setMessage}
              placeholder="What should it pick up?"
              placeholderTextColor={styles.colors.faint}
              style={[styles.input, styles.newMessage]}
              textAlignVertical="top"
              value={message}
            />
          </>
        ) : (
          <>
            <Text style={styles.inputLabel}>Project</Text>
            <View style={styles.newList}>
              {projects.length ? projects.map((project) => (
                <Choice
                  key={project.key}
                  onPress={() => setProjectPath(project.path)}
                  selected={projectPath === project.path}
                  styles={styles}
                >
                  <View style={[styles.projectDot, { backgroundColor: `hsl(${project.h}, 56%, 48%)` }]} />
                  <View style={styles.newChoiceBody}>
                    <Text numberOfLines={1} style={styles.newChoiceTitle}>{project.name}</Text>
                    <Text numberOfLines={1} style={styles.newChoiceMeta}>{project.path}</Text>
                  </View>
                </Choice>
              )) : <Text style={styles.newEmpty}>No projects in the current fleet state.</Text>}
            </View>
            <Text style={styles.newHint}>A shell opens a plain zsh pane on the Mac and lands you in its terminal.</Text>
          </>
        )}

        <InlineError error={error} styles={styles} />
      </ScrollView>
      <View style={styles.bottomActions}>
        <Button
          disabled={!ready || busy}
          loading={busy}
          onPress={start}
          style={styles.actionButton}
          styles={styles}
        >
          {tab === 'card' ? 'Start session' : 'Open shell'}
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
}
