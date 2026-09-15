'use strict';

// Desktop reminders (jesseland's reminders daemon) switched on and off from the
// Notifications panel. The daemon owns the schedule in its config; Keep only writes
// the list of titles that are off, to a state file the daemon re-reads every tick.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const expand = (file) => path.resolve(String(file).replace(/^~(?=\/|$)/, os.homedir()));
function paths(env = process.env) {
  return {
    config: expand(env.KEEP_REMINDERS_CONFIG || '~/jesseland/reminders/reminders.config.json'),
    state: expand(env.KEEP_REMINDERS_STATE || '~/.config/reminders/state.json'),
  };
}
function readDisabled(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.disabled) ? parsed.disabled.map(String) : [];
  } catch { return []; }
}
function schedule(reminder) {
  if (reminder.type === 'interval') return `every ${reminder.everyMinutes} min`;
  if (reminder.type === 'daily') return `daily at ${reminder.at}${Array.isArray(reminder.days) && reminder.days.length ? ` · ${reminder.days.join(' ')}` : ''}`;
  return String(reminder.type || '');
}
// null when there is no reminders daemon config on this machine: the panel hides the section.
function snapshot(env = process.env) {
  const { config, state } = paths(env);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(config, 'utf8')); } catch { return null; }
  if (!Array.isArray(parsed?.reminders)) return null;
  const disabled = new Set(readDisabled(state));
  return parsed.reminders.filter((reminder) => reminder && typeof reminder.title === 'string' && reminder.title)
    .map((reminder) => ({ title: reminder.title, message: String(reminder.message || ''), schedule: schedule(reminder), enabled: !disabled.has(reminder.title) }));
}
function update(body, env = process.env) {
  const current = snapshot(env);
  if (!current) throw new Error('No reminders config found');
  if (!body || typeof body.title !== 'string' || typeof body.enabled !== 'boolean') throw new Error('Invalid reminder update');
  if (!current.some((reminder) => reminder.title === body.title)) throw new Error('Reminder is no longer in the config');
  const { state } = paths(env);
  // Keep titles that are off but absent from the config, so a later re-add stays off.
  const disabled = readDisabled(state).filter((title) => title !== body.title);
  if (!body.enabled) disabled.push(body.title);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  const temp = `${state}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ disabled }) + '\n');
  fs.renameSync(temp, state);
  return { ok: true };
}
module.exports = { snapshot, update, paths };
