'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const config = require('./config');
const features = require('./features.js');
const SOURCE = path.resolve(__dirname, '..');
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function options(args, flags) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!flags.includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`expected ${flags.join(', ')} with a value`);
    out[key.slice(2)] = args[++i];
  }
  return out;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function canonicalPath(value) {
  let ancestor = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve path: ${value}`);
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function insideSource(value) {
  const real = canonicalPath(value);
  const source = fs.realpathSync(SOURCE);
  return real === source || real.startsWith(source + path.sep);
}

function init(args) {
  const opts = options(args, ['--dir']);
  const root = canonicalPath((opts.dir || process.env.KEEP_DIR || path.join(os.homedir(), 'keep')).replace(/^~(?=\/|$)/, os.homedir()));
  const file = config.configFile();
  if (fs.existsSync(file)) throw new Error(`configuration already exists at ${file}; inspect it before initializing another registry`);
  if (insideSource(root)) throw new Error('the registry must be outside the application checkout');
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`directory is not empty: ${root}; existing registries can be selected with KEEP_DIR`);
  if (insideSource(file)) throw new Error('the configuration must be outside the application checkout');
  // Build a sibling repository first. Missing identity, signing failures, or Git
  // hook errors must not leave a half-initialized target that init then refuses.
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(root), '.keep-init-'));
  try {
    git(staging, ['init', '-q']);
    for (const key of ['user.name', 'user.email']) {
      try { if (!git(staging, ['config', '--get', key])) throw new Error(); }
      catch { throw new Error(`configure git ${key} globally or for the new registry before running keep init`); }
    }
    for (const dir of ['tasks', 'archive', 'digests', 'reviews', 'watch', 'steps']) {
      fs.mkdirSync(path.join(staging, dir));
      fs.writeFileSync(path.join(staging, dir, '.gitkeep'), '');
    }
    fs.writeFileSync(path.join(staging, '.gitignore'), '.keep/\n.env\n.env.*\n*.pem\n*.key\n');
    git(staging, ['add', '.']);
    git(staging, ['commit', '-qm', 'Initialize private Keep registry']);
    // rename refuses a nonempty destination, including one populated meanwhile.
    fs.renameSync(staging, root);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Optional features a fresh install has no accounts or channels for start off;
  // `keep doctor` lists them. Existing configurations have no `features` key and
  // keep every feature on.
  fs.writeFileSync(file, JSON.stringify({ version: 1, dataDir: root, env: {
    KEEP_NO_PUSH: '1', KEEP_SYNC: '0', KEEP_HOST: '127.0.0.1',
    KEEP_REVIEWER_MODEL: 'fable', KEEP_IDEAS_MODEL: 'fable',
    KEEP_REVIEW_CADENCE: 'events', KEEP_REVIEW_SWEEP_AT: '07:45',
    KEEP_OPEN_CLAUDE_FLAGS: '', KEEP_OPEN_CODEX_FLAGS: '',
  }, features: { ...features.INIT_FEATURES } }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Created private registry: ${root}\nConfiguration: ${file}\nNext: keep setup hooks, then keep doctor. No remote was configured.`);
}

// ---------- skill packs ----------

// A pack is a named set of skills shipped in `skills/`. `core` is always installed;
// every other pack a machine has chosen is recorded in the configuration, so a later
// `keep setup hooks` on the same machine reinstalls exactly what it had.
const SKILL_HOMES = ['.claude', '.agents'];
const CORE_PACK = 'core';

function skillSource(skill) {
  return path.join(SOURCE, 'skills', skill);
}

