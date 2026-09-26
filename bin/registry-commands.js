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
  // Only `review-queue handoff <name>` (reviewQueueRefusal below): a console review
  // queue launch on a node opens with a pointer to its instructions, which the daemon
  // wrote into its own registry (bin/review-queue.js writeHandoff). Read-only, and
  // nothing about the caller matters: the text is what the daemon would have typed.
  'review-queue',
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
  // User-report groups (bin/reports.js): a responder on a node reads the groups it
  // was woken for and records its verdict, reply or merge. Every write is to the
  // daemon's report store; nothing in a request is run or read from the node.
  'reports',
  // Reads over the daemon's registry and its own state, which is the fleet's: model
  // usage (the fleet's attribution is collected on the daemon), the lint findings, the
  // alert log, the morning brief (`--send` sends it as the daemon's alert, as a local
  // run does), and the account list without its credentials (ACCOUNTS_ALLOWED).
  'usage', 'lint', 'alerts', 'brief', 'accounts',
  // Owner's quiet hours are the daemon's: a node's `keep quiet 2h` silences the same
  // alerts a local one does, and `off` ends them.
  'quiet',
  // The daemon's incident, Discord and Slack state, in their reading forms, and an
  // incident closed by hand (INCIDENTS_ALLOWED and formRefusal below): a responder on
  // a node records the close its recipe recommends.
  'incidents', 'discord', 'slack',
  // `keep ideas --dry` prints the evidence and prompt; a real run is refused
  // (IDEAS_REFUSAL). The Codex job and leftover-process lists describe the daemon
  // node's own machine, and the daemon's CLI says so to a node; `--reap` is refused.
  'ideas', 'codex-jobs', 'leftovers',
  // `keep probe <card>` runs the card's own probe, the one the daemon's scheduler
  // runs, on the daemon node, which is where its answer means anything. The command is
  // the card's, never the request's: a node cannot set one (COMMAND_FLAGS). It runs
  // under the probe's own timeout (probeExtraMs).
  'probe',
  // `keep wait` polls the daemon's registry for a hold, a card, a lane or a check to
  // come due. It writes nothing, so like a waiting tell it has a queue of its own and
  // does not hold a restart, and it runs for its --for (nine minutes by default, at
  // most a day).
  'wait',
  // Session decoration and lifecycle preferences the daemon owns (its
  // /api/mark-session, /api/rename-session and /api/session-keep-running, which the
  // daemon's CLI posts to over loopback). A bare form acts on the caller's own session
  // (BARE_SESSION_FORMS); one naming a session acts on that one, as it would on the
  // daemon node.
  'mark', 'rename', 'keep-running',
  // A delegation is a registry record naming the parent session, which the daemon's
  // CLI takes from the caller's verified identity, so a node's delegate needs one. The
  // `-- <command>` form runs the command on the machine the CLI runs on, which for a
  // forwarded one is the daemon's: it is refused (DELEGATE_COMMAND_REFUSAL), and a node
  // prepares the delegation and has the worker accept it instead.
  'delegate',
  // The ones that stop, move or restart sessions, and may take minutes: they run
  // under a long bound on a queue of their own (runsLikeOpen). A node acts on its own
  // sessions only: the one it runs in or one the location record places on it, and a
  // pane on itself (sessionTargetOf, targetRefusal). A move, handoff or force-restart
  // of the caller's own session ends the caller's pane partway, so the node never
  // prints the answer, exactly as for a forwarded open that replaces it; the daemon
  // carries on and the console shows the outcome. A pane a node names is qualified
  // with that node before it is sent (qualifyPaneArgs), since on the daemon a bare
  // pane id is one of the daemon's own. `restore` is forwarded as its plan only
  // (RESTORE_REFUSAL).
  'move', 'handoff', 'force-restart', 'restore',
]);

