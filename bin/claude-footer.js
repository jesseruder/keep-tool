'use strict';

// What Claude Code's own footer says is still running in a pane: background shells
// and background agents. Keep's transcript ledger sees only what the main session
// launched; a subagent resumed with SendMessage, or a shell a subagent started, shows
// only here. The footer is Claude Code's UI, not an API, so everything that reads it
// also checks it against signals it does not depend on (bin/footer-health.js).
//
// Shapes read (Claude Code, September 2026):
//   ✻ Cooked for 2m 25s · done 9:50 AM · 1 shell still running
//   ⏵⏵ bypass permissions on · 2 shells · ← for agents
//   ✻ Waiting for 1 background agent to finish
//     ● main
//     ◯ general-purpose  Verifying clamp tests
// and the input box: a ❯ line between two ──── rules.

const RULE = /^\s*─{10,}\s*$/;
const PROMPT = /^\s*❯/;

// The last `lines` rows of a rendered screen, trailing blanks already trimmed by the
// host (renderScreen ends at the last non-blank row).
function read(lines) {
  const rows = (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map((row) => String(row || ''));
  // The input box: a prompt row with a rule above it and one below.
  let box = -1;
  for (let i = rows.length - 1; i >= 1 && box < 0; i -= 1) {
    if (PROMPT.test(rows[i]) && RULE.test(rows[i - 1])) {
      for (let j = i + 1; j < rows.length; j += 1) if (RULE.test(rows[j])) { box = i; break; }
    }
  }
  if (box < 0) return { recognized: false, shells: null, agents: null, running: null };
  // Joined with spaces, so a mode line wrapped between "1" and "shell" still reads.
  const text = rows.join(' ');
  const counts = (pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1])).filter(Number.isFinite);
  const shells = Math.max(0, ...counts(/\b(\d+)\s+shells?\s+still\s+running\b/g), ...counts(/·\s*(\d+)\s+shells?\b/g));
  const waiting = Math.max(0, ...counts(/\bWaiting\s+for\s+(\d+)\s+background\s+agents?\s+to\s+finish\b/g));
  // One ◯ row per running background agent, listed under the ● main row.
  const rowsBelow = rows.slice(box + 1);
  const agentRows = rowsBelow.filter((row) => /^\s*◯\s+\S/.test(row)).length;
  const agents = Math.max(waiting, agentRows);
  // A spinner row ("✶ Enchanting… (4m 50s ·") means the turn itself is still running.
  // The label is a verb or, with a todo list, the current todo: any words before "… (".
  const turnRunning = rows.slice(0, box).some((row) => /^\s*[✻✶✢✳✽✦✧*·]\s+.+…\s*\(/.test(row));
  return { recognized: true, shells, agents, turnRunning, running: shells > 0 || agents > 0 };
}

module.exports = { read };