function loadPacks() {
  const file = path.join(SOURCE, 'skills', 'packs.json');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`unreadable skill packs at ${file} (${error.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`skill packs at ${file} are not a JSON object`);
  for (const [name, pack] of Object.entries(value)) {
    if (!pack || !Array.isArray(pack.skills) || !pack.skills.length) throw new Error(`skill pack ${name} lists no skills in ${file}`);
    for (const skill of pack.skills) {
      const skillFile = path.join(skillSource(skill), 'SKILL.md');
      if (!fs.existsSync(skillFile)) throw new Error(`skill pack ${name} names a skill that is not in this checkout: ${skillFile}`);
    }
  }
  if (!value[CORE_PACK]) throw new Error(`skill packs at ${file} have no ${CORE_PACK} pack`);
  return value;
}

// Pack names recorded by an earlier `keep setup skills`. A recorded name this
// checkout no longer ships is ignored rather than fatal: an upgrade that drops a
// pack must not break hook installation.
function configuredPacks(packs = loadPacks(), env = process.env) {
  let value = {};
  try { value = config.load(env); } catch { value = {}; }
  const names = Array.isArray(value.skillPacks) ? value.skillPacks : [];
  return names.filter((name) => typeof name === 'string' && name !== CORE_PACK && packs[name]);
}

function installPackNames(packs = loadPacks(), named = []) {
  return [...new Set([CORE_PACK, ...configuredPacks(packs), ...named])];
}

function sameSkillFile(dest, source) {
  try {
    return fs.readFileSync(path.join(dest, 'SKILL.md')).equals(fs.readFileSync(path.join(source, 'SKILL.md')));
  } catch { return false; }
}

// `<dir>/skills/<skill>` inside some keep-tool checkout: the package manifest two
// directories above the resolved target names this application. A link into another
// checkout is Keep's own and safe to repoint; a link into anything else is the
// user's and is treated like any other skill they installed themselves.
function inKeepCheckout(resolved) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, '..', '..', 'package.json'), 'utf8'));
    return manifest && manifest.name === 'keep-tool';
  } catch { return false; }
}

// What one destination should become. The interesting case is a Keep link left by an
// older checkout path, a deleted worktree, or the pre-pack `docs/agent-skills`
// location: a dangling link has nothing to lose, and a live one into another
// keep-tool checkout is ours to repoint.
function skillPlan(skill, pack, dest) {
  const source = skillSource(skill);
  const base = { skill, pack, dest, source };
  const link = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!link) return { ...base, action: 'link' };
  let resolved = null;
  try { resolved = fs.realpathSync(dest); } catch {}
  if (resolved && resolved === fs.realpathSync(source)) return { ...base, action: 'ok' };
  if (link.isSymbolicLink()) {
    const text = fs.readlinkSync(dest);
    if (!resolved || inKeepCheckout(resolved)) return { ...base, action: 'relink', from: text };
  }
  // Someone else's skill, or a copy of ours. A byte-identical SKILL.md is an older
  // copy of this very skill and is safe to set aside; anything else needs --replace.
  return { ...base, action: sameSkillFile(dest, source) ? 'migrate' : 'replace' };
}

// The directory a destination really lands in. `~/.agents/skills` is often a symlink
// to `~/.claude/skills`, including one whose target does not exist yet: resolving the
// link text is what keeps the two homes from being planned as two destinations and
// the second apply from failing on what the first just created.
function skillDestKey(dest, skill) {
  const parent = path.dirname(dest);
  const link = fs.lstatSync(parent, { throwIfNoEntry: false });
  // canonicalPath resolves the symlinked ancestors a destination does have, so a
  // directory that exists and one that does not yet both key on the same name.
  const target = link && link.isSymbolicLink() ? path.resolve(path.dirname(parent), fs.readlinkSync(parent)) : parent;
  try { return path.join(canonicalPath(target), skill); } catch { return path.join(target, skill); }
}

// Every destination for every named pack, preflighted before anything is written.
// `probe` reports conflicts as plans instead of refusing, for --list and doctor.
function skillPlans(packNames, { replace = false, probe = false, packs = loadPacks() } = {}) {
  const plans = [];
  const seen = new Set();
  for (const name of packNames) {
    const pack = packs[name];
    if (!pack) throw new Error(`unknown skill pack ${name}; known packs: ${Object.keys(packs).join(', ')}`);
    for (const skill of pack.skills) {
      for (const home of SKILL_HOMES) {
        const dest = path.join(os.homedir(), home, 'skills', skill);
        const key = skillDestKey(dest, skill);
        if (seen.has(key)) continue;
        seen.add(key);
        plans.push(skillPlan(skill, name, dest));
      }
    }
  }
  const blocked = plans.filter((plan) => plan.action === 'replace');
  if (blocked.length && !replace && !probe) {
    throw new Error(`Keep skill links changed nothing:\n  ${blocked
      .map((plan) => `${plan.dest} is not a Keep skill link; run keep setup skills --replace to back it up and link`).join('\n  ')}`);
  }
  return plans;
}

// The timestamp alone is not unique: two backups of the same skill in one millisecond
// collide, and so does a second run against a clock that has not moved. renameSync
// would replace what is already there without a word — and a displaced foreign skill
// can itself be a symlink, so the thing being overwritten is somebody's only copy.
function freeBackupPath(candidate) {
  let target = candidate;
  for (let n = 1; fs.lstatSync(target, { throwIfNoEntry: false }); n++) target = `${candidate}-${n}`;
  return target;
}

function applySkillPlans(plans) {
  for (const plan of plans) {
    if (plan.action === 'ok') continue;
    if (plan.action === 'relink') fs.unlinkSync(plan.dest);
    if (plan.action === 'migrate' || plan.action === 'replace') {
      // Beside the skills directory, never inside it: an agent loads every directory
      // under `skills` that has a SKILL.md, so a backup left there would come back as
      // a second copy of the skill under its backup name. The home the destination
      // names is the one that keeps it, shared parent or not.
      const attic = path.join(path.dirname(path.dirname(plan.dest)), 'skill-backups');
      fs.mkdirSync(attic, { recursive: true });
      plan.backup = freeBackupPath(path.join(attic, `${plan.skill}.keep-backup-${Date.now()}`));
      fs.renameSync(plan.dest, plan.backup);
    }
    // Never touch the parent: `~/.agents/skills` is often a symlink itself.
    if (!fs.existsSync(path.dirname(plan.dest))) fs.mkdirSync(path.dirname(plan.dest), { recursive: true });
    try { fs.symlinkSync(plan.source, plan.dest); }
    catch (error) {
      // Two homes that share a directory can still reach the same link twice.
      // A destination that already points at the source is done, not a failure.
      let resolved = null;
      try { resolved = fs.realpathSync(plan.dest); } catch {}
      if (error.code !== 'EEXIST' || resolved !== fs.realpathSync(plan.source)) throw error;
    }
  }
  return plans;
}

const SKILL_ACTIONS = {
  link: 'Linked skill', relink: 'Repaired stale skill link',
  migrate: 'Replaced an identical copy of this skill', replace: 'Replaced skill',
};

function reportSkillPlans(plans) {
  const changed = plans.filter((plan) => plan.action !== 'ok');
  for (const plan of changed) {
    const note = plan.backup ? ` (backed up to ${plan.backup})` : plan.from ? ` (was ${plan.from})` : '';
    console.log(`${SKILL_ACTIONS[plan.action]}: ${plan.dest}${note}`);
  }
  if (!changed.length) console.log('Skills up to date.');
  return changed;
}

const SKILL_STATUS = { ok: 'linked', link: 'missing', relink: 'stale link', migrate: 'needs migration', replace: 'needs migration' };
const SKILL_SEVERITY = { ok: 0, link: 1, relink: 2, migrate: 3, replace: 3 };

function listPacks(packs, env = process.env) {
  const recorded = new Set([CORE_PACK, ...configuredPacks(packs, env)]);
  for (const [name, pack] of Object.entries(packs)) {
    const note = name === CORE_PACK ? 'always installed' : recorded.has(name) ? 'recorded' : 'not recorded';
    console.log(`${name} (${note}) — ${pack.description || ''}`.trimEnd());
    const plans = skillPlans([name], { probe: true, packs });
    for (const skill of pack.skills) {
      const worst = plans.filter((plan) => plan.skill === skill)
        .reduce((a, plan) => (SKILL_SEVERITY[plan.action] > SKILL_SEVERITY[a] ? plan.action : a), 'ok');
      console.log(`  ${skill}: ${SKILL_STATUS[worst]}`);
    }
  }
}

// Whether the choice can be recorded at all, checked before anything is linked: an
// unreadable or read-only configuration must refuse the run, not leave the packs
// installed and the choice forgotten until the next upgrade drops them.
function recordPreflight(named, env = process.env) {
  if (!named.length) return;
  const file = config.configFile(env);
  if (!fs.existsSync(file)) return;
  config.load(env);
  fs.accessSync(file, fs.constants.W_OK);
}

// Records the packs this machine has chosen. An isolated KEEP_DIR run has no
// configuration file to write; the install still happens, it just is not remembered.
function recordPacks(named, env = process.env) {
  const file = config.configFile(env);
  if (!fs.existsSync(file)) return false;
  const value = config.load(env);
  const current = Array.isArray(value.skillPacks) ? value.skillPacks.filter((name) => typeof name === 'string') : [];
  const next = [...current];
  for (const name of named) if (name !== CORE_PACK && !next.includes(name)) next.push(name);
  if (next.length !== current.length) {
    value.skillPacks = next;
    // Write beside the configuration and rename over it: a failure here leaves the
    // old file whole rather than a truncated one. The existing permissions are the
    // user's to choose and are carried across.
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.keep-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: fs.statSync(file).mode & 0o777 });
      fs.renameSync(temp, file);
    } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
  }
  return true;
}

function installSkills(args = []) {
  const named = [];
  let replace = false;
  let list = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--replace') replace = true;
    else if (arg === '--list') list = true;
    else if (arg === '--pack') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('expected --pack with a value');
      named.push(value);
    } else throw new Error('usage: keep setup skills [--pack <name>]… [--replace] [--list]');
  }
  const packs = loadPacks();
  for (const name of named) {
    if (!packs[name]) throw new Error(`unknown skill pack ${name}; known packs: ${Object.keys(packs).join(', ')}`);
  }
  if (list) return listPacks(packs);
  const names = installPackNames(packs, named);
  const plans = skillPlans(names, { replace, packs });
  try { recordPreflight(named); }
  catch (error) { throw new Error(`keep setup skills changed nothing: ${error.message}`); }
  applySkillPlans(plans);
  const changed = reportSkillPlans(plans);
  if (named.length && !recordPacks(named)) console.log('No Keep configuration file: the pack choice was not recorded, so name it again next time.');
  console.log(`Installed skill packs: ${names.join(', ')}.${changed.length ? ' Restart agent sessions to load them.' : ''}`);
}

// A list, not a map keyed by event: PreToolUse carries two adapters with different
// matchers — the Bash guard and the question refusal in an unattended session.
const HOOK_DEFS = [
  { event: 'SessionStart', action: 'session-start', matcher: '' },
  { event: 'SessionEnd', action: 'session-end', matcher: '' },
  { event: 'Stop', action: 'stop', matcher: '' },
  { event: 'UserPromptSubmit', action: 'prompt', matcher: '' },
  { event: 'Notification', action: 'notification', matcher: '' },
  { event: 'PreToolUse', action: 'pre-bash', matcher: 'Bash' },
  { event: 'PreToolUse', action: 'pre-question', matcher: 'AskUserQuestion' },
  { event: 'PostToolUse', action: 'post-bash', matcher: 'Bash' },
];
const HOOK_ACTIONS = HOOK_DEFS.map(({ action }) => action);

// A Keep hook command for this action, whatever path or KEEP_CONFIG it names.
// The command embeds the configuration path, so a moved registry would otherwise
// leave the old spelling in place and fire both.
function keepHookRe(action) {
  return new RegExp(`(?:^|[\\s/])keep['"]?\\s+hook\\s+${action}(?![\\w-])`);
}

function mergeHooks(settings, command) {
  const next = structuredClone(settings);
  next.hooks ||= {};
  // A missing `matcher` is Claude Code's "every tool", which is what the unmatched
  // events ask for, so it counts as the same thing as an empty one.
  const matcherOf = (entry) => (entry && entry.matcher != null ? String(entry.matcher) : '');
  for (const { event, action, matcher } of HOOK_DEFS) {
    const entries = next.hooks[event] ||= [];
    const hookCommand = `${command} hook ${action}`;
    const stale = keepHookRe(action);
    let found = false;
    for (const entry of entries) {
      const hooks = (entry && Array.isArray(entry.hooks)) ? entry.hooks : [];
      // A Keep hook under the wrong matcher is not this hook at all: Claude Code
      // would run the question refusal on Bash, or the Bash guard on nothing. Take it
      // out and let the push below put the action back where it belongs.
      const misplaced = matcherOf(entry) !== matcher;
      for (let i = hooks.length - 1; i >= 0; i -= 1) {
        const hook = hooks[i];
        const value = String((hook && hook.command) || '');
        if (value !== hookCommand && !stale.test(value)) continue;
        if (misplaced) { hooks.splice(i, 1); continue; }
        // A Keep hook for the same action under a different spelling is updated
        // in place, never left beside the new one.
        if (hook.command !== hookCommand) hook.command = hookCommand;
        found = true;
      }
    }
    // An entry emptied by that move held nothing but the misplaced hook.
    next.hooks[event] = entries.filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
    if (!found) next.hooks[event].push({ matcher, hooks: [{ type: 'command', command: hookCommand }] });
  }
  return next;
}

// Which of Keep's hook commands a settings file does not carry. A missing or
// unreadable file carries none: an automation account with no settings.json is
// exactly the unguarded case this reports.
function missingHooks(settingsFile) {
  let text = '';
  try { text = fs.readFileSync(settingsFile, 'utf8'); } catch {}
  return HOOK_ACTIONS.filter((action) => !text.includes(` hook ${action}`));
}

// Every Claude settings.json the hooks belong in: the default config directory
// first, then each managed Claude account that keeps its own. Codex accounts have
// their own adapter commands and are never touched here.
function resolveDir(value) {
  try { return canonicalPath(value); } catch { return path.resolve(value); }
}

function hookTargets(env = process.env) {
  const home = path.join(os.homedir(), '.claude');
  const homeKey = resolveDir(home);
  const seen = new Set([homeKey]);
  const targets = [{ id: 'claude/default', dir: home, file: path.join(home, 'settings.json') }];
  let accounts = [];
  try { accounts = require('./accounts').list(env); } catch { accounts = []; }
  for (const account of accounts) {
    if (account.agent !== 'claude') continue;
    const dir = resolveDir(account.configDir);
    // An account that keeps its state in the default directory is that target
    // under its own name, not a second one.
    if (dir === homeKey) { targets[0] = { ...targets[0], id: account.id }; continue; }
    if (seen.has(dir)) continue;
    seen.add(dir);
    targets.push({ id: account.id, dir: account.configDir, file: path.join(account.configDir, 'settings.json') });
  }
  return targets;
}

// The target `--account <id>` names, or null. `claude/default` always means the
// default configuration directory, whatever the account list calls it.
function hookTarget(id, targets, env = process.env) {
  const direct = targets.find((entry) => entry.id === id);
  if (direct) return direct;
  if (id === 'claude/default') return targets[0];
  let account = null;
  try { account = require('./accounts').get(id, env); } catch {}
  if (account && account.agent === 'claude' && resolveDir(account.configDir) === resolveDir(targets[0].dir)) {
    return { ...targets[0], id };
  }
  return null;
}

// What one settings file would become. Parsing every target before writing any of
// them is the point: one unreadable account settings file must not leave the rest
// half-installed.
function hookPlan(target, command) {
  const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : null;
  let value = {};
  if (existing !== null && existing.trim()) {
    try { value = JSON.parse(existing); }
    catch (error) { throw new Error(`${target.id}: unreadable settings at ${target.file} (${error.message})`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${target.id}: settings at ${target.file} are not a JSON object`);
    }
  }
  return { ...target, existing, next: JSON.stringify(mergeHooks(value, command), null, 2) + '\n' };
}

function hookPlans(targets, command) {
  const plans = [];
  const failures = [];
  for (const target of targets) {
    try { plans.push(hookPlan(target, command)); }
    catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(`keep setup hooks changed nothing:\n  ${failures.join('\n  ')}`);
  return plans;
}

// Applies one plan, leaving an already-correct file byte-for-byte alone: a managed
// account whose settings.json is a symlink to the source already has whatever the
// source has.
function writeHooks(plan) {
  if (plan.existing === plan.next) return false;
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  if (plan.existing !== null) {
    fs.copyFileSync(plan.file, `${plan.file}.keep-backup-${Date.now()}`, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(plan.file, plan.next, { mode: 0o600 });
  return true;
}

function installHooks(args = []) {
  const opts = options(args, ['--account']);
  const command = `KEEP_CONFIG=${quote(config.configFile())} ${quote(path.join(SOURCE, 'bin', 'keep'))}`;
  const targets = hookTargets();
  if (opts.account) {
    const target = hookTarget(opts.account, targets);
    if (!target) throw new Error(`no managed Claude account named ${opts.account}`);
    const [plan] = hookPlans([target], command);
    console.log(`${writeHooks(plan) ? 'Installed' : 'Already installed'}: Keep hooks for ${target.id} (${target.file})`);
    return;
  }
  // Preflight every account's settings before writing to any of them, so an
  // unreadable one stops the run instead of leaving the fan-out half done.
  const [defaultPlan, ...accountPlans] = hookPlans(targets, command);
  const settingsFile = defaultPlan.file;
  const existing = defaultPlan.existing;
  // Preflight every destination before changing any settings or skill links. The
  // core pack plus whatever packs this machine chose earlier, so an upgrade keeps
  // the skills the last `keep setup skills` installed.
  const packs = loadPacks();
  const plans = skillPlans(installPackNames(packs), { packs });
  const newText = defaultPlan.next;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (existing !== null && existing !== newText) fs.copyFileSync(settingsFile, `${settingsFile}.keep-backup-${Date.now()}`, fs.constants.COPYFILE_EXCL);
  applySkillPlans(plans);
  fs.writeFileSync(settingsFile, newText, { mode: 0o600 });
  console.log('Installed Claude hooks and the shared Claude/Codex skills. Restart agent sessions to load them.');
  reportSkillPlans(plans);
  // A managed automation account without the hooks has no restart guard and no
  // raw-resume guard, and nothing else installs them there.
  for (const plan of accountPlans) {
    console.log(`${writeHooks(plan) ? 'Installed' : 'Already installed'}: Keep hooks for ${plan.id} (${plan.file})`);
  }
  console.log('Codex event hooks are version-dependent; see docs/agent-hooks.md for the adapter commands.');
}

// ---------- the shell-side half of the raw-resume guard ----------

// `keep hook pre-bash` catches an agent's raw `claude --resume`. Nothing catches
// Owner's own typing, and that is where the 2026-09-09 incident came from: a
// by-hand resume that dropped --dangerously-skip-permissions (the `clauded`
// alias), so the resumed session's classifier denied the CronCreate it existed to
// make.
//
// A shell *function* rather than an alias, and `command claude` inside it: the
// `clauded` alias expands to this function, so the aliased spelling is guarded
// too, and --dangerously-skip-permissions passes straight through.
//
// The launcher's own resume is told apart by KEEP_LAUNCHER, which Keep sets on the
// pane's environment, NOT by KEEP_PANE: every hosted agent's shell inherits
// KEEP_PANE, so exempting it would exempt exactly the sessions this exists for.
// The function unsets the marker before exec'ing, so it never reaches the agent's
// own children (bin/agent-launcher.js strips it on that path too).
const SHELL_START = '# >>> keep shell >>>';
const SHELL_END = '# <<< keep shell <<<';

function shellBlock() {
  return [
    SHELL_START,
    '# keep: route session resumes through the launcher',
    'claude() {',
    '  if [ -n "$KEEP_LAUNCHER" ]; then',
    '    unset KEEP_LAUNCHER',
    '    command claude "$@"',
    '    return',
    '  fi',
    '  if [ -z "$KEEP_RAW_CLAUDE" ]; then',
    '    for a in "$@"; do',
    '      case "$a" in --resume|-r|--continue|-c)',
    `        echo "keep: use 'keep open <session-id>' to resume (KEEP_RAW_CLAUDE=1 claude ... to bypass)" >&2; return 1;;`,
    '      esac',
    '    done',
    '  fi',
    '  command claude "$@"',
    '}',
    SHELL_END,
  ].join('\n');
}

// Replaces the marked block if it is already there, appends it if it is not, and
// is a no-op when the file already holds exactly this block.
function applyShellBlock(text, block) {
  const start = text.indexOf(SHELL_START);
  const end = text.indexOf(SHELL_END);
  if (start !== -1 && end > start) return text.slice(0, start) + block + text.slice(end + SHELL_END.length);
  const prefix = text && !text.endsWith('\n') ? `${text}\n` : text;
  return `${prefix}${prefix ? '\n' : ''}${block}\n`;
}

function shell(args, home = os.homedir()) {
  const unknown = args.find((arg) => arg !== '--shell' && arg !== '--write');
  if (unknown) throw new Error('usage: keep setup --shell [--write]');
  const block = shellBlock();
  if (!args.includes('--write')) {
    console.log(block);
    console.error(`Not written. Append it to ${path.join(home, '.zshrc')} yourself, or run keep setup --shell --write.`);
    return;
  }
  const file = path.join(home, '.zshrc');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = applyShellBlock(existing, block);
  if (next === existing) {
    console.log(`${file} already has the keep shell block.`);
    return;
  }
  fs.writeFileSync(file, next);
  console.log(`Wrote the keep shell block to ${file}. Open a new shell, or run: source ${file}`);
}

function servicePlist(kind, root, envPath = process.env.PATH || '', overrides = {}) {
  const label = `games.castle.keep.${kind}`;
  // A node agent's host answers for another machine's registry and has none of its
  // own, so it is given its identity and its socket instead of KEEP_DIR/KEEP_CONFIG.
  const env = overrides.env || { PATH: envPath, KEEP_NODE: process.execPath, KEEP_DIR: root, KEEP_CONFIG: config.configFile(), LANG: process.env.LANG || 'en_US.UTF-8' };
  const log = overrides.log || path.join(root, '.keep', `${kind}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(path.join(SOURCE, 'bin', 'keep'))}</string><string>${kind}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}

// systemd splits an unquoted value on whitespace and reads its own escapes in it,
// so every path and every value goes in double quotes with the two characters that
// syntax reserves escaped. A checkout under "Application Support" is not exotic.
//
// `%` is escaped too, and outside the quotes it would still be: systemd resolves
// its specifiers before it parses quoting, so a literal percent must be doubled
// wherever it appears. A scoped IPv6 address — `[fe80::1%en0]:7777` — carries one.
function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function hostUnit(env) {
  return [
    '[Unit]',
    'Description=Keep terminal host',
    'After=network.target',
    '',
    '[Service]',
    `ExecStart=${systemdQuote(path.join(SOURCE, 'bin', 'keep'))} ${systemdQuote('host')}`,
    ...Object.entries(env).map(([key, value]) => `Environment=${key}=${systemdQuote(value)}`),
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const NODE_USAGE = 'usage: keep node init <name> --daemon-node <name> --listen <ip:port> --token-file <path> [--sock <path>] [--daemon-url http://<ip:port>]';

// `keep node init` runs on the node, not on the daemon: it installs the host on its
// own, with no daemon and no registry, listening for the daemon that minted its
// token. `keep nodes add` on the daemon prints the exact line to run here.
function node(args, root, home = os.homedir()) {
  const [action, name, ...rest] = args;
  if (action !== 'init' || !name || name.startsWith('--')) throw new Error(NODE_USAGE);
  const opts = options(rest, ['--daemon-node', '--listen', '--token-file', '--sock', '--daemon-url']);
  if (!config.NODE_NAME_RE.test(name)) throw new Error(`a node name is lowercase letters and digits: ${name}`);
  const daemonNode = opts['daemon-node'];
  if (!daemonNode || !config.NODE_NAME_RE.test(daemonNode)) throw new Error(NODE_USAGE);
  if (daemonNode === name) throw new Error(`${name} cannot be its own daemon node; --daemon-node names the machine running keep serve`);
  if (!opts.listen) throw new Error(NODE_USAGE);
  // The same refusal the host makes, made here: a node binds the interface it was
  // given a token for, never every interface the machine happens to have.
  const host = require('./host.js');
  // parseListenAddress refuses a hostname, an unreadable literal and a zone on
  // anything but a link-local address; assertBindable refuses the wildcards. Both
  // happen here, before a file is written, and not again at boot.
  const listen = host.parseListenAddress(opts.listen);
  try { host.assertBindable(listen.address, opts.listen); }
  catch { throw new Error(`refusing to install a service that binds ${listen.address}; give --listen the node's own address`); }
  if (!opts['token-file']) throw new Error(NODE_USAGE);
  const tokenFile = canonicalPath(opts['token-file'].replace(/^~(?=\/|$)/, home));
  // The same check the host makes at boot, made now so the failure is a sentence
  // here rather than a service that starts and quietly refuses every connection.
  host.readNodeToken(tokenFile);
  const sock = canonicalPath((opts.sock || path.join(home, 'keep', '.keep', 'host.sock')).replace(/^~(?=\/|$)/, home));
  if (Buffer.byteLength(sock) > 103) throw new Error(`socket path too long (${Buffer.byteLength(sock)} bytes, max 103): ${sock}`);
  // The daemon's node API, for this node's CLI to send registry commands to. Checked
  // with the rule the CLI applies, so a service is never written with one it refuses.
  if (opts['daemon-url'] !== undefined) require('./remote-cli.js').daemonBase(opts['daemon-url']);
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const env = {
    // Written out rather than inherited. The daemon holds the whole fleet to one home
    // directory and compares a node's answer against its own, and that answer is this
    // process's `os.homedir()` — which reads HOME first. A service manager that starts
    // the host without one, or with another user's, makes the node refuse every launch
    // for a mismatch it never had.
    HOME: home,
    PATH: process.env.PATH || '',
    KEEP_NODE: process.execPath,
    KEEP_HOST_SOCK: sock,
    KEEP_NODE_NAME: name,
    KEEP_DAEMON_NODE: daemonNode,
    KEEP_HOST_LISTEN: opts.listen,
    KEEP_NODE_TOKEN_FILE: tokenFile,
    ...(opts['daemon-url'] !== undefined ? { KEEP_DAEMON_URL: opts['daemon-url'] } : {}),
    LANG: process.env.LANG || 'en_US.UTF-8',
  };
  const log = path.join(path.dirname(sock), 'host.log');
  if (process.platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', 'games.castle.keep.host.plist');
    if (fs.existsSync(file)) throw new Error(`existing service needs a manual migration: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, servicePlist('host', root, env.PATH, { env, log }), { flag: 'wx' });
    console.log(`Wrote ${file}. Start the host with:`);
    console.log('');
    console.log(`  launchctl bootstrap gui/${process.getuid()} ${file}`);
  } else if (process.platform === 'linux') {
    const file = path.join(home, '.config', 'systemd', 'user', 'keep-host.service');
    if (fs.existsSync(file)) throw new Error(`existing service needs a manual migration: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, hostUnit(env), { flag: 'wx' });
    console.log(`Wrote ${file}. Start the host with:`);
    console.log('');
    console.log('  systemctl --user enable --now keep-host');
  } else {
    throw new Error(`keep node init supports macOS and Linux; run keep host on ${process.platform} yourself with KEEP_HOST_LISTEN and KEEP_NODE_TOKEN_FILE set`);
  }
  console.log('');
  console.log(`Node ${name} listens on ${opts.listen} for the daemon on ${daemonNode}; its local socket is ${sock}.`);
  if (opts['daemon-url'] !== undefined) console.log(`Its registry commands go to the daemon's node API at ${opts['daemon-url']}.`);
}

function service(args, root) {
  const [action] = args;
  if (args.length !== 1 || !['install', 'start', 'stop', 'restart', 'status'].includes(action)) throw new Error('usage: keep service install|start|stop|restart|status');
  if (process.platform !== 'darwin') throw new Error('service management currently supports macOS; run keep host and keep serve in separate terminals');
  const target = `gui/${process.getuid()}`;
  const entries = ['host', 'serve'].map((kind) => ({ kind, label: `games.castle.keep.${kind}`, file: path.join(os.homedir(), 'Library', 'LaunchAgents', `games.castle.keep.${kind}.plist`) }));
  const run = (argv) => execFileSync('launchctl', argv, { stdio: 'inherit' });
  if (action === 'install') {
    for (const entry of entries) if (fs.existsSync(entry.file)) throw new Error(`existing service needs a manual migration: ${entry.file}`);
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    for (const entry of entries) { fs.mkdirSync(path.dirname(entry.file), { recursive: true }); fs.writeFileSync(entry.file, servicePlist(entry.kind, root), { flag: 'wx' }); }
    console.log('Service files installed. Run keep service start to start the host and daemon.');
  } else if (action === 'restart') {
    // Preserve host-owned interactive terminals when refreshing daemon code.
    execFileSync(process.execPath, [path.join(__dirname, 'keep.js'), 'restart-daemon'], { stdio: 'inherit' });
  } else {
    for (const entry of action === 'stop' ? [...entries].reverse() : entries) {
      if (action === 'start') run(['bootstrap', target, entry.file]);
      if (action === 'stop') run(['bootout', `${target}/${entry.label}`]);
      if (action === 'status') run(['print', `${target}/${entry.label}`]);
    }
  }
}

// A profile can be behind on dozens of fields; name enough of them to recognize
// the drift and leave the rest to the fix command.
function counted(list, one = 'value', many = 'values') {
  return `${list.length} ${list.length === 1 ? one : many}: ${list.slice(0, 6).join(', ')}${list.length > 6 ? ', …' : ''}`;
}

// One line per managed nondefault account. The default profile of each agent is
// the source, not a target, so it has nothing to be behind.
function accountSetupReport() {
  const lines = [];
  let accounts;
  try { accounts = require('./accounts'); } catch { return lines; }
  let records = [], defaults = {};
  try {
    records = accounts.list();
    for (const agent of new Set(records.map((account) => account.agent))) defaults[agent] = accounts.defaultFor(agent)?.id;
  } catch { return lines; }
  for (const account of records) {
    if (account.id === defaults[account.agent]) continue;
    const agent = account.agent === 'codex' ? 'Codex' : 'Claude';
    const share = (source) => `keep accounts setup ${account.id} --share-from ${source || defaults[account.agent] || '<source-id>'}`;
    try {
      if (account.agent === 'codex') {
        const state = require('./codex-setup').previewRefresh(account);
        // A deferred leaf is a transaction in flight, not drift: it explains the
        // line, it never fails it.
        const held = state.deferred?.length ? ` (model keys deferred: ${state.deferred[0].reason})` : '';
        if (!state.managed) lines.push({ status: 'optional', text: `${agent} account ${account.id} is not sharing setup`, fix: share() });
        else if (state.conflicts.length) {
          lines.push({ status: 'FAIL', text: `${agent} account ${account.id} shared setup conflicts (${counted(state.conflicts)})${held}`,
            fix: `resolve those values in ${path.join(account.configDir, 'config.toml')}, then ${share(state.sourceAccountId)}` });
        } else {
          const behind = [...state.configChanges, ...state.assetChanges];
          if (behind.length) lines.push({ status: 'FAIL', text: `${agent} account ${account.id} shared setup behind (${counted(behind)})${held}`, fix: share(state.sourceAccountId) });
          else lines.push({ status: 'ok', text: `${agent} account ${account.id} shared setup in sync${held}` });
        }
      } else {
        const state = require('./account-setup').previewRefresh(account);
        if (!state.managed) lines.push({ status: 'optional', text: `${agent} account ${account.id} is not sharing setup`, fix: share() });
        else if (state.entries.length) {
          lines.push({ status: 'FAIL', fix: share(state.sourceAccountId),
            text: `${agent} account ${account.id} shared setup behind (${counted(state.entries, 'entry', 'entries')})` });
        } else if (state.plugins?.length) {
          lines.push({ status: 'FAIL', fix: share(state.sourceAccountId),
            text: `${agent} account ${account.id} is missing plugins (${counted(state.plugins, 'plugin', 'plugins')})` });
        } else lines.push({ status: 'ok', text: `${agent} account ${account.id} shared setup in sync` });
      }
    } catch (error) {
      lines.push({ status: 'FAIL', text: `${agent} account ${account.id} shared setup unreadable (${error.message})`, fix: share() });
    }
  }
  return lines;
}

// Keep's nodes share one home directory, and everything that travels between them
// leans on it: an account's paths are expanded against the daemon's home long before
// they reach the machine that has to open them. A node whose home is somewhere else
// cannot run this install's accounts at all — it refuses the launch — and the place
// to find that out is here, not at the moment somebody opens a card on it.
//
// A single-node install has nothing to ask and says nothing, so its output is
// unchanged.
async function nodeHomeReport(deps = {}) {
  let entries;
  try { entries = (deps.listNodes || require('./node-registry.js').listNodes)(); }
  catch { return []; }
  const remote = entries.filter((entry) => !entry.daemon && !entry.invalid);
  if (!remote.length) return [];
  const connect = deps.connect || require('./hostclient.js').connect;
  const home = deps.homedir || os.homedir();
  return Promise.all(remote.map(async (entry) => {
    let client = null;
    try {
      client = await connect({ node: entry.name, timeoutMs: deps.timeoutMs == null ? 3000 : deps.timeoutMs });
      const hello = client.descriptor || await client.request('hello');
      if (!hello || typeof hello.home !== 'string' || !hello.home) {
        return { status: 'optional', text: `node ${entry.name} did not say what its home directory is` };
      }
      if (hello.home === home) return { status: 'ok', text: `node ${entry.name} shares this home (${home})` };
      return {
        status: 'FAIL',
        text: `node ${entry.name} has home ${hello.home}, not ${home}; Keep nodes must share the home directory`,
        fix: `give ${entry.name} the home ${home}, or remove it with keep nodes rm ${entry.name}`,
      };
    } catch (error) {
      // Unreachable is not the same as wrong: `keep nodes` is where reachability is
      // reported, and a node that is merely off must not fail this install's doctor.
      return { status: 'optional', text: `node ${entry.name} could not be asked: ${error.message}` };
    } finally {
      if (client) { try { client.close(); } catch {} }
    }
  }));
}

// The node API, from whichever side this machine is on. On the daemon node: whether
// the listener is configured and has an address it will bind. On a pane-only node:
// whether KEEP_DAEMON_URL reaches the daemon, by asking its ping route with this
// node's token. A single-node install with no nodeApi setting reports nothing.
async function nodeApiReport(deps = {}) {
  const env = deps.env || process.env;
  const nodes = require('./nodes.js');
  const where = nodes.paneOnlyNode(env);
  if (!where) {
    const listen = (deps.nodeApiListen || require('./node-registry.js').nodeApiListen)(env);
    if (listen.enabled) {
      // Configured is not bound: the running daemon writes what its listener is
      // doing, and a record from a daemon that is gone, or for another address, says
      // nothing about this one.
      const state = deps.readState ? deps.readState()
        : require('./serve/node-api.js').readState(deps.root || require('./keep-core.js').ROOT);
      const alive = (pid) => {
        if (deps.pidAlive) return deps.pidAlive(pid);
        try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
      };
      const current = state && Number.isInteger(state.pid) && state.listen === listen.listen && alive(state.pid);
      if (current && state.state === 'listening') return [{ status: 'ok', text: `node API listening at ${listen.listen}` }];
      if (current && state.state === 'retrying') {
        return [{ status: 'FAIL', text: `node API listener configured at ${listen.listen} but not bound: ${state.error}; the daemon keeps retrying`, fix: 'check that this machine has that address (is Tailscale up?) and that nothing else holds the port' }];
      }
      if (current) {
        return [{ status: 'FAIL', text: `node API listener at ${listen.listen} failed: ${state.error}`, fix: 'fix nodeApi.listen in config.json, then keep restart-daemon' }];
      }
      return [{ status: 'optional', text: `node API listener configured at ${listen.listen}; the running daemon has not reported binding it`, fix: 'keep restart-daemon, then run keep doctor again' }];
    }
    if (listen.error) {
      return [{ status: 'FAIL', text: `node API listener: ${listen.error}`, fix: 'set nodeApi.listen in config.json to this machine\'s own <ip>:<port> (its Tailscale address)' }];
    }
    if (listen.reason === 'not configured') {
      let others = [];
      try { others = (deps.listNodes || require('./node-registry.js').listNodes)(env).filter((entry) => !entry.daemon); } catch {}
      if (!others.length) return [];
      return [{ status: 'optional', text: 'node API listener absent: nodes cannot run registry commands or land', fix: 'set nodeApi.listen in config.json to this machine\'s own <ip>:<port>, then keep restart-daemon' }];
    }
    return [{ status: 'optional', text: `node API listener not started: ${listen.reason}` }];
  }
  if (!env.KEEP_DAEMON_URL) {
    return [{ status: 'optional', text: `KEEP_DAEMON_URL is not set: registry commands here are refused, not sent to ${where.daemon}`, fix: 'reinstall the host with keep node init ... --daemon-url http://<daemon node api>' }];
  }
  const remote = require('./remote-cli.js');
  try {
    const token = remote.nodeToken(env, deps.readToken);
    const response = await (deps.request || remote.nodeApiRequest)(env.KEEP_DAEMON_URL, '/api/registry/ping', { method: 'GET', token, timeoutMs: deps.timeoutMs || 5000 });
    const value = remote.parsed(response) || {};
    if (response.status !== 200) return [{ status: 'FAIL', text: `the daemon at ${env.KEEP_DAEMON_URL} refused this node: ${value.error || `HTTP ${response.status}`}` }];
    if (value.node !== where.local || value.daemon !== where.daemon) {
      return [{ status: 'FAIL', text: `the daemon at ${env.KEEP_DAEMON_URL} answered as ${value.daemon} for node ${value.node}, not ${where.daemon} for ${where.local}` }];
    }
    return [{ status: 'ok', text: `daemon ${where.daemon} answers at ${env.KEEP_DAEMON_URL} (its clock: ${value.now})` }];
  } catch (error) {
    return [{ status: 'FAIL', text: `KEEP_DAEMON_URL ${env.KEEP_DAEMON_URL} does not reach the daemon: ${error.message}` }];
  }
}

// Hook delivery, from whichever side this machine is on. On a node with a daemon
// URL: how many hook events wait in its queue, and the newest transcript cursor. On
// the daemon node with a node API: how much each node's transcript mirrors hold.
function hookDeliveryReport(deps = {}) {
  const env = deps.env || process.env;
  const where = require('./nodes.js').paneOnlyNode(env);
  if (where) {
    if (!env.KEEP_DAEMON_URL) return [];
    const { queued, newest } = require('./hook-client.js').report(env);
    const cursor = newest
      ? `newest transcript cursor: session ${newest.session} at ${Number(newest.sent) || 0} bytes, ${new Date(newest.mtimeMs).toISOString()}`
      : 'no transcript cursors yet';
    if (!queued) return [{ status: 'ok', text: `hook queue empty; ${cursor}` }];
    return [{ status: 'optional', text: `hook queue: ${queued} event(s) waiting for ${where.daemon}; ${cursor}`,
      fix: 'the next hook resends them once the daemon answers; keep doctor above says whether it does' }];
  }
  const listen = (deps.nodeApiListen || require('./node-registry.js').nodeApiListen)(env);
  if (!listen.enabled) return [];
  const usage = require('./transcript-mirror.js').usage(deps.root || require('./keep-core.js').ROOT);
  const names = Object.keys(usage).sort();
  if (!names.length) return [{ status: 'ok', text: 'transcript mirrors: none yet' }];
  const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return [{ status: 'ok', text: `transcript mirrors: ${names.map((name) => `${name} ${mib(usage[name].bytes)} in ${usage[name].mirrors} mirror(s)`).join(', ')}` }];
}

// Codex on a node: every Codex profile under this home (~/.codex, ~/.codex-*) wires its
// hooks to this node's checkout with hooks switched on, or its sessions run with no
// guard and are never registered. And whether lsof is here: without it a Linux node
// reads its Codex sessions' open rollouts from /proc, so its absence is reported,
// not failed. Only on a pane-only node; the daemon node's own profiles are its own.
const CODEX_HOOK_ACTIONS = ['start', 'stop', 'end', 'pre-tool', 'post-tool', 'question', 'approval', 'lifecycle'];

function codexHooksReport(deps = {}) {
  const env = deps.env || process.env;
  const where = require('./nodes.js').paneOnlyNode(env);
  if (!where) return [];
  const home = env.HOME || os.homedir();
  const keepBin = deps.keepBin || path.join(path.resolve(__dirname, '..'), 'bin', 'keep');
  const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const tilde = (file) => (file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);
  let profiles = [];
  try {
    profiles = fs.readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\.codex(?:-[A-Za-z0-9_.-]+)?$/.test(entry.name))
      .map((entry) => path.join(home, entry.name)).sort();
  } catch {}
  const rows = [];
  for (const dir of profiles) {
    const name = tilde(dir);
    let hooks = null;
    try { hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')); } catch (error) {
      rows.push({ status: 'FAIL', text: `Codex hooks (${name}): ${error.code === 'ENOENT' ? 'no hooks.json' : `hooks.json unreadable: ${error.message}`}; its sessions on ${where.local} run unguarded and unregistered`,
        fix: `wire keep hook codex <action> to ${keepBin} in ~/.codex/hooks.json; a managed profile shares it on its next Keep launch` });
      continue;
    }
    const commands = [];
    for (const groups of Object.values((hooks && hooks.hooks) || {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group && group.hooks) ? group.hooks : []) {
          if (hook && typeof hook.command === 'string') commands.push(hook.command);
        }
      }
    }
    const wired = new Set();
    const elsewhere = new Set();
    for (const command of commands) {
      const match = /^\s*(\S+)\s+hook\s+codex\s+([a-z-]+)/.exec(command);
      if (!match) continue;
      if (real(match[1]) !== real(keepBin)) elsewhere.add(match[1]);
      else wired.add(match[2]);
    }
    const missing = CODEX_HOOK_ACTIONS.filter((action) => !wired.has(action));
    let enabled = false;
    try {
      const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
      let section = '';
      for (const line of toml.split(/\r?\n/)) {
        const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
        if (header) { section = header[1].trim(); continue; }
        if (section === 'features' && /^\s*hooks\s*=\s*true\s*(?:#.*)?$/.test(line)) enabled = true;
      }
    } catch {}
    const problems = [];
    if (elsewhere.size) problems.push(`commands point at ${[...elsewhere].join(', ')}, not this node's ${keepBin}`);
    if (missing.length) problems.push(`not wired: ${missing.join(', ')}`);
    if (!enabled) problems.push('[features] hooks = true is not set in config.toml');
    rows.push(problems.length
      ? { status: 'FAIL', text: `Codex hooks (${name}): ${problems.join('; ')}`, fix: `wire keep hook codex <action> to ${keepBin} in ${name}/hooks.json and set [features] hooks = true in ${name}/config.toml` }
      : { status: 'ok', text: `Codex hooks (${name}) reach ${keepBin}` });
  }
  const lsof = (deps.hasLsof || require('./process-table.js').hasLsof)();
  const linux = (deps.platform || process.platform) === 'linux';
  rows.push({ status: lsof || linux ? 'ok' : 'optional',
    text: lsof ? 'lsof present: Codex sessions\' open rollouts are read with it'
      : linux ? 'lsof absent: Codex sessions\' open rollouts are read from /proc'
      : 'lsof absent: Codex sessions here cannot be matched to their panes' });
  return rows;
}

// Pi on a node: whether the Keep Pi extension is where Pi on this machine looks for it.
// Without it a Pi session opened here never registers, and the daemon refuses to open
// one (keep open --agent pi --node <this node>). Optional: a node need not run Pi.
// Only on a pane-only node; the daemon node's open checks its own.
function piExtensionReport(deps = {}) {
  const env = deps.env || process.env;
  const where = require('./nodes.js').paneOnlyNode(env);
  if (!where) return [];
  const home = env.HOME || os.homedir();
  const link = path.join(home, '.pi', 'agent', 'extensions', 'keep.ts');
  const source = deps.piExtensionSource || path.join(path.resolve(__dirname, '..'), 'integrations', 'pi', 'keep.ts');
  const fix = `mkdir -p ~/.pi/agent/extensions && ln -s ${source} ~/.pi/agent/extensions/keep.ts`;
  let linked = false;
  try { fs.lstatSync(link); linked = true; } catch {}
  let file = false;
  try { file = fs.statSync(link).isFile(); } catch {}
  if (!linked) {
    return [{ status: 'optional', text: `Pi Keep extension not installed at ~/.pi/agent/extensions/keep.ts: Pi sessions cannot be opened on ${where.local}`, fix }];
  }
  if (!file) {
    return [{ status: 'optional', text: 'Pi Keep extension at ~/.pi/agent/extensions/keep.ts is a link to nothing', fix: `rm ~/.pi/agent/extensions/keep.ts && ${fix}` }];
  }
  let real = link;
  try { real = fs.realpathSync(link); } catch {}
  let expected = source;
  try { expected = fs.realpathSync(source); } catch {}
  return [{ status: 'ok', text: real === expected ? `Pi Keep extension linked to ${source}`
    : `Pi Keep extension installed at ~/.pi/agent/extensions/keep.ts (${real})` }];
}

async function doctor(root) {
  let failed = false;
  const check = (name, fn, required = true) => {
    let ok = false; try { ok = Boolean(fn()); } catch {}
    console.log(`${ok ? 'ok' : required ? 'FAIL' : 'optional'}: ${name}`);
    if (!ok && required) failed = true;
    return ok;
  };
  check('Node 22+', () => Number(process.versions.node.split('.')[0]) >= 22);
  check('Git registry outside application source', () => !insideSource(root) && git(root, ['rev-parse', '--show-toplevel']) === fs.realpathSync(root));
  check('registry directories', () => ['tasks', 'archive', 'digests'].every((dir) => fs.statSync(path.join(root, dir)).isDirectory()));
  check('Git commit identity', () => git(root, ['config', 'user.name']) && git(root, ['config', 'user.email']));
  check('Claude CLI (reviewer and scheduled checks)', () => spawnSync('claude', ['--version'], { timeout: 10000 }).status === 0);
  check('Codex CLI', () => spawnSync('codex', ['--version'], { timeout: 10000 }).status === 0, false);
  check('terminal dependencies', () => { require('node-pty'); require('ws'); return true; });
  // Per account: the restart guard, the raw-resume guard and the unattended question
  // refusal all live in the hooks, so an account without them runs unguarded.
  const unguarded = [];
  for (const target of hookTargets()) {
    check(`Claude Keep hooks (${target.id})`, () => {
      const missing = missingHooks(target.file);
      if (missing.length) unguarded.push(`${target.id} is missing ${missing.join(', ')}`);
      return missing.length === 0;
    });
  }
  for (const line of unguarded) console.log(`  ${line}`);
  if (unguarded.length) console.log('  fix: keep setup hooks');
  // One check per skill pack: core and whatever packs this machine recorded are
  // required, the rest are available but not chosen.
  let packs = {};
  try { packs = loadPacks(); } catch (error) { check('skill packs', () => { throw error; }); }
  const recorded = new Set([CORE_PACK, ...configuredPacks(packs)]);
  for (const [name, pack] of Object.entries(packs)) {
    const required = recorded.has(name);
    // Every destination, not only `~/.claude`: Codex reads `~/.agents/skills`, and a
    // pack linked in one home and missing from the other is not installed.
    const ok = check(`skill pack ${name}`, () => skillPlans([name], { probe: true, packs })
      .every((plan) => plan.action === 'ok'), required);
    if (!ok) console.log(`  fix: keep setup skills${required ? '' : ` --pack ${name}`}`);
  }
  // Shared account setup drifts silently: a secondary profile that stopped
  // tracking its source keeps launching, just without the capabilities and
  // preferences it was set up to inherit. Read-only; doctor never repairs.
  for (const entry of accountSetupReport()) {
    console.log(`${entry.status}: ${entry.text}`);
    if (entry.fix) console.log(`  fix: ${entry.fix}`);
    if (entry.status === 'FAIL') failed = true;
  }
  for (const entry of [...await nodeHomeReport(), ...await nodeApiReport({ root }), ...hookDeliveryReport({ root }), ...codexHooksReport(), ...piExtensionReport()]) {
    console.log(`${entry.status}: ${entry.text}`);
    if (entry.fix) console.log(`  fix: ${entry.fix}`);
    if (entry.status === 'FAIL') failed = true;
  }
  // Optional features are switches, not health: report what this machine has
  // chosen rather than passing or failing it.
  console.log(`features: ${features.list().map((feature) => `${feature.name} ${feature.enabled ? 'on' : 'off'}`).join(', ')}`);
  console.log('Model access and external integrations require their own live checks; doctor does not call models or send notifications.');
  if (failed) process.exitCode = 1;
}

module.exports = {
  init, installHooks, installSkills, service, node, doctor, nodeHomeReport, nodeApiReport, hookDeliveryReport, codexHooksReport, piExtensionReport, accountSetupReport, mergeHooks, servicePlist, hostUnit, systemdQuote, quote, canonicalPath, insideSource,
  HOOK_ACTIONS, missingHooks, hookTargets, hookTarget,
  loadPacks, configuredPacks, installPackNames, skillPlans, applySkillPlans, reportSkillPlans, listPacks,
  recordPacks, recordPreflight,
  shell, shellBlock, applyShellBlock, SHELL_START, SHELL_END,
};
