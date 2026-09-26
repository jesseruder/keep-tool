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
  // `note` posts a state note the daemon then types into every live session in the
  // project (/api/notes/announce). The daemon's CLI runs it under the caller's
  // verified session (IDENTITY_VARS in registry-route.js), so the note's author is
  // that session, which its announce leaves out; and the announce is the daemon's
  // own, so it reaches the project's siblings on every node the way a tell does
  // (sendToSession), a sibling it cannot reach reported as unreached. Its text is
  // trusted node input, like a tell's.
  'note',
  // Read-only: what a node's `keep land` needs from the registry to decide a land.
  'land-facts',
  // `tell` reaches one named session, not every one: the daemon's CLI runs it under
  // the caller's verified session (IDENTITY_VARS in registry-route.js), so the
  // daemon frames the text as a message from that sender, on that sender's card,
  // and the per-sender ledger in .keep/tell.json caps it like any other tell.
  'tell',
  // `open` starts or resumes a session for a card. The daemon's CLI runs it under the
  // caller's verified session, so the caller is the requester the card is handed over
  // from; the daemon resolves the card and picks the node, account and model itself,
  // exactly as for an open typed on the daemon node. Its -m opening message is typed
  // into the new session: trusted node input, by the same trust that lets a node land
  // and name its own work (see the card titles and plan text below). What it cannot
  // carry is a file on the node (NODE_FILE_FLAGS).
  'open',
  // Read-only over the daemon's turn index, which holds every node's mirrored
  // transcripts: an agent on a node finds an earlier conversation the same way one
  // on the laptop does. Only the reading subcommands (TURNS_READS); ingest,
  // backfill and prune name files on the node or rewrite the index.
  'turns',
  // Cards and conversations in one read (bin/commands/turns.js search): a node's
  // agent already reads any card with `show`; --all is refused as for turns.
  'search',
  // Only `nodes update` (NODES_READS below is its whole list): after a node's land
  // restarts the daemon, the node asks it to bring every node, itself included, up
  // to origin (bin/node-update.js). It can only fast-forward to what origin has.
  'nodes',
  // `compact` asks the daemon to compact a session. A bare one is an agent asking for
  // its own session at the next idle moment: the daemon's CLI runs it under the
  // caller's verified session (IDENTITY_VARS in registry-route.js), which is the
  // session its request names, and the daemon compacts a Claude session on a node on
  // its current model. With an id it compacts that session now, as on the daemon node.
  'compact',
  // `verify <card>` delivers the card's check recipe into a session now (/api/run), as
  // a scheduled check would; nothing in the request is run as a command.
  'verify',
  // An agent's own feed (AGENTS_ALLOWED): a card agent or responder on a node says
  // what it found with `emit`, and reads its feed with `events` or the bare list.
  // The daemon's CLI runs an emit under the caller's verified session and writes it
  // only when that session is the one the agent's record names. `place` moves an
  // agent to a node, said on its feed with the session that did it. `seen` is
  // Owner's badge and stays on the daemon node.
  'agents',
  // The fleet reviewer's procedure (skills/fleet-review), for a reviewer on a node:
  // its bundles and stats are reads over the daemon's registry and mirrors, and its
  // findings, acks, outcomes, ideas and batched landing are the writes it exists to
  // make. `alert` names its caller from the session the daemon verified, so only a
  // registered reviewer's alert reads as the reviewer's. `review-land` carries its
  // document as the request's stdin (REVIEW_LAND_STDIN_MAX), never a node file.
  'review-bundle', 'review-stats', 'review-replay',
  'review-note', 'review-ack', 'review-dismiss', 'review-outcome', 'review-idea', 'review-land',
  'alert',
]);
// A forwarded `review-land -` document: one reviewer tick's batch.
const REVIEW_LAND_STDIN_MAX = 1024 * 1024;

const NODES_ALLOWED = Object.freeze(['update']);
const NODES_REFUSAL = 'a node runs only keep nodes update; the rest runs on the daemon node';

const AGENTS_ALLOWED = Object.freeze(['emit', 'events', 'place']);
const AGENTS_REFUSAL = `a node runs only keep agents ${AGENTS_ALLOWED.join('|')} (or the bare list); the rest runs on the daemon node`;
const AGENTS_EMIT_REFUSAL = "a node's emit names the session it is from; run it inside the agent's session";
function agentsRefusal(args, identity = null) {
  const sub = args[0];
  if (sub !== undefined && !String(sub).startsWith('-') && !AGENTS_ALLOWED.includes(sub)) return AGENTS_REFUSAL;
  if (identity && sub === 'emit' && !identity.session) return AGENTS_EMIT_REFUSAL;
  return null;
}