// Why each command that is deliberately not forwarded runs only on the daemon node,
// which a node's CLI says in place of the generic "the registry lives elsewhere": for
// these that line would read as a missing registry, when the command is one that
// belongs to the daemon's machine. The last three name only some forms of their
// command (daemonOnlyReason): `keep node init` runs on a node, `keep nodes` lists and
// updates there, and the account list is forwarded (ACCOUNTS_ALLOWED), so the reason
// is for `node audit`, `nodes add|rm` and the account writes, which a node without
// the daemon's address also reaches.
const DAEMON_ONLY = Object.freeze({
  serve: 'it is the daemon itself',
  service: "it installs and runs the daemon's service on the machine it is typed on",
  'restart-daemon': 'it restarts the daemon process on its own machine',
  sync: 'it pulls and pushes the registry checkout the daemon owns',
  init: 'it creates a registry, and the registry lives with the daemon',
  'self-repair': "it reads and resets the daemon's own repair records and panes",
  archive: "it moves finished cards within the daemon's registry in bulk",
  transfer: "it reads the source session's transcript, the working tree and the --context file from its own disk",
  node: 'only keep node init runs on a node; the audit compares the daemon node with the node it names',
  nodes: 'the node list and the tokens that reach each node live on the daemon',
  accounts: "it writes the daemon's account configuration and credentials",
});
function daemonOnlyReason(command, args = []) {
  if (!Object.prototype.hasOwnProperty.call(DAEMON_ONLY, command)) return null;
  const argv = Array.isArray(args) ? args : [];
  if (command === 'node' && argv[0] === 'init') return null;
  if (command === 'nodes' && !['add', 'rm'].includes(argv[0])) return null;
  if (command === 'accounts' && (subcommandOf(argv) === null || ACCOUNTS_ALLOWED.includes(subcommandOf(argv)))) return null;
  return DAEMON_ONLY[command];
}
// A forwarded `review-land -` document: one reviewer tick's batch.
const REVIEW_LAND_STDIN_MAX = 1024 * 1024;

// `nodes ls` too: the fleet table is the daemon's, which holds the node list and dials
// each host. A node that answered for itself printed one row named after the daemon,
// with its own socket and status under that name, and a session read the Linux box as
// the daemon. The bare `keep nodes` and `keep nodes usage` stay local (keep.js).
const NODES_ALLOWED = Object.freeze(['update', 'ls']);
const NODES_REFUSAL = 'a node forwards only keep nodes update|ls; the rest runs on the daemon node';

const AGENTS_ALLOWED = Object.freeze(['emit', 'events', 'place']);
const AGENTS_REFUSAL = `a node runs only keep agents ${AGENTS_ALLOWED.join('|')} (or the bare list); the rest runs on the daemon node`;
const AGENTS_EMIT_REFUSAL = "a node's emit names the session it is from; run it inside the agent's session";
function agentsRefusal(args, identity = null) {
  const sub = args[0];
  if (sub !== undefined && !String(sub).startsWith('-') && !AGENTS_ALLOWED.includes(sub)) return AGENTS_REFUSAL;
  if (identity && sub === 'emit' && !identity.session) return AGENTS_EMIT_REFUSAL;
  return null;
}

// The name of a review queue handoff file: the first 24 hex digits of a sha256
// (bin/review-queue.js writeHandoff), and so never a path.
const REVIEW_QUEUE_HANDOFF_NAME_RE = /^[0-9a-f]{24}$/;
const REVIEW_QUEUE_REFUSAL = 'a node runs only keep review-queue handoff <name>; the rest runs on the daemon node';
function reviewQueueRefusal(args) {
  if (args.length === 2 && args[0] === 'handoff' && REVIEW_QUEUE_HANDOFF_NAME_RE.test(args[1])) return null;
  return REVIEW_QUEUE_REFUSAL;
}

// The subcommand a forwarded command's argv names: its first argument, unless that is
// a flag (the bare form).
function subcommandOf(args) {
  const first = args[0];
  return first === undefined || String(first).startsWith('-') ? null : String(first);
}

