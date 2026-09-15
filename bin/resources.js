'use strict';

// Declared shared resources — the *information* layer under state notes.
//
// A project says, once and by hand, which named things several sessions share:
// `staging`, `prod`, `terraform`, `sandbox-hosts`. Each declaration carries the
// commands, files and deploys that touch it, so a turn can be matched against
// the list deterministically and a session that changed how staging behaves can
// be reminded to say so.
//
// Nothing here gates anything. A declaration is not authorization, a match is
// not a refusal, and a project with no declarations produces no observations at
// all — the failure mode is silence, never a block. Names are hold scopes so a
// note and a hold can talk about the same resource.

const fs = require('fs');
const path = require('path');
const os = require('os');

const steps = require('./steps.js');
// Declarations are hand-authored, but the evidence quoted back out of them comes
// from a turn's own commands and files. Both end up in a terminal, a prompt, and
// the reviewer bundle, so both go through the same scrubber a note's message
// does — bidi overrides and zero-width characters included.
const { scrub } = require('./notes.js');

// Read the env per call: a test root is set before the CLI runs, and a module
// constant captured at require time would point at the operator's registry.
function defaultRoot() {
  return process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function resourcesDir(root) {
  return path.join(root || defaultRoot(), 'resources');
}

// The same label a hold scope uses, so `keep hold --scope staging` and
// `keep note --scope staging` name one thing.
const SCOPE_RE = /^[a-z0-9][a-z0-9:-]{0,63}$/;

// bin/watcher-live.js emits this when a tool input was too long for the index to
// keep. It is not a command: matching a half-seen input is how an argument turns
// into a command, so it is ignored everywhere below. Kept as a literal rather
// than a require so this module stays loadable on its own; a unit test asserts
// the two spellings agree.
const UNREADABLE_COMMAND = '\u0000keep-watcher-unreadable-command';

function validName(name) {
  return SCOPE_RE.test(String(name == null ? '' : name));
}

function arrayOf(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

// ---------- the registry ----------

function registeredResources(root) {
  const dir = resourcesDir(root);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const registries = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!registry || !registry.project) continue;
      if (!registry.resources || typeof registry.resources !== 'object' || Array.isArray(registry.resources)) continue;
      registries.push({ file, project: steps.normalizeProject(registry.project), resources: registry.resources });
    } catch {}
  }
  return registries;
}

function loadResources(project, root) {
  const wanted = steps.normalizeProject(project);
  if (!wanted) return null;
  return registeredResources(root).find((registry) => registry.project === wanted) || null;
}

function registryFile(project, root) {
  const existing = loadResources(project, root);
  if (existing) return existing.file;
  const basename = path.basename(steps.expandProject(project)) || 'project';
  return path.join(resourcesDir(root), `${basename}.json`);
}

function saveResources(project, resources, root) {
  const file = registryFile(project, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = { project: steps.normalizeProject(project), resources };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return { file, ...value };
}

// Accepts a whole registry ({project, resources}) or a bare name→declaration map,
// because half the callers have one and half have the other.
function resourceMap(declarations) {
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) return {};
  if (declarations.resources && typeof declarations.resources === 'object'
      && !Array.isArray(declarations.resources)) return declarations.resources;
  return declarations;
}

function declaredNames(declarations) {
  return Object.keys(resourceMap(declarations)).filter(validName).sort();
}

// ---------- matchers ----------

// A regex that does not compile disables *that matcher*, never the whole
// declaration and never by throwing: a typo in one project's registry must not
// stop the watcher judging every other turn. `resource-bad-matcher` reports it.
function compileCommandMatchers(resource) {
  const out = { ok: [], bad: [] };
  for (const pattern of arrayOf(resource && resource.commands)) {
    try { out.ok.push({ pattern, re: new RegExp(pattern, 'i') }); }
    catch (error) { out.bad.push({ pattern, reason: error.message }); }
  }
  return out;
}