const TURNS_READS = Object.freeze(['search', 'show', 'stats']);
const TURNS_REFUSAL = `a node runs only keep turns ${TURNS_READS.join('|')}; the rest runs on the daemon node`;
// Tool output can hold whatever a command printed, a secret included, from every
// machine in the fleet; a node searches what people typed and the agents' prose.
const TURNS_ALL_REFUSAL = 'a node searches without --all: tool output stays on the daemon node';
function turnsRefusal(args, command = 'turns') {
  if (command === 'turns' && !TURNS_READS.includes(args[0])) return TURNS_REFUSAL;
  // Anywhere, even past `--`: parseArgs reads a `--` after a value-taking flag as
  // that flag's value, and a search word spelled --all is not worth telling apart.
  if (args.some((arg) => arg === '--all' || arg.startsWith('--all='))) return TURNS_ALL_REFUSAL;
  return null;
}

// A flag whose value is a command the daemon runs: `--probe` on its check schedule,
// `--done-when` when a plan step is verified, and `plan --verify`, which runs one.
// (resources --command/--deploy are patterns matched against commands, never run.)
const COMMAND_FLAGS = Object.freeze(['--probe', '--done-when', '--verify']);

// What a node may write, and why: a node with a token is one of Owner's own machines,
// so text it writes that the daemon later hands a session is trusted node input, by
// the same trust that lets a node push to master and land. That covers the check
// recipe (add/checkin --check, re-armed by --on-pass), card titles (add, retitle) and
// plan step text, which the daemon quotes into the check and unblock prompts it
// delivers, just as a forwarded tell and an open's -m are typed into sessions. What
// it may not write is a command the daemon runs itself (COMMAND_FLAGS above): that
// is execution on the laptop, not text a session reads and weighs. A forwarded `note`,
// which the daemon types into every live session in the project, is the same trusted
// text, written under the caller's verified session.

// A flag whose value is a path on the node, per command: the daemon's CLI would read
// that path from the daemon's own disk, which holds some other file or none.
const NODE_FILE_FLAGS = Object.freeze({
  tell: ['--message-file'],
  open: ['--message-file'],
  checkin: ['--attach'],
  // Its document goes up as stdin: the node's CLI reads the file and sends `-`.
  'review-land': ['--file'],
});

// The one forwarded command that carries a body: `review-land -` with its document.
function stdinRefusal(command, args, stdin) {
  if (stdin === undefined || stdin === null) {
    return command === 'review-land' ? 'review-land from a node sends its document as the request body' : null;
  }
  if (command !== 'review-land' || args.length !== 1 || args[0] !== '-') return 'only review-land - carries a request body';
  if (typeof stdin !== 'string') return 'the request body must be a string';
  if (Buffer.byteLength(stdin) > REVIEW_LAND_STDIN_MAX) return `the review-land document is longer than ${REVIEW_LAND_STDIN_MAX} bytes`;
  if (stdin.includes('\0')) return 'the request body contains a NUL byte';
  return null;
}

// A flag that, in that command, names where something happens rather than who is
// asking. `--session` and `--node` elsewhere name the caller (a card linked to a
// session, a decision taken for one), so they must name the caller's own; `open
// --node` is where the new session runs, and a session on one node opening work on
// the daemon node or on a third is the point of forwarding it. `open` takes no
// `--session`, so that rule still applies to it.
const PLACEMENT_FLAGS = Object.freeze({
  open: ['--node'],
  // Where the agent's sessions will run, not where the caller is.
  agents: ['--node'],
  // Not where or who but which: the session whose transcript a bundle reads.
  'review-bundle': ['--session'],
  'review-replay': ['--session'],
});

