'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshot, update } = require('./reminders');

function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reminders-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { KEEP_REMINDERS_CONFIG: path.join(root, 'reminders.config.json'), KEEP_REMINDERS_STATE: path.join(root, 'state', 'state.json') };
  if (config) fs.writeFileSync(env.KEEP_REMINDERS_CONFIG, JSON.stringify(config));
  return env;
}
const config = { reminders: [
  { title: 'Stretch', message: 'Neck stretch', type: 'interval', everyMinutes: 30 },
  { title: 'Lunch', message: 'Take a lunch break', type: 'daily', at: '12:00', days: ['mon', 'fri'] },
] };

test('no config on this machine hides the section', (t) => {
  assert.equal(snapshot(fixture(t)), null);
});
test('every reminder is on until the daemon state file says otherwise', (t) => {
  const env = fixture(t, config);
  assert.deepEqual(snapshot(env), [
    { title: 'Stretch', message: 'Neck stretch', schedule: 'every 30 min', enabled: true },
    { title: 'Lunch', message: 'Take a lunch break', schedule: 'daily at 12:00 · mon fri', enabled: true },
  ]);
  fs.mkdirSync(path.dirname(env.KEEP_REMINDERS_STATE), { recursive: true });
  fs.writeFileSync(env.KEEP_REMINDERS_STATE, 'not json');
  assert.ok(snapshot(env).every((reminder) => reminder.enabled));
});
test('toggling writes the disabled list the daemon reads and keeps titles no longer configured', (t) => {
  const env = fixture(t, config);
  const read = () => JSON.parse(fs.readFileSync(env.KEEP_REMINDERS_STATE, 'utf8'));
  update({ title: 'Stretch', enabled: false }, env, 1000);
  assert.deepEqual(read(), { disabled: ['Stretch'], enabledAt: {} });
  assert.deepEqual(snapshot(env).map((reminder) => [reminder.title, reminder.enabled]), [['Stretch', false], ['Lunch', true]]);
  update({ title: 'Stretch', enabled: false }, env, 2000);
  fs.writeFileSync(env.KEEP_REMINDERS_STATE, JSON.stringify({ disabled: ['Stretch', 'Old'], enabledAt: { Lunch: 5 } }));
  update({ title: 'Stretch', enabled: true }, env, 3000);
  assert.deepEqual(read(), { disabled: ['Old'], enabledAt: { Lunch: 5, Stretch: 3000 } }, 'switching on records when, for the daemon interval restart');
  update({ title: 'Stretch', enabled: true }, env, 4000);
  assert.equal(read().enabledAt.Stretch, 3000, 'a repeated switch-on neither restarts nor forgets the interval restart');
  update({ title: 'Stretch', enabled: false }, env, 5000);
  assert.deepEqual(read(), { disabled: ['Old', 'Stretch'], enabledAt: { Lunch: 5 } });
});
test('rejects unknown titles and malformed bodies', (t) => {
  const env = fixture(t, config);
  assert.throws(() => update({ title: 'Nope', enabled: false }, env), /no longer in the config/);
  assert.throws(() => update({ title: 'Stretch', enabled: 'no' }, env), /Invalid/);
  assert.throws(() => update({ title: 'Stretch', enabled: false }, fixture(t)), /No reminders config/);
  assert.equal(fs.existsSync(env.KEEP_REMINDERS_STATE), false);
});