// Accounts: the list only (the bare form is the list). Every other verb writes the
// daemon's account configuration or the credentials behind it.
const ACCOUNTS_ALLOWED = Object.freeze(['list']);
const ACCOUNTS_REFUSAL = "a node runs only keep accounts list; add, default and setup write the daemon's account configuration and credentials, and run only on the daemon node";
// Incidents: the open list and a close by hand. `parse` reads a file or stdin on the
// node, and `session` runs an area tick with the daemon's own seams (opening,
// typing, closing sessions) in the CLI's process, past a forwarded command's bound.
const INCIDENTS_ALLOWED = Object.freeze(['close']);
const INCIDENTS_REFUSAL = 'a node runs only keep incidents (the open list) and keep incidents close; parse and session run on the daemon node';
// Discord and Slack: their status. A poll classifies messages with a model on the
// daemon, past a forwarded command's bound, and `slack mode` is Owner's setting for
// what the daemon's own poll does.
const FEED_STATUS_REFUSAL = (command) => `a node runs only keep ${command} status; the rest runs on the daemon node`;
const IDEAS_REFUSAL = 'a node runs only keep ideas --dry: a real run asks a model on the daemon node for longer than a forwarded command may take';
const REAP_REFUSAL = (command) => `a node's keep ${command} lists the daemon node's own processes; --reap stops them, so run it on the daemon node`;
const DELEGATE_COMMAND_REFUSAL = 'keep delegate -- <command> would run the command on the daemon node; from a node, run keep delegate <card> --step <n> --prepare and have the worker run keep delegate --accept <id>, or register it with --session <sid> --agent <agent>';

// A real restore opens every session its plan restores, one after another, up to three
// minutes each, with no limit on how many: no bound a forwarded command has covers it,
// and a node told of a timeout would rerun it while the daemon was still opening one.
// Only the plan (`--dry`) is forwarded.
const RESTORE_REFUSAL = 'a node runs only keep restore --dry: a real restore opens any number of sessions one after another, longer than a forwarded command may take; run it on the daemon node, or use the console';
// A move's --recover and --abandon name a journal, not a session, so the route cannot
// tell whose move it is: they stay with the daemon node and the console's buttons.
const MOVE_JOURNAL_REFUSAL = "a node's keep move names the session it moves; recover or abandon a move journal on the daemon node or in the console";

// The refusals a command's arguments alone decide, the same on both sides. Every flag
// here is read as the CLI's parseArgs reads it (readArgs): a `--dry` that parseArgs
// takes as another flag's value is not a --dry.
function formRefusal(command, args) {
  const sub = subcommandOf(args);
  const read = readArgs(command, args);
  const flagged = (name) => read.bools.has(name.slice(2));
  if (command === 'accounts' && sub !== null && !ACCOUNTS_ALLOWED.includes(sub)) return ACCOUNTS_REFUSAL;
  if (command === 'incidents' && sub !== null && !INCIDENTS_ALLOWED.includes(sub)) return INCIDENTS_REFUSAL;
  if ((command === 'discord' || command === 'slack') && sub !== 'status') return FEED_STATUS_REFUSAL(command);
  if (command === 'ideas' && !flagged('--dry')) return IDEAS_REFUSAL;
  if ((command === 'codex-jobs' || command === 'leftovers') && flagged('--reap')) return REAP_REFUSAL(command);
  // commands.delegate splits its argv at the first `--` wherever it stands.
  if (command === 'delegate' && args.includes('--')) return DELEGATE_COMMAND_REFUSAL;
  if (command === 'restore' && !flagged('--dry')) return RESTORE_REFUSAL;
  if (command === 'move' && (read.values.has('recover') || read.values.has('abandon'))) return MOVE_JOURNAL_REFUSAL;
  return null;
}

// The flags whose parseArgs kind is 'many': every following argument up to the next
// flag or -m is a value.
const MANY_FLAGS = Object.freeze({ add: ['plan'], plan: ['set'] });
const EQUALS_REFUSAL = (arg) => {
  const eq = arg.indexOf('=');
  return `keep reads ${arg.slice(0, eq)} <value>, never ${arg.slice(0, eq)}=<value>; write ${arg.slice(0, eq)} ${JSON.stringify(arg.slice(eq + 1))}`;
};
const DASH_VALUE_REFUSAL = (flag) => `${flag} takes a value, and a node's value for it may not begin with "-": keep would read that argument as ${flag}'s value, not as the flag it looks like`;