// The commands the daemon runs on behalf of a session and so frames as that session's
// act; without one the daemon's CLI would attribute a node's request to Owner's own
// shell. A tell is framed as a message from its sender, and an open names its opener
// as the requester a card is handed over from. A note names the session that wrote
// it, which its announce leaves out and a clear by another session is warned about.
const SESSION_REFUSALS = Object.freeze({
  tell: "a node's tell names the session it is from; run it inside an agent session",
  open: "a node's open names the session it is from; run it inside an agent session",
  note: "a node's note names the session it is from; run it inside an agent session",
  // A reviewer's writes are its own only from its registered session, which the
  // daemon's review commands then check (commands/review.js requireReviewerFromNode).
  ...Object.fromEntries(['review-note', 'review-ack', 'review-dismiss', 'review-idea', 'review-land']
    .map((command) => [command, `a node's ${command} is the reviewer's; run it inside the reviewer's session`])),
  // An outcome is the working session's (or Owner's), never the reviewer's.
  'review-outcome': "a node's review-outcome names the session recording it; run it inside that session",
  // A bare compact names no session but the caller's, and from a node shell with none
  // the daemon's CLI would take its own environment's instead.
  compact: "a node's compact names the session it is from; run it inside an agent session",
});

// `keep compact <id>` without --when-idle compacts now, and the daemon's CLI waits for
// it: up to KEEP_COMPACT_TIMEOUT_MS (four minutes by default), past the minute a
// forwarded command is given, so the node would be told of a timeout while the daemon
// carried on. A node asks for the idle-time form, which files a request and returns.
const COMPACT_NOW_REFUSAL = "a node's keep compact <id> would compact now and outlast a forwarded command; add --when-idle, or run it on the daemon node";
function compactRefusal(args) {
  let named = false;
  let idle = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--') { named ||= i + 1 < args.length; break; }
    if (arg === '-m') { i += 1; continue; }
    if (arg === '--when-idle') idle = true;
    else if (!arg.startsWith('--')) named = true;
  }
  return named && !idle ? COMPACT_NOW_REFUSAL : null;
}

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
  decisions: ['json', 'all', 'verbose'],
  resources: ['json'],
  notes: ['all', 'json'],
  health: ['json'],
  stalled: ['json'],
  standup: ['dry', 'show'],
  landed: ['disagree', 'dry'],
  resume: ['raw'],
  tell: ['dry', 'json'],
  open: ['fresh'],
  turns: ['json', 'all'],
  search: ['json', 'all', 'cards', 'conversations'],
  nodes: ['json', 'no-reload'],
  agents: ['json', 'unseen', 'needs-you', 'badge', 'daemon'],
  'review-bundle': ['queue', 'raw', 'force'],
  'review-stats': ['json'],
  'review-note': ['force', 'no-digest'],
  'review-ack': ['probe-safe'],
  'review-outcome': ['json'],
  alert: ['dry', 'force'],
  compact: ['when-idle'],
});

