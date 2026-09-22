'use strict';
// The registry-class commands a pane-only node forwards to the daemon, in one place
// both sides read: the node's CLI to decide what to forward, the daemon's
// /api/registry route to decide what it will run. A command missing here is one a
// node cannot run at all, which is the safe direction for anything added later.
//
// The daemon runs these with its own `keep` CLI, under the caller's identity. What
// it must never do is run a command a request carries, so the flags whose value is
// a shell command the daemon would execute — now or on a later schedule — are
// refused in every command that takes them.

const REGISTRY_COMMANDS = Object.freeze([
  'add', 'checkin', 'claim', 'done', 'list', 'show', 'resume', 'overdue', 'needs', 'allow',
  'reviewed', 'reviewing', 'reviews', 'review-route', 'plan', 'link', 'tag', 'tags', 'hold',
  'release', 'holds', 'resources', 'who', 'deps', 'wait-on', 'decide', 'decisions', 'notes',
  'retitle', 'project', 'landed', 'health', 'stalled', 'standup',
  // Not `note`: posting one makes the daemon type it into every live session in the
  // project (/api/notes/announce), the laptop's included. It waits for an announce
  // that knows which node wrote the note.
  // Read-only: what a node's `keep land` needs from the registry to decide a land.
  'land-facts',
]);

// A flag whose value is a command the daemon runs: `--probe` on its check schedule,
// `--done-when` when a plan step is verified, and `plan --verify`, which runs one.
const COMMAND_FLAGS = Object.freeze(['--probe', '--done-when', '--verify']);

// A flag whose value the daemon later hands a session as instructions, or that
// makes it act on text that does: a node must not make the laptop open a session
// that follows node-written text. Walked from the parseArgs specs of every command
// in REGISTRY_COMMANDS (add, checkin, plan, wait-on, needs and the rest):
//   --check    add/checkin: the recipe a due check delivers to a session, one the
//              daemon opens when none is live. (resources --check only reads, but
//              the name is refused in every command: failing closed is the point.)
//   --on-pass  add/checkin: re-arms that recipe on a schedule.
// Left allowed, and why: --check-after alone schedules a bare nudge with no recipe;
// --check-every and checkin --handoff act only on a recipe already on the card,
// which a node cannot have written; --next and -m are recorded and shown; decide
// --send is recorded, never sent; resources --command/--deploy are patterns
// matched against commands, never run; wait-on --deployed/--target and needs --env
// name facts, not text.
// Card titles (add, retitle) and plan step text DO reach laptop sessions: the
// daemon quotes them into the check and unblock prompts it delivers. They are
// trusted node input, by the same trust that lets a node push to master and land:
// a node with a token is one of Owner's own machines, and what this list keeps it
// from is writing a recipe or a command, not naming its own work. `note`, whose
// text the daemon types straight into every live session in the project, is left
// out of REGISTRY_COMMANDS until that announce knows which node wrote the note.
const INSTRUCTION_FLAGS = Object.freeze(['--check', '--on-pass']);

const MAX_ARG_BYTES = 4 * 1024;
const MAX_ARGS_BYTES = 64 * 1024;

function isRegistryCommand(command) {
  return typeof command === 'string' && REGISTRY_COMMANDS.includes(command);
}

// The flags each registry command reads as taking no value, copied from its
// parseArgs spec in keep.js ('bool' entries). Per command, because one name is a
// boolean in one command and takes a value in another: `wait-on --remove` and
// `allow --clear` take none, `plan --remove <n>`, `resources --remove <name>`,
// `note --clear <id>` and `review-route --clear <model>` take one. Every other
// `--flag` is read as taking the next argument, so a flag missing here makes the
// walk below stricter, never looser: its value is judged as an ordinary argument,
// and a `-m` right after it is read as that value rather than as a message.
const BOOLEAN_FLAGS = Object.freeze({
  add: ['autonomous', 'file', 'claim', 'force', 'as-owner'],
  checkin: ['clear-check-after', 'force'],
  done: ['force'],
  'wait-on': ['remove', 'whole'],
  list: ['overdue', 'brief', 'all'],
  overdue: ['brief'],
  who: ['json'],
  needs: ['met'],
  allow: ['clear', 'quiet', 'json', 'as-owner'],
  reviewed: ['fallback', 'json'],
  'review-route': ['json'],
  reviewing: ['json'],
  reviews: ['json'],
  'land-facts': ['json', 'dry-run'],
  decisions: ['json', 'all', 'verbose'],
  resources: ['json'],
  notes: ['all', 'json'],
  health: ['json'],
  stalled: ['json'],
  standup: ['dry', 'show'],
  landed: ['disagree', 'dry'],
  resume: ['raw'],
});