// `args` read exactly as keep-core.parseArgs reads them for `command`: `--` ends the
// flags, -m takes the next argument whatever it is, a flag BOOLEAN_FLAGS names takes
// none, a 'many' flag takes every argument up to the next flag or -m, and every other
// flag takes the next argument, even one that looks like a flag. Every refusal that
// reads a flag or a positional reads it from here, so a flag hidden as another flag's
// value (`--project --dry`) is never mistaken for itself.
//
// `refusal` is the first spelling a node may not send: `--flag=value`, which parseArgs
// reads as an unknown flag named `flag=value` (so the daemon's CLI would only fail), and
// a value-taking flag whose value begins with "-", which is how a flag is disguised.
function readArgs(command, args) {
  const out = { bools: new Set(), values: new Map(), positionals: [], refusal: null };
  if (!Array.isArray(args)) return out;
  const many = Object.prototype.hasOwnProperty.call(MANY_FLAGS, command) ? MANY_FLAGS[command] : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { out.positionals.push(...args.slice(i + 1)); break; }
    if (arg === '-m') { i += 1; continue; }
    if (typeof arg !== 'string' || !arg.startsWith('--')) { out.positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (name.includes('=')) { out.refusal ||= EQUALS_REFUSAL(arg); continue; }
    if (isBooleanFlag(command, name)) { out.bools.add(name); continue; }
    const values = out.values.get(name) || [];
    if (many.includes(name)) {
      while (i + 1 < args.length && args[i + 1] !== '-m' && !String(args[i + 1]).startsWith('--')) values.push(args[++i]);
    } else if (i + 1 < args.length) {
      const value = args[++i];
      if (String(value).startsWith('-')) out.refusal ||= DASH_VALUE_REFUSAL(arg);
      values.push(value);
    }
    out.values.set(name, values);
  }
  return out;
}

// The spelling refusal readArgs finds, for a command parseArgs reads. `keep wait` reads
// its own argv (bin/wait.js), which refuses a value beginning with "--" itself and
// reads no `=`; a delegate's `--` is refused outright (formRefusal).
function spellingRefusal(command, args) {
  if (command === 'wait') return null;
  return readArgs(command, args).refusal;
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
  // Where the session moves to.
  move: ['--node'],
  // The worker session a parent registers the delegation to, never the parent; it
  // must still be one of the calling node's own (sessionTargetOf, targetRefusal).
  delegate: ['--session'],
});

// The flags whose value is a pane, in the commands that take one. A bare pane id on
// the daemon is one of the daemon's own panes, so a node's CLI qualifies a bare one
// with its own name (qualifyPaneArgs) and the daemon refuses one that is not
// qualified: the pane a node means is never read as a daemon pane of the same id.
const PANE_FLAGS = Object.freeze({
  handoff: ['--pane'],
  'force-restart': ['--pane'],
});
const PANE_UNQUALIFIED_REFUSAL = (flag) => `${flag} from a node must name its node: <pane-id>@<node>`;
const PANE_OTHER_NODE_REFUSAL = (flag, node) => `${flag} must be a pane on the calling node (<pane-id>@${node || '<node>'}): a node stops, moves and restarts only its own sessions; tell and open are the ones that reach other nodes`;

// The session a command that stops, moves, restarts or writes the state of a session
// names, as the CLI will read it, or null when it names none (the caller's own, which
// needs no check, or a form without a session). A node may name only its own session
// or one the location record places on that node (the route's targetRefusal): with
// any id it could otherwise interrupt, move or relabel a session it neither owns nor
// hosts. `tell` and `open` are the deliberate exceptions, reaching any session.
// A delegation's `--session` is its worker: registered against a session elsewhere,
// that session's later commands would count as delegated work, so it is bound the same
// way.
const TARGET_COMMANDS = Object.freeze(['move', 'handoff', 'force-restart', 'mark', 'rename', 'keep-running', 'delegate']);
function sessionTargetOf(command, args) {
  if (!TARGET_COMMANDS.includes(command) || !Array.isArray(args)) return null;
  const read = readArgs(command, args);
  const positionals = read.positionals;
  if (command === 'delegate') return read.values.has('session') ? read.values.get('session').at(-1) ?? null : null;
  if (command === 'rename') return read.bools.has('clear') ? positionals[0] ?? null : positionals.length === 2 ? positionals[0] : null;
  if (command === 'keep-running') return positionals.length === 2 ? positionals[0] : null;
  return positionals[0] ?? null;
}
const NODE_OWN_REFUSAL = (target, node) => `a node acts only on its own sessions: ${target} is neither the calling session nor a session on node ${node}; tell and open are the ones that reach other nodes`;