// The arguments each registry command resolves as a project (keep-core
// resolveProjectArg, or list's own matcher), by flag and by position in o._. The
// daemon runs a node's command in the node's project directory, not the directory
// the node was in, so a relative path there names something else: from a node a
// project must be absolute, `~`-prefixed, or a bare name.
const PROJECT_FLAGS = Object.freeze({
  add: ['--project'],
  list: ['--project'],
  turns: ['--project'],
  search: ['--project'],
  'review-idea': ['--project'],
});
const PROJECT_POSITIONS = Object.freeze({
  project: [1],
  who: [0],
  hold: [0],
  note: [0],
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
// somewhere else. A flag PLACEMENT_FLAGS names for the command is where, not who,
// and is judged only as an ordinary value.
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
  if ((command === 'turns' || command === 'search') && turnsRefusal(args, command)) return turnsRefusal(args, command);
  if (command === 'nodes' && !NODES_ALLOWED.includes(args[0])) return NODES_REFUSAL;
  if (command === 'agents' && agentsRefusal(args, identity)) return agentsRefusal(args, identity);
  if (command === 'compact' && compactRefusal(args)) return compactRefusal(args);
  if (Object.prototype.hasOwnProperty.call(SESSION_REFUSALS, command) && !identity.session) return SESSION_REFUSALS[command];
  if (requestedWaitMs(command, args) > MAX_FORWARDED_WAIT_MS) return WAIT_CAP_REFUSAL;
  const newline = (arg) => /[\r\n]/.test(arg);
  const NEWLINE = 'only the -m message may contain a newline';
  let positional = false;
  let message = -1;
  let value = -1;
  let valueFlag = null;
  let position = 0;
  const projectFlags = Object.prototype.hasOwnProperty.call(PROJECT_FLAGS, command) ? PROJECT_FLAGS[command] : [];
  const projectPositions = Object.prototype.hasOwnProperty.call(PROJECT_POSITIONS, command) ? PROJECT_POSITIONS[command] : [];
  const fileFlags = Object.prototype.hasOwnProperty.call(NODE_FILE_FLAGS, command) ? NODE_FILE_FLAGS[command] : [];
  const placementFlags = Object.prototype.hasOwnProperty.call(PLACEMENT_FLAGS, command) ? PLACEMENT_FLAGS[command] : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (i === message) continue;
    // Judged wherever it stands short of `--`, even where the CLI would read it as
    // another flag's value: a walk that disagreed with parseArgs about which is which
    // must not be able to let one through.
    const eq = arg.indexOf('=');
    const flag = !positional && arg.startsWith('--') && arg !== '--' ? (eq < 0 ? arg : arg.slice(0, eq)) : null;
    if (flag && COMMAND_FLAGS.includes(flag)) return `${flag} carries a command the daemon would run; set it from the daemon node`;
    if (flag && fileFlags.includes(flag)) return `${flag} names a file on this node; use -m, or run it from the daemon node`;
    if ((flag === '--session' || flag === '--node') && !placementFlags.includes(flag)) {
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

// How long a forwarded command may wait on the daemon beyond an ordinary run: a
// `tell --wait <duration>` re-asks a busy session until that duration runs out, and
// an `open` waits for the session it starts (OPEN_EXTRA_MS). Both the daemon's
// subprocess and the node's request must outlast it.
//
// At most a day. A waiting tell does not hold a daemon restart, so its started
// journal entry is all that stops a resend running it twice, and entries are pruned
// after a week (registry-route JOURNAL_TTL_MS); a timer set past about 24.8 days
// also fires at once.
const MAX_FORWARDED_WAIT_MS = 24 * 3600e3;
const WAIT_CAP_REFUSAL = '--wait on a forwarded tell is at most 24h';

// What an `open` may spend past the ordinary bound. Its /api/open call has no client
// timeout, and killing the CLI at this bound only drops that loopback request: the
// daemon's own openSession carries on, spawning, typing and linking. So the bound
// must cover the longest open there is, or the node is told a 504 for an open still
// in progress and a person re-running it launches twice. The longest is a reopen of
// an existing session, whose steps in bin/serve.js openSession are, at most:
//   45 s   AGENT_PROMPT_TIMEOUT_MS, the wait for the agent's empty prompt (a dialog
//          seen at its end adds one confirming read, DIALOG_CONFIRM_GRACE_MS 600 ms)
//   15 s   waitForHostSessionId, for the session to name itself
//   270 s  the injection lock retry for a reopen compaction:
//          KEEP_COMPACT_TIMEOUT_MS (default 240 s) + 30 s
//   240 s  the compaction itself, KEEP_COMPACT_TIMEOUT_MS, with the opening message
//          typed under the same lock after it
//   15 s   waitForHostSessionId again, on a card handoff that has not learned it
// That is 585 s before the pane spawn, a node's pane round trips and the typing
// itself; twelve minutes covers it with margin (OPEN_MARGIN_MS). It is the floor:
// KEEP_COMPACT_TIMEOUT_MS is a runtime setting, so the daemon computes its own
// bound from the value it runs with (openExtraMs). A node cannot read the daemon's
// setting and uses the floor for its request; see requestTimeoutMs in remote-cli.js
// for what happens when that runs out first.
//
// A forwarded open holds a daemon restart for that whole bound (registry-route
// handle), which is the honest answer: the daemon must not restart under an open it
// is still performing, and `keep restart-daemon` reports the in-flight work rather
// than proceed.
const OPEN_EXTRA_MS = 12 * 60e3;
const OPEN_MARGIN_MS = 135e3;
// The most an open's bound may grow to, whatever the compaction timeout: half of
// registry-route JOURNAL_TTL_MS (seven days), which it must stay under. A resend
// long after the first post needs the run's journal entry to answer it, so a
// compaction timeout large enough to go past this is refused a longer bound rather
// than given one that outlives the journal.
const MAX_OPEN_EXTRA_MS = 3.5 * 24 * 3600e3;
const DEFAULT_COMPACT_TIMEOUT_MS = 240e3;

// The open bound for a daemon whose environment is `env`: the waits above with its
// KEEP_COMPACT_TIMEOUT_MS read the way serve.js envNumber reads it (a finite,
// non-negative number, else the 240 s default), never below OPEN_EXTRA_MS and never
// above MAX_OPEN_EXTRA_MS.
function openExtraMs(env = {}) {
  return Math.min(MAX_OPEN_EXTRA_MS, openRequiredMs(env));
}

// The bound an open would need on a daemon whose environment is `env`, uncapped.
// Past MAX_OPEN_EXTRA_MS the capped timer would kill the CLI while the daemon's
// in-process open carried on unjournalled, so the route refuses such an open before
// it spawns anything (OPEN_UNBOUNDED_REFUSAL) rather than run it under a bound it
// could outlive.
function openRequiredMs(env = {}) {
  const configured = Number(env.KEEP_COMPACT_TIMEOUT_MS);
  const compactMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_COMPACT_TIMEOUT_MS;
  const longest = 45e3 + 15e3 + (compactMs + 30e3) + compactMs + 15e3;
  return Math.max(OPEN_EXTRA_MS, longest + OPEN_MARGIN_MS);
}
// `verify <card>` is bounded the same way (runCheckNow in bin/serve.js): it delivers
// the check into the card's open session, which can compact a cold one first, or opens
// a fresh session and waits for its prompt and its id. Its /api/run call has no client
// timeout either, so the ordinary minute would tell the node of a timeout while the
// daemon carried on, and a rerun would deliver the check twice.
function runsLikeOpen(command) {
  return command === 'open' || command === 'verify';
}
const OPEN_UNBOUNDED_REFUSAL ="this daemon's compaction timeout is set so high that a forwarded open cannot be bounded; run keep open on the daemon node, or lower KEEP_COMPACT_TIMEOUT_MS";

// `env` is the daemon's own environment, passed only by the daemon's route: a node's
// environment says nothing about the daemon's compaction timeout, so a node leaves
// it out and gets the floor.
function forwardedWaitMs(command, args, env) {
  if (runsLikeOpen(command)) return env ? openExtraMs(env) : OPEN_EXTRA_MS;
  return Math.min(requestedWaitMs(command, args), MAX_FORWARDED_WAIT_MS);
}

// A tell that re-asks a busy session: all it does for most of its run is post to
// the daemon's /api/tell, so it neither holds a daemon restart nor keeps the node's
// other commands waiting (registry-route handle).
function isWaitingTell(command, args) {
  return command === 'tell' && requestedWaitMs(command, args) > 0;
}

// What a node can refuse before it posts, from the arguments alone: a file named on
// the node, and a wait past the cap. The identity rules need the daemon's location
// record and are left to the route, which applies these two as well.
function nodeSideRefusal(command, args) {
  if (!Array.isArray(args)) return null;
  if ((command === 'turns' || command === 'search') && turnsRefusal(args, command)) return turnsRefusal(args, command);
  if (command === 'nodes' && !NODES_ALLOWED.includes(args[0])) return NODES_REFUSAL;
  if (command === 'agents' && agentsRefusal(args)) return agentsRefusal(args);
  if (command === 'compact' && compactRefusal(args)) return compactRefusal(args);
  const fileFlags = Object.prototype.hasOwnProperty.call(NODE_FILE_FLAGS, command) ? NODE_FILE_FLAGS[command] : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--') break;
    if (arg === '-m') { i += 1; continue; }
    const flag = arg.startsWith('--') ? arg.split('=')[0] : null;
    if (flag && fileFlags.includes(flag)) return `${flag} names a file on this node; use -m, or run it from the daemon node`;
  }
  if (requestedWaitMs(command, args) > MAX_FORWARDED_WAIT_MS) return WAIT_CAP_REFUSAL;
  return null;
}

// The --wait a forwarded command asks for, read the way parseArgs reads it (the
// last --wait wins, a value-taking flag takes the next argument, -m's value and
// everything after `--` are not flags). A value that does not parse is 0: the
// daemon's CLI answers it with its usage error well inside the ordinary bound.
function requestedWaitMs(command, args) {
  if (command !== 'tell' || !Array.isArray(args)) return 0;
  let wait = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '-m') { i += 1; continue; }
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (isBooleanFlag(command, name)) continue;
    i += 1;
    if (name === 'wait') wait = args[i];
  }
  if (wait == null) return 0;
  try { return require('./wait.js').parseDuration(wait); } catch { return 0; }
}