// The arguments each registry command resolves as a project (keep-core
// resolveProjectArg, or list's own matcher), by flag and by position in o._. The
// daemon runs a node's command in the node's project directory, not the directory
// the node was in, so a relative path there names something else: from a node a
// project must be absolute, `~`-prefixed, or a bare name.
const PROJECT_FLAGS = Object.freeze({
  add: ['--project'],
  list: ['--project'],
});
const PROJECT_POSITIONS = Object.freeze({
  project: [1],
  who: [0],
  hold: [0],
  resources: [0],
  notes: [0],
});

function projectRefusal(value) {
  const text = String(value);
  if (text.startsWith('/') || text === '~' || text.startsWith('~/')) return null;
  if (text && !text.includes('/') && !text.includes('\\') && text !== '.' && text !== '..' && !text.startsWith('~')) return null;
  return `project "${text}" is relative to a directory the daemon does not share; give it as an absolute path, ~/…, or a bare project name`;
}

function isBooleanFlag(command, name) {
  return Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, command) && BOOLEAN_FLAGS[command].includes(name);
}

// Walks argv the way keep-core.parseArgs does, so a value is judged by what the CLI
// will read it as: after `--` everything is positional, a value-taking flag takes
// the next argument, and `-m` takes the next argument as the message whatever it
// looks like. Only that message may contain a newline. Returns null or the refusal.
//
// `identity` is { session, node }: an argument that names a session or a node must
// name the caller's own, so a node cannot link a card to, or decide for, a session
// somewhere else.
function argumentRefusal(command, args, identity = {}) {
  if (!Array.isArray(args)) return 'args must be an array of strings';
  let total = 0;
  for (const arg of args) {
    if (typeof arg !== 'string') return 'args must be an array of strings';
    const bytes = Buffer.byteLength(arg);
    if (bytes > MAX_ARG_BYTES) return `an argument is longer than ${MAX_ARG_BYTES} bytes`;
    total += bytes;
    if (total > MAX_ARGS_BYTES) return `the arguments are longer than ${MAX_ARGS_BYTES} bytes together`;
    if (arg.includes('\0')) return 'an argument contains a NUL byte';
  }
  const newline = (arg) => /[\r\n]/.test(arg);
  const NEWLINE = 'only the -m message may contain a newline';
  let positional = false;
  let message = -1;
  let value = -1;
  let valueFlag = null;
  let position = 0;
  const projectFlags = Object.prototype.hasOwnProperty.call(PROJECT_FLAGS, command) ? PROJECT_FLAGS[command] : [];
  const projectPositions = Object.prototype.hasOwnProperty.call(PROJECT_POSITIONS, command) ? PROJECT_POSITIONS[command] : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (i === message) continue;
    // Judged wherever it stands short of `--`, even where the CLI would read it as
    // another flag's value: a walk that disagreed with parseArgs about which is which
    // must not be able to let one through.
    const eq = arg.indexOf('=');
    const flag = !positional && arg.startsWith('--') && arg !== '--' ? (eq < 0 ? arg : arg.slice(0, eq)) : null;
    if (flag && COMMAND_FLAGS.includes(flag)) return `${flag} carries a command the daemon would run; set it from the daemon node`;
    if (flag && INSTRUCTION_FLAGS.includes(flag)) return `${flag} carries text the daemon would hand a session as instructions; set it from the daemon node`;
    if (flag === '--session' || flag === '--node') {
      const named = eq < 0 ? args[i + 1] : arg.slice(eq + 1);
      const own = flag === '--session' ? identity.session : identity.node;
      if (!own || named !== own) return `${flag} must name the caller's own ${flag.slice(2)}`;
    }
    if (flag && eq >= 0 && projectFlags.includes(flag)) {
      const refusal = projectRefusal(arg.slice(eq + 1));
      if (refusal) return refusal;
    }
    if (positional || i === value || arg === '--' || !arg.startsWith('-') || arg === '-') {
      if (newline(arg)) return NEWLINE;
      if (i === value) {
        if (projectFlags.includes(valueFlag)) {
          const refusal = projectRefusal(arg);
          if (refusal) return refusal;
        }
      } else if (positional || arg !== '--') {
        if (projectPositions.includes(position)) {
          const refusal = projectRefusal(arg);
          if (refusal) return refusal;
        }
        position += 1;
      }
      if (!positional && i !== value && arg === '--') positional = true;
      continue;
    }
    if (arg === '-m') { message = i + 1; continue; }
    if (newline(arg)) return NEWLINE;
    // A single-dash argument other than -m is positional to parseArgs.
    if (!flag) {
      if (projectPositions.includes(position)) {
        const refusal = projectRefusal(arg);
        if (refusal) return refusal;
      }
      position += 1;
      continue;
    }
    if (flag && eq < 0 && !isBooleanFlag(command, flag.slice(2))) { value = i + 1; valueFlag = flag; }
  }
  return null;
}

module.exports = { REGISTRY_COMMANDS, COMMAND_FLAGS, INSTRUCTION_FLAGS, BOOLEAN_FLAGS, PROJECT_FLAGS, PROJECT_POSITIONS, MAX_ARG_BYTES, MAX_ARGS_BYTES, isRegistryCommand, argumentRefusal };