// The route's check of that target: `resolve` turns an id into { id }, or answers
// { deferred: true } for a `#n` the daemon's CLI resolves and checks itself, and
// `location` is the durable location record. Null or the refusal.
function targetRefusal(command, args, identity, { resolve, location } = {}) {
  const target = sessionTargetOf(command, args);
  if (target === null || target === undefined) return null;
  let resolved = null;
  // A delegation's --session is taken as the literal id it is (keep.js commands.delegate
  // tests it against delegation.SESSION_RE and never looks up a number), so `3` or `s3`
  // there is a session named 3 or s3, checked here, not a number the CLI resolves.
  if (command === 'delegate') resolved = /^[A-Za-z0-9_-]{1,128}$/.test(String(target)) ? { id: String(target) } : null;
  else {
    try { resolved = resolve ? resolve(String(target)) : null; } catch { resolved = null; }
  }
  // A `#n` the resolver leaves to the daemon's CLI, which checks the id it finds.
  if (resolved && resolved.deferred === true) return null;
  if (!resolved || !resolved.id) return NODE_OWN_REFUSAL(target, identity.node);
  if (identity.session && resolved.id === identity.session) return null;
  let where = null;
  try { where = location ? location(resolved.id) : null; } catch { where = null; }
  if (where && identity.node && where.node === identity.node) return null;
  return NODE_OWN_REFUSAL(target, identity.node);
}

// `args` with each bare pane value qualified with `local`, the node the CLI runs on:
// walked the way parseArgs reads it (a `--` ends the flags, -m's value is not one, a
// boolean flag takes none and any other flag the next argument). A `--pane=<id>` is
// left as it is: parseArgs does not read that spelling, and the node refuses it
// (readArgs) before anything is sent.
function qualifyPaneArgs(command, args, local) {
  const flags = Object.prototype.hasOwnProperty.call(PANE_FLAGS, command) ? PANE_FLAGS[command] : [];
  if (!flags.length || !Array.isArray(args) || !local) return args;
  const out = [...args];
  const qualify = (value) => (typeof value === 'string' && value && !value.startsWith('-') && !value.includes('@') ? `${value}@${local}` : value);
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i];
    if (arg === '--') break;
    if (arg === '-m') { i += 1; continue; }
    if (typeof arg !== 'string' || !arg.startsWith('--') || arg.includes('=') || isBooleanFlag(command, arg.slice(2))) continue;
    if (i + 1 < out.length && flags.includes(arg)) out[i + 1] = qualify(out[i + 1]);
    i += 1;
  }
  return out;
}

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
  // A delegation names its parent (or, for --accept and --end, its worker) as the
  // session the daemon verified, in every form.
  delegate: "a node's delegate names the session it is from; run it inside an agent session",
});

// The commands whose bare form means "my session": from a node shell with none they
// are refused, since the daemon's CLI would find no session to act on and the node
// would be told something about the daemon's environment. A form naming a session
// needs none. Each reads the positionals the CLI will see (isBareSessionForm).
const BARE_SESSION_FORMS = Object.freeze(['mark', 'rename', 'keep-running']);
function isBareSessionForm(command, args) {
  const read = readArgs(command, args);
  const positionals = read.positionals;
  // keep mark [<#n|id>] --emoji …; --colors lists the palette and names no session.
  if (command === 'mark') return positionals.length === 0 && !read.bools.has('colors');
  // keep rename [<#n|id>] "title" | keep rename [<#n|id>] --clear
  if (command === 'rename') return positionals.length === (read.bools.has('clear') ? 0 : 1);
  // keep keep-running [<#n|id>] on|off
  if (command === 'keep-running') return positionals.length === 1;
  return false;
}
const BARE_SESSION_REFUSAL = (command) => `a node's ${command} with no session named acts on the session it is from; run it inside an agent session, or name the session`;