// `keep artifact` from a node (bin/artifact-route.js). It is not in REGISTRY_COMMANDS:
// its arguments are paths on the node, which the daemon's CLI would read from its own
// disk. The node reads the files itself and posts their bytes to /api/artifact, and
// the daemon hands its CLI copies under the same basenames. The bounds live here so
// both sides and the CLI read one number:
//   5 MiB per file      the CLI's own limit (keep.js commands.artifact), which a local
//                       call has always had: the registry is a repository every
//                       machine clones, not a file store.
//   20 MiB per command  four files at the limit; the post carries them base64-encoded
//                       in one JSON body the daemon parses on its event loop, so this
//                       also bounds that parse (ARTIFACT_BODY_MAX_BYTES).
//   32 files            a screenshot series, not a directory.
//
// What a node may keep adding, since every stored byte stays in .keep/artifacts, the
// card log and the registry's history for good: a rolling day per node of 256 MiB and
// 200 files accepted, and 2 GiB and 20,000 files for the whole store, past which a
// person prunes it (the file count bounds the names, log lines and history that tiny
// uploads would grow under the byte cap).
const ARTIFACT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const ARTIFACT_NODE_DAILY_BYTES = 256 * 1024 * 1024;
const ARTIFACT_NODE_DAILY_FILES = 200;
const ARTIFACT_QUOTA_WINDOW_MS = 24 * 3600e3;
const ARTIFACT_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ARTIFACT_STORE_MAX_FILES = 20000;
const ARTIFACT_COMMAND_MAX_BYTES = 20 * 1024 * 1024;
const ARTIFACT_MAX_FILES = 32;
// The body /api/artifact accepts: the files at 4/3 for base64, and room for the note,
// the names, the sources and the identity fields.
const ARTIFACT_BODY_MAX_BYTES = Math.ceil(ARTIFACT_COMMAND_MAX_BYTES * 4 / 3) + 1024 * 1024;
const ARTIFACT_NAME_MAX_BYTES = 255;