// Every declaration problem in one registry, for lint. An empty glob or command
// string is as broken as an uncompilable regex: it matches nothing and the
// author thinks it matches something.
function badMatchers(declarations) {
  const problems = [];
  for (const [name, resource] of Object.entries(resourceMap(declarations))) {
    if (!validName(name)) {
      problems.push({ name, kind: 'name', reason: 'not a lowercase resource label' });
      continue;
    }
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      problems.push({ name, kind: 'shape', reason: 'declaration is not an object' });
      continue;
    }
    for (const bad of compileCommandMatchers(resource).bad) {
      problems.push({ name, kind: 'command', pattern: bad.pattern, reason: bad.reason });
    }
    for (const key of ['commands', 'paths', 'deploys']) {
      const raw = resource[key];
      if (raw === undefined) continue;
      if (!Array.isArray(raw)) { problems.push({ name, kind: key, reason: `${key} is not an array` }); continue; }
      if (raw.some((value) => typeof value !== 'string' || !value.trim())) {
        problems.push({ name, kind: key, reason: `${key} has an empty entry` });
      }
    }
    // A declaration with no matchers at all is allowed: it names a resource
    // notes can scope to that no turn can be detected touching.
  }
  return problems;
}

// What a turn's tool inputs actually ran, in the shape bin/steps.js decides — so
// `bash -lc "terraform apply"` is `terraform apply`, and an argv is normalized by
// the same parser rather than by naive joining. The result is one shell-quoted
// line per command, which is what a declaration's regex is matched against: an
// unanchored pattern can therefore match inside a quoted argument. That is the
// right trade here — the only consequence of a false positive is one advisory
// nudge, and nothing downstream refuses anything.
function normalizeCommands(commands) {
  const out = [];
  for (const command of commands || []) {
    if (command === UNREADABLE_COMMAND) continue; // half-seen: never matched
    if (!command || (Array.isArray(command) && !command.length)) continue;
    let normalized = [];
    try { normalized = steps.releaseOf(command).commands || []; } catch {}
    if (normalized.length) out.push(...normalized.map(String));
    else if (typeof command === 'string') out.push(command);
  }
  return [...new Set(out)];
}

// A turn's files arrive as whatever the tool was handed: an absolute path from an
// edit, a relative one from a shell command. Two candidates only — the path as
// written, and the path relative to the declaring project. Matching every
// trailing sub-path as well would make `terraform/main.tf` match
// `vendor/foo/terraform/main.tf`, which is a different file in a different tree.
function fileCandidates(file, project) {
  const text = String(file == null ? '' : file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!text) return [];
  const candidates = new Set([text]);
  const base = project ? String(steps.expandProject(project)).replace(/\\/g, '/').replace(/\/$/, '') : '';
  if (base && text.startsWith(base + '/')) candidates.add(text.slice(base.length + 1));
  return [...candidates];
}

function matchesPath(pattern, file, project) {
  return fileCandidates(file, project).some((candidate) => steps.pathMatches(pattern, candidate));
}

// `<kind>:<target substring>`, or a bare `<kind>`. deployCommand's target is
// prose ("heroku (app castle-staging)"), so the declared half is a substring of
// it rather than an equality.
function matchesDeploy(pattern, deploy) {
  if (!deploy || !deploy.kind) return false;
  const text = String(pattern || '');
  const colon = text.indexOf(':');
  const kind = (colon === -1 ? text : text.slice(0, colon)).trim().toLowerCase();
  const target = colon === -1 ? '' : text.slice(colon + 1).trim().toLowerCase();
  if (!kind || String(deploy.kind).toLowerCase() !== kind) return false;
  if (!target) return true;
  return String(deploy.target || '').toLowerCase().includes(target);
}

