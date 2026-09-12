'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('./codex-handoff-support');
const sid = '12345678-1234-1234-1234-123456789abc';
function context(mode = 'read-only') {
  return { cwd: '/project', workspace_roots: ['/project'], model: 'gpt-5.6-sol', effort: 'high', approval_policy: 'never', approvals_reviewer: 'user',
    sandbox_policy: { type: mode }, permission_profile: mode === 'danger-full-access' ? { type: 'disabled' } :
      { type: 'managed', network: 'restricted', file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] } } };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-support-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function rollout(dir, turns, meta = {}) {
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, [{ type: 'session_meta', payload: { id: sid, model_provider: 'openai', ...meta } }, ...turns.map(payload => ({ type: 'turn_context', payload }))].map(JSON.stringify).join('\n') + '\n');
  return file;
}
test('resume uses latest effective model, effort and permission settings', t => {
  const dir = temp(t), latest = context('danger-full-access'); latest.model = 'gpt-6-astra'; latest.effort = 'low';
  const spec = support.readResumeSpec(rollout(dir, [context(), latest]), sid);
  assert.equal(spec.model, latest.model); assert.equal(spec.effort, 'low'); assert.equal(spec.cwd, '/project');
  assert.deepEqual(spec.argv, ['codex', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '-c', 'approvals_reviewer="user"', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="low"', 'resume', sid]);
  assert.match(spec.digest, /^[a-f0-9]{64}$/);
});
test('refuses unknown, named, externally sandboxed and narrowed effective policies', () => {
  for (const change of [c => { c.sandbox_policy.type = 'external-sandbox'; }, c => { c.active_permission_profile = { id: 'custom' }; }, c => { c.workspace_roots.push('/other'); }, c => { c.permission_profile.file_system.entries = []; }, c => { c.approval_policy = 'new-policy'; }, c => { c.permission_profile.network = 'enabled'; }]) {
    const c = context(); change(c); assert.throws(() => support.policyArgs(c), /Codex native handoff unavailable/);
  }
});
test('workspace policy explicitly overrides destination writable roots, network and tmp settings', () => {
  const c = context(); c.sandbox_policy = { type: 'workspace-write', writable_roots: ['/extra'], network_access: true, exclude_slash_tmp: true, exclude_tmpdir_env_var: true };
  c.permission_profile.network = 'enabled';
  for (const root of ['/project', '/extra']) {
    c.permission_profile.file_system.entries.push({ path: { type: 'path', path: root }, access: 'write' });
    for (const name of ['.git', '.agents', '.codex']) c.permission_profile.file_system.entries.push({ path: { type: 'path', path: `${root}/${name}` }, access: 'read', missing_path_behavior: 'skip' });
  }
  const argv = support.policyArgs(c);
  assert.ok(argv.includes('sandbox_workspace_write.writable_roots=["/extra"]'));
  assert.ok(argv.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(argv.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
  c.permission_profile.file_system.entries.push({ path: { type: 'path', path: '/secret' }, access: 'none' });
  assert.throws(() => support.policyArgs(c), /effective permissions differ/);
});
test('rollout rejects wrong identity, child, incomplete data, symlink and size bound', t => {
  const dir = temp(t);
  assert.throws(() => support.readResumeSpec(rollout(dir, [context()], { id: 'different' }), sid), /identity/);
  assert.throws(() => support.readResumeSpec(rollout(dir, [context()], { parent_thread_id: sid }), sid), /owning root/);
  assert.throws(() => support.readResumeSpec(rollout(dir, []), sid), /settings are missing/);
  const file = rollout(dir, [context()]); fs.appendFileSync(file, '{');
  assert.throws(() => support.readResumeSpec(file, sid), /incomplete records/);
  rollout(dir, [context()]); assert.throws(() => support.readResumeSpec(file, sid, { maxBytes: 10 }), /bounded regular/);
  const link = path.join(dir, 'link'); fs.symlinkSync(file, link); assert.throws(() => support.readResumeSpec(link, sid));
});
test('provider parity permits target-local credentials but refuses endpoint differences', t => {
  const dir = temp(t); const source = { agent: 'codex', configDir: path.join(dir, 'source') }, target = { agent: 'codex', configDir: path.join(dir, 'target') };
  fs.mkdirSync(source.configDir); fs.mkdirSync(target.configDir);
  const cfg = (url, key) => `model_provider="fixture"\n[model_providers.fixture]\nbase_url="${url}"\nenv_key="${key}"\n`;
  fs.writeFileSync(path.join(source.configDir, 'config.toml'), cfg('http://localhost', 'SOURCE_KEY'));
  fs.writeFileSync(path.join(target.configDir, 'config.toml'), cfg('http://localhost', 'TARGET_KEY'));
  assert.equal(support.compatible(source, target, { provider: 'fixture' }).ok, true);
  fs.writeFileSync(path.join(target.configDir, 'config.toml'), cfg('http://different', 'TARGET_KEY'));
  assert.equal(support.compatible(source, target, { provider: 'fixture' }).ok, false);
  assert.equal(support.compatible(source, target, { provider: 'openai' }).ok, false);
});
test('auth preflight fails closed without exposing auth output', async () => {
  const account = { agent: 'codex', configDir: '/profile' };
  assert.equal(await support.authPreflight(account, { runAuthStatus: async () => true }), true);
  assert.equal(await support.authPreflight(account, { runAuthStatus: async () => 'secret' }), false);
  assert.equal(await support.authPreflight(account, { runAuthStatus: async () => { throw new Error('secret'); } }), false);
  assert.equal(await support.authPreflight({ agent: 'claude', configDir: '/profile' }, { runAuthStatus: async () => true }), false);
});