// Null when `name` is a plain file name the daemon can give its copy, or why not. The
// daemon writes the copy under this name and the CLI keeps it, so anything that could
// leave the temporary directory or break the card log onto a second line is refused.
// (A leading dash is fine: the daemon passes absolute paths, after `--`.)
function artifactNameRefusal(name) {
  if (typeof name !== 'string' || !name) return 'an artifact file name must be a non-empty string';
  if (Buffer.byteLength(name) > ARTIFACT_NAME_MAX_BYTES) return `artifact file name is longer than ${ARTIFACT_NAME_MAX_BYTES} bytes: ${JSON.stringify(name)}`;
  if (name === '.' || name === '..' || /[/\\\0\r\n]/.test(name)) {
    return `artifact file name must be a plain file name: ${JSON.stringify(name)}`;
  }
  return null;
}

module.exports = { REVIEW_LAND_STDIN_MAX, stdinRefusal, ARTIFACT_STORE_MAX_FILES, ARTIFACT_NODE_DAILY_BYTES, ARTIFACT_NODE_DAILY_FILES, ARTIFACT_QUOTA_WINDOW_MS, ARTIFACT_STORE_MAX_BYTES, ARTIFACT_FILE_MAX_BYTES, ARTIFACT_COMMAND_MAX_BYTES, ARTIFACT_MAX_FILES, ARTIFACT_BODY_MAX_BYTES, ARTIFACT_NAME_MAX_BYTES, artifactNameRefusal, REGISTRY_COMMANDS, COMMAND_FLAGS, NODE_FILE_FLAGS, PLACEMENT_FLAGS, SESSION_REFUSALS, BOOLEAN_FLAGS, MAX_FORWARDED_WAIT_MS, OPEN_EXTRA_MS, MAX_OPEN_EXTRA_MS, OPEN_UNBOUNDED_REFUSAL, openExtraMs, openRequiredMs, forwardedWaitMs, runsLikeOpen, isWaitingTell, nodeSideRefusal, PROJECT_FLAGS, PROJECT_POSITIONS, MAX_ARG_BYTES, MAX_ARGS_BYTES, isRegistryCommand, argumentRefusal };