function bareSessionRefusal(command, args, identity) {
  if (identity.session || !BARE_SESSION_FORMS.includes(command)) return null;
  return isBareSessionForm(command, args) ? BARE_SESSION_REFUSAL(command) : null;
}

// `keep compact <id>` without --when-idle compacts now, and the daemon's CLI waits for
// it: up to KEEP_COMPACT_TIMEOUT_MS (four minutes by default), past the minute a
// forwarded command is given, so the node would be told of a timeout while the daemon
// carried on. A node asks for the idle-time form, which files a request and returns.
const COMPACT_NOW_REFUSAL = "a node's keep compact <id> would compact now and outlast a forwarded command; add --when-idle, or run it on the daemon node";
function compactRefusal(args) {
  const read = readArgs('compact', args);
  return read.positionals.length && !read.bools.has('when-idle') ? COMPACT_NOW_REFUSAL : null;
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
  reports: ['json', 'all'],
  'review-bundle': ['queue', 'raw', 'force'],
  'review-stats': ['json'],
  'review-note': ['force', 'no-digest'],
  'review-ack': ['probe-safe'],
  'review-outcome': ['json'],
  alert: ['dry', 'force'],
  compact: ['when-idle'],
  'review-queue': ['json'],
  usage: ['json'],
  lint: ['json', 'fix-hints'],
  alerts: ['all'],
  brief: ['send'],
  accounts: ['json'],
  incidents: ['dry', 'json'],
  discord: ['dry'],
  slack: ['dry'],
  ideas: ['dry'],
  'codex-jobs': ['json', 'reap', 'dry'],
  leftovers: ['json', 'reap', 'dry'],
  mark: ['no-emoji', 'no-color', 'clear', 'colors'],
  rename: ['clear'],
  delegate: ['prepare', 'end'],
  move: ['force', 'dry', 'json'],
  handoff: ['force'],
  'force-restart': ['recover'],
  restore: ['dry'],
  // `keep wait` reads its own argv (bin/wait.js parseWaitArgs), where every flag takes
  // a value (`--lane` two), and `quiet`, `probe` and `keep-running` take no flags.
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
  // `keep wait --no-hold <project>` and `--lane <project> <step>`.
  wait: ['--no-hold', '--lane'],
  restore: ['--project'],
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
  if (command === 'review-queue' && reviewQueueRefusal(args)) return reviewQueueRefusal(args);
  if (formRefusal(command, args)) return formRefusal(command, args);
  if (Object.prototype.hasOwnProperty.call(SESSION_REFUSALS, command) && !identity.session) return SESSION_REFUSALS[command];
  if (bareSessionRefusal(command, args, identity)) return bareSessionRefusal(command, args, identity);
  if (requestedWaitMs(command, args) > MAX_FORWARDED_WAIT_MS) return waitCapRefusal(command);
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
  const paneFlags = Object.prototype.hasOwnProperty.call(PANE_FLAGS, command) ? PANE_FLAGS[command] : [];
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
    if (flag && paneFlags.includes(flag)) {
      const named = eq < 0 ? args[i + 1] : arg.slice(eq + 1);
      if (typeof named !== 'string' || !named.includes('@')) return PANE_UNQUALIFIED_REFUSAL(flag);
      // A node stops or restarts only a pane on itself (NODE_OWN_REFUSAL).
      const at = named.lastIndexOf('@');
      if (at < 1 || !identity.node || named.slice(at + 1) !== identity.node) return PANE_OTHER_NODE_REFUSAL(flag, identity.node);
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
  // Last, so a flag the rules above name is refused under its own reason first.
  return spellingRefusal(command, args);
}

// How long a forwarded command may wait on the daemon beyond an ordinary run: a
// `tell --wait <duration>` re-asks a busy session until that duration runs out, a
// `keep wait` polls for its --for, and an `open` waits for the session it starts
// (OPEN_EXTRA_MS). Both the daemon's subprocess and the node's request must outlast it.
//
// At most a day. A waiting tell does not hold a daemon restart, so its started
// journal entry is all that stops a resend running it twice, and entries are pruned
// after a week (registry-route JOURNAL_TTL_MS); a timer set past about 24.8 days
// also fires at once.
const MAX_FORWARDED_WAIT_MS = 24 * 3600e3;
const WAIT_CAP_REFUSAL = '--wait on a forwarded tell is at most 24h';
function waitCapRefusal(command) {
  return command === 'wait' ? '--for on a forwarded wait is at most 24h' : WAIT_CAP_REFUSAL;
}
// What `keep wait` waits with no --for (bin/wait.js parseWaitArgs).
const WAIT_DEFAULT_MS = 9 * 60e3;

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
//
// The commands that stop, move or restart sessions are bounded like an open too, and
// for the same reason: each posts to a daemon route that carries on when the CLI is
// killed. `handoff` waits up to three minutes for its transfer (/api/handoff-session),
// and `force-restart` asks the daemon to restart a pane, which it then owns. A `move`
// has its own, longer bound (MOVE_EXTRA_MS). (A node's `restore` is only its plan,
// `--dry`, an ordinary read: RESTORE_REFUSAL.)
const LONG_RUNNING = Object.freeze(['open', 'verify', 'move', 'handoff', 'force-restart']);
function runsLikeOpen(command) {
  return LONG_RUNNING.includes(command);
}
// The long-running commands whose bound is an open's, and so grows with the daemon's
// compaction timeout: a move's is fixed.
function boundedLikeOpen(command) {
  return runsLikeOpen(command) && command !== 'move';
}
// A move carries a session's whole transcript between machines, and the CLI gives
// /api/move-session thirty minutes (commands.move); the forwarded run outlasts that by
// a minute, so the node prints the CLI's own answer, a timeout included, which names
// the journal a move that stopped part way continues from.
const MOVE_EXTRA_MS = 31 * 60e3;
// `keep probe` runs the card's probe under keep-core runProbe's timeout, which the
// daemon's child reads from KEEP_PROBE_TIMEOUT_MS; the route's child environment does
// not carry it, so the two-minute default applies, and fifteen seconds cover the rest.
const PROBE_EXTRA_MS = 120e3 + 15e3;
const OPEN_UNBOUNDED_REFUSAL = "this daemon's compaction timeout is set so high that a forwarded open cannot be bounded; run keep open on the daemon node, or lower KEEP_COMPACT_TIMEOUT_MS";
function unboundedRefusal(command) {
  if (command === 'open') return OPEN_UNBOUNDED_REFUSAL;
  return OPEN_UNBOUNDED_REFUSAL.replace('a forwarded open', `a forwarded ${command}`).replace('run keep open', `run keep ${command}`);
}

// `env` is the daemon's own environment, passed only by the daemon's route: a node's
// environment says nothing about the daemon's compaction timeout, so a node leaves
// it out and gets the floor.
function forwardedWaitMs(command, args, env) {
  if (command === 'move') return MOVE_EXTRA_MS;
  if (runsLikeOpen(command)) return env ? openExtraMs(env) : OPEN_EXTRA_MS;
  if (command === 'probe') return PROBE_EXTRA_MS;
  return Math.min(requestedWaitMs(command, args), MAX_FORWARDED_WAIT_MS);
}

// A tell that re-asks a busy session: all it does for most of its run is post to
// the daemon's /api/tell, so it neither holds a daemon restart nor keeps the node's
// other commands waiting (registry-route handle).
function isWaitingTell(command, args) {
  return command === 'tell' && requestedWaitMs(command, args) > 0;
}

// A run that only waits: a waiting tell, or a `keep wait`, which reads the registry
// until its condition holds and writes nothing. Neither holds a restart.
function isWaiting(command, args) {
  return command === 'wait' || isWaitingTell(command, args);
}

// What a node can refuse before it posts, from the arguments alone: a form it does not
// forward (formRefusal and the per-command tables), a file named on the node, and a
// wait past the cap. The identity rules need the daemon's location record and are
// left to the route, which applies these as well. A bare --pane is qualified before
// this (qualifyPaneArgs), so the route's refusal of one is for other callers.
function nodeSideRefusal(command, args) {
  if (!Array.isArray(args)) return null;
  if ((command === 'turns' || command === 'search') && turnsRefusal(args, command)) return turnsRefusal(args, command);
  if (command === 'nodes' && !NODES_ALLOWED.includes(args[0])) return NODES_REFUSAL;
  if (command === 'agents' && agentsRefusal(args)) return agentsRefusal(args);
  if (command === 'compact' && compactRefusal(args)) return compactRefusal(args);
  if (command === 'review-queue' && reviewQueueRefusal(args)) return reviewQueueRefusal(args);
  if (formRefusal(command, args)) return formRefusal(command, args);
  const fileFlags = Object.prototype.hasOwnProperty.call(NODE_FILE_FLAGS, command) ? NODE_FILE_FLAGS[command] : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--') break;
    if (arg === '-m') { i += 1; continue; }
    const flag = arg.startsWith('--') ? arg.split('=')[0] : null;
    if (flag && fileFlags.includes(flag)) return `${flag} names a file on this node; use -m, or run it from the daemon node`;
  }
  if (requestedWaitMs(command, args) > MAX_FORWARDED_WAIT_MS) return waitCapRefusal(command);
  return spellingRefusal(command, args);
}