function clean(value, limit = 80) {
  const text = scrub(value);
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

const clipEvidence = clean;

// A hand-authored label, but it is rendered into a terminal and read back by a
// session, so it gets the same treatment.
function titleOf(resource) {
  return clean((resource && resource.title) || '', 120);
}

// The pure matcher. Returns one row per touched resource, with the first piece
// of evidence that touched it, so a message can say *why* without replaying the
// whole turn. No declarations, or none that match, is an empty list — the whole
// feature fails open.
function touchedResources(input, declarations) {
  const map = resourceMap(declarations);
  const project = declarations && declarations.project ? declarations.project : '';
  const commands = normalizeCommands((input && input.commands) || []);
  const files = ((input && input.files) || []).filter((file) => typeof file === 'string' && file);
  const deploys = ((input && input.deploys) || []).filter(Boolean);
  const touched = [];
  for (const [name, resource] of Object.entries(map)) {
    if (!validName(name) || !resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    let evidence = '';
    for (const matcher of compileCommandMatchers(resource).ok) {
      const hit = commands.find((command) => matcher.re.test(command));
      if (hit) { evidence = `command ${clipEvidence(hit)}`; break; }
    }
    if (!evidence) {
      for (const pattern of arrayOf(resource.paths)) {
        const hit = files.find((file) => matchesPath(pattern, file, project));
        if (hit) { evidence = `file ${clipEvidence(hit)}`; break; }
      }
    }
    if (!evidence) {
      for (const pattern of arrayOf(resource.deploys)) {
        const hit = deploys.find((deploy) => matchesDeploy(pattern, deploy));
        if (hit) { evidence = `deploy ${clipEvidence(`${hit.kind}: ${hit.target || ''}`)}`; break; }
      }
    }
    if (evidence) touched.push({ name, evidence, noteFor: noteForOf(resource) });
  }
  return touched.sort((a, b) => a.name.localeCompare(b.name));
}

const NOTE_FOR_RE = /^\+\d+[mhdw]$/i;

function noteForOf(resource) {
  const value = String((resource && resource.noteFor) || '');
  return NOTE_FOR_RE.test(value) ? value : '+2h';
}

// ---------- the observation ----------

// A turn that already said something about shared state needs no reminder. The
// head has to be `keep` at an executable position (bin/steps.js decided that
// above) and the verb one of these; `grep "keep note"` is not a check-in.
// `keep notes` is deliberately absent: reading the notes is not writing one, and
// a session that only looked still owes the fleet a sentence.
const STATE_VERBS = new Set(['note', 'checkin', 'hold']);

function saysSomething(commands) {
  return normalizeCommands(commands).some((command) => {
    const tokens = String(command).trim().split(/\s+/);
    const head = tokens[0] || '';
    if (head !== 'keep' && !head.endsWith('/keep')) return false;
    return STATE_VERBS.has(String(tokens[1] || '').replace(/^["']|["']$/g, ''));
  });
}

function coveredByNote(name, sessionId, notes) {
  return (notes || []).some((note) => note
    && (!sessionId || (note.by && note.by.sessionId === sessionId))
    && Array.isArray(note.scopes) && note.scopes.includes(name));
}

// Rule-based and cheap: no model call, no database read of its own. Returns the
// resources this turn touched and said nothing about, or an empty list — which
// is the answer for almost every turn.
function observe(turn, options = {}) {
  const declarations = options.declarations;
  if (!declarations) return [];
  const commands = options.commands || [];
  if (saysSomething(commands)) return [];
  const touched = touchedResources({
    commands,
    files: options.files || [],
    deploys: options.deploys || [],
  }, declarations);
  if (!touched.length) return [];
  const sessionId = turn && turn.session_id ? turn.session_id : '';
  const notes = options.notes || options.notesBySession || [];
  return touched.filter((row) => !coveredByNote(row.name, sessionId, notes));
}

// `keep resources --check` and the CLI's own reporting.
function describeTouched(touched) {
  return (touched || []).map((row) => `${row.name} — ${row.evidence}`);
}

module.exports = {
  SCOPE_RE, UNREADABLE_COMMAND,
  defaultRoot, resourcesDir, registryFile,
  registeredResources, loadResources, saveResources,
  resourceMap, declaredNames, validName, noteForOf,
  compileCommandMatchers, badMatchers, clean, clipEvidence, titleOf,
  normalizeCommands, fileCandidates, matchesPath, matchesDeploy,
  touchedResources, saysSomething, observe, describeTouched,
};