// The --wait a forwarded tell asks for, or the --for of a `keep wait` (nine minutes
// when it names none), read the way the CLI reads it (the last one wins, a
// value-taking flag takes the next argument, -m's value and everything after `--`
// are not flags). A value that does not parse is 0: the daemon's CLI answers it with
// its usage error well inside the ordinary bound.
function requestedWaitMs(command, args) {
  if ((command !== 'tell' && command !== 'wait') || !Array.isArray(args)) return 0;
  let wait = null;
  if (command === 'tell') {
    const values = readArgs('tell', args).values.get('wait');
    wait = values && values.length ? values.at(-1) : null;
  } else {
    // bin/wait.js parseWaitArgs: each flag takes this many values, --lane two; anything
    // else, or a value beginning with "--", is its usage error, answered at once.
    const arity = { '--no-hold': 1, '--scope': 1, '--card': 1, '--lane': 2, '--check-due': 1, '--for': 1, '--interval': 1 };
    for (let i = 0; i < args.length; i += 1) {
      const take = arity[args[i]];
      if (!take) return 0;
      const values = args.slice(i + 1, i + 1 + take);
      if (values.length < take || values.some((value) => !value || String(value).startsWith('--'))) return 0;
      if (args[i] === '--for') wait = values[0];
      i += take;
    }
  }
  if (wait == null) return command === 'wait' ? WAIT_DEFAULT_MS : 0;
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

module.exports = { NODE_OWN_REFUSAL, TARGET_COMMANDS, sessionTargetOf, targetRefusal, DAEMON_ONLY, daemonOnlyReason, qualifyPaneArgs, PANE_FLAGS, BARE_SESSION_FORMS, MOVE_EXTRA_MS, PROBE_EXTRA_MS, WAIT_DEFAULT_MS, boundedLikeOpen, unboundedRefusal, isWaiting, REVIEW_QUEUE_HANDOFF_NAME_RE, REVIEW_QUEUE_REFUSAL, REVIEW_LAND_STDIN_MAX, stdinRefusal, ARTIFACT_STORE_MAX_FILES, ARTIFACT_NODE_DAILY_BYTES, ARTIFACT_NODE_DAILY_FILES, ARTIFACT_QUOTA_WINDOW_MS, ARTIFACT_STORE_MAX_BYTES, ARTIFACT_FILE_MAX_BYTES, ARTIFACT_COMMAND_MAX_BYTES, ARTIFACT_MAX_FILES, ARTIFACT_BODY_MAX_BYTES, ARTIFACT_NAME_MAX_BYTES, artifactNameRefusal, REGISTRY_COMMANDS, COMMAND_FLAGS, NODE_FILE_FLAGS, PLACEMENT_FLAGS, SESSION_REFUSALS, BOOLEAN_FLAGS, MAX_FORWARDED_WAIT_MS, OPEN_EXTRA_MS, MAX_OPEN_EXTRA_MS, OPEN_UNBOUNDED_REFUSAL, openExtraMs, openRequiredMs, forwardedWaitMs, runsLikeOpen, isWaitingTell, nodeSideRefusal, PROJECT_FLAGS, PROJECT_POSITIONS, MAX_ARG_BYTES, MAX_ARGS_BYTES, isRegistryCommand, argumentRefusal };
