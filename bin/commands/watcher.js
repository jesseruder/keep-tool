// keep watcher — the shadow turn watcher: replaying indexed turns past the
// attention model and comparing what it would have said with what happened.

'use strict';

const {
  loadTaskAnywhere, die, parseArgs, withLock, commitAndPush,
} = require('../keep-core.js');
const path = require('path');
const { turnsClip, turnsIndexNumber, turnsSince, turnsStamp } = require('./turns.js');

const commands = {};

function watcherSessionsFor(id) {
  let task = null;
  try { task = loadTaskAnywhere(id); } catch {}
  if (task) {
    const linked = (task.fm.sessions || []).map((entry) => entry && entry.id).filter(Boolean);
    if (!linked.length) die(`card ${id} has no linked sessions`);
    return linked;
  }
  if (!require('../turn-index.js').sessionRow(id)) die(`no card or indexed session "${id}"`);
  return [id];
}

async function watcherRun(argv) {
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { turn: 'str', dry: 'bool', json: 'bool' });
  const id = o._[0];
  if (!id) die('usage: keep watcher run <session-id|card-id> [--turn n] [--dry]');
  const n = turnsIndexNumber(o.turn, '--turn');
  const out = [];
  for (const sessionId of watcherSessionsFor(id)) {
    const turn = watcher.turnFor(sessionId, n);
    if (!turn) { out.push({ session: sessionId, error: 'no indexed turn' }); continue; }
    if (o.dry) {
      // --dry is the whole point of shadow mode's shadow mode: see exactly what
      // the model would be shown, and what the rules alone would say, for free.
      const context = watcher.buildContext(turn);
      out.push({ session: sessionId, turn: turn.n, dry: true, rule: context.rule, signals: context.signals, context: context.text });
      continue;
    }
    // An explicit `keep watcher run` is a deliberate re-judge, so it may replace
    // an existing verdict — but never the decision Owner may already have marked.
    out.push(await watcher.judge(turn, { force: true }));
  }
  if (o.json) return console.log(JSON.stringify(out, null, 2));
  for (const entry of out) {
    if (entry.error) { console.log(`${entry.session}: ${entry.error}`); continue; }
    if (entry.dry) {
      console.log(`${entry.session} turn ${entry.turn} — rule verdict: ${entry.rule.verdict} (${entry.rule.reason})`);
      if (entry.rule.message) console.log(`  would type: ${entry.rule.message}`);
      console.log(`--- context (${Buffer.byteLength(entry.context)} bytes, not sent) ---\n${entry.context}`);
      continue;
    }
    console.log(`${String(entry.session).slice(0, 8)} turn ${entry.n}: ${entry.verdict}`
      + `${entry.confidence == null ? '' : ` (${Math.round(entry.confidence * 100)}%)`} — ${entry.reason}`);
    if (entry.stateLine) console.log(`  state: ${entry.stateLine}`);
    if (entry.message) console.log(`  would type: ${entry.message}`);
    const reused = entry.reusedDecision ? ' (verdict refreshed; the existing decision is kept, one per turn)' : '';
    console.log(`  recorded, not sent${entry.decisionId ? ` — keep decisions agree|disagree|edit ${entry.decisionId}` : ''}${reused}`);
  }
}

function watcherLs(argv) {
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { since: 'str', verdict: 'str', limit: 'str', json: 'bool' });
  if (o.verdict && !watcher.VERDICTS.includes(o.verdict)) die(`--verdict must be one of: ${watcher.VERDICTS.join(', ')}`);
  const rows = watcher.listVerdicts({
    sinceMs: turnsSince(o.since), verdict: o.verdict || null,
    limit: turnsIndexNumber(o.limit, '--limit') || 50,
  });
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('no verdicts');
  for (const row of rows) {
    console.log(`${turnsStamp(row.verdict_at)}  ${String(row.session_id).slice(0, 8)}  ${String(row.n).padStart(4)}  `
      + `${String(row.verdict).padEnd(11)} ${row.verdict_confidence == null ? '  - ' : `${Math.round(row.verdict_confidence * 100)}%`.padStart(4)}  `
      + `${turnsClip(row.state_line, 70).padEnd(70)} | ${turnsClip(row.verdict_message, 80)}`);
  }
}

// ---------- attention comparison ----------

// The console's "Waiting on you" bucket against the watcher's own judgement, on
// the turns where both spoke. Three of the rules behind that bucket are inferred
// from prose rather than observed on screen, and the restricted table is the
// actual question: on those three, is the model better? Reporting only — nothing
// here changes what the console shows or overrides a rule.
const COMPARE_WIDTH = 112;

// A reason or an assistant tail can be one unbroken token — a url, a sha, a
// stack frame — so a word-wrapper alone does not bound the line. Anything longer
// than the room available is cut, because a 200-column line is not readable in
// the terminal this is meant to be read in.
function watcherWrap(text, indent) {
  const room = Math.max(20, COMPARE_WIDTH - indent.length);
  const words = [];
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    for (let at = 0; at < word.length; at += room) words.push(word.slice(at, at + room));
  }
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > room) { lines.push(indent + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines;
}

function watcherMatrixLines(label, matrix) {
  const cell = (n, tag) => `${String(n).padStart(7)} ${tag}`.padEnd(18);
  return [
    `${label} — ${matrix.total} turn${matrix.total === 1 ? '' : 's'}`
      + `${matrix.drift ? `, ${matrix.drift} drift excluded` : ''}`,
    `  ${''.padEnd(22)}${'model needs-input'.padEnd(18)}model continue/quiet`,
    `  ${'machine needs-input'.padEnd(22)}${cell(matrix.bothYes, 'agree')}${cell(matrix.noise, 'noise')}`.trimEnd(),
    `  ${'machine not'.padEnd(22)}${cell(matrix.missed, 'missed')}${cell(matrix.bothNo, 'agree')}`.trimEnd(),
    `  agreement ${matrix.total ? `${Math.round((matrix.agreed / matrix.total) * 100)}%` : '-'}`
      + ` (${matrix.agreed}/${matrix.total})`,
  ];
}

function watcherCompare(argv) {
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { since: 'str', limit: 'str', only: 'str', json: 'bool' });
  if (o.only && !['disagreements', 'all'].includes(o.only)) die('--only must be disagreements or all');
  const result = watcher.compare({
    sinceMs: turnsSince(o.since), limit: turnsIndexNumber(o.limit, '--limit') || 40, only: o.only || 'disagreements',
  });
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  if (!result.matrix.all.total && !result.matrix.all.drift) {
    return console.log('no turns with both a verdict and a recorded attention rule'
      + ' — the daemon records one per judged turn (KEEP_WATCHER=1)');
  }
  const lines = [...watcherMatrixLines('all rules', result.matrix.all), ''];
  lines.push(...watcherMatrixLines('inferred rules only', result.matrix.inferred));
  lines.push(`  (${result.inferredRules.join(', ')} — only where the rule itself said inferred)`);
  lines.push('', `${'per rule'.padEnd(26)}${'confidence'.padEnd(11)}${'turns'.padStart(7)}${'agree'.padStart(7)}`
    + `${'noise'.padStart(7)}${'missed'.padStart(7)}${'drift'.padStart(7)}`);
  for (const rule of result.rules) {
    lines.push(`${turnsClip(rule.rule, 25).padEnd(26)}${turnsClip(rule.confidence || '-', 10).padEnd(11)}`
      + `${String(rule.total).padStart(7)}${String(rule.agreed).padStart(7)}${String(rule.noise).padStart(7)}`
      + `${String(rule.missed).padStart(7)}${String(rule.drift).padStart(7)}`);
  }
  lines.push('', result.only === 'all' ? `turns (newest first, ${result.rows.length} shown)`
    : `disagreements (missed first, then noise; newest first, ${result.rows.length} shown)`);
  if (!result.rows.length) lines.push('  none');
  for (const row of result.rows) {
    // Every field here is agent- or registry-written, so each one is clipped:
    // a long card id or rule name must not push the row past the terminal.
    lines.push('', `${row.direction.padEnd(8)}${turnsStamp(row.at)}  ${String(row.session).slice(0, 8)}`
      + `  ${turnsClip(row.card || '-', 16).padEnd(17)}${turnsClip(row.rule, 24)} → ${turnsClip(row.state, 14)}`
      + `${row.confidence ? ` (${turnsClip(row.confidence, 10)})` : ''}`);
    lines.push(...watcherWrap(`${row.verdict}: ${row.reason}`, '    '));
    if (row.tail) lines.push(...watcherWrap(`ended: ${row.tail}`, '    '));
    lines.push(...watcherWrap(row.show, '    '));
  }
  console.log(lines.join('\n'));
}

async function watcherReplay(argv) {
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { since: 'str', limit: 'str', agent: 'str', json: 'bool' });
  if (o.agent && !['claude', 'codex'].includes(o.agent)) die('--agent must be claude or codex');
  const result = await watcher.replay({
    sinceMs: turnsSince(o.since), limit: turnsIndexNumber(o.limit, '--limit') || 100, agent: o.agent || null,
  });
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  if (!result.total) return console.log(`no scorable turns (${watcherSkips(result)})`);
  console.log(renderScoreboard(result, watcher));
  if (result.savedTo) console.log(`\nscoreboard saved to ${result.savedTo}`);
}

// Scores what the console already showed, against what Owner typed next. No
// model call and no write, so it is safe to run at any time and as often as liked.
function watcherScore(argv) {
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { since: 'str', agent: 'str', misses: 'str', 'include-late': 'bool', json: 'bool' });
  if (o.agent && !['claude', 'codex'].includes(o.agent)) die('--agent must be claude or codex');
  // Every stored verdict by default: the question is the whole record, and the
  // index already drops sessions idle past its retention.
  const result = watcher.scoreLive({
    sinceMs: o.since ? turnsSince(o.since) : 0, agent: o.agent || null, includeLate: Boolean(o['include-late']),
  });
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  if (!result.verdicts) return console.log('no live verdicts stored (the daemon judges turns only with KEEP_WATCHER=1)');
  const unanswered = Object.entries(result.unanswered).map(([verdict, n]) => `${n} ${verdict}`).join(', ');
  console.log(`${result.verdicts} live verdicts; ${unanswered ? `no reply yet to ${unanswered}` : 'every one has a reply'}\n`);
  if (!result.total) return console.log(`no scorable turns (${watcherSkips(result)})`);
  console.log(renderScoreboard(result, watcher));
  const limit = o.misses == null ? 10 : o.misses === '0' ? 0 : turnsIndexNumber(o.misses, '--misses');
  const misses = result.samples.filter((sample) => !sample.agreed).slice(0, limit);
  if (misses.length) {
    console.log(`\nnewest ${misses.length} misses (--misses n for more, --json for all):`);
    for (const miss of misses) {
      console.log(`\n${turnsStamp(miss.at)}  ${String(miss.session).slice(0, 8)}#${miss.n}  said ${miss.actual}`
        + `${miss.confidence == null ? '' : ` (${miss.confidence})`}, Owner did ${miss.expected} [${miss.rule}]`);
      if (miss.message) console.log(`    proposed: ${turnsClip(miss.message, 110)}`);
      console.log(`    typed:    ${turnsClip(miss.nextOpener, 110)}`);
    }
  }
}

function watcherPct(value) {
  return value == null ? '   -' : `${Math.round(value * 100)}%`.padStart(4);
}

function watcherSkips(result) {
  const skipped = (result && result.skipped) || { total: 0, reasons: {} };
  const reasons = Object.entries(skipped.reasons || {}).map(([name, n]) => `${n} ${name}`).join(', ');
  return `${skipped.total} skipped${reasons ? `: ${reasons}` : ''}`;
}

function renderScoreboard(result, watcher) {
  const lines = [`${result.total} turns scored against what Owner actually typed next — `
    + `${watcherPct(result.agreement)} agreement (${watcherPct(result.softAgreement)} with half credit`
    + ` where quiet was harmless); ${watcherSkips(result)}`, ''];
  lines.push(`${'verdict'.padEnd(12)}${'precision'.padStart(10)}${'recall'.padStart(8)}${'predicted'.padStart(10)}${'expected'.padStart(9)}`);
  for (const row of result.rows) {
    lines.push(`${row.verdict.padEnd(12)}${watcherPct(row.precision).padStart(10)}${watcherPct(row.recall).padStart(8)}`
      + `${String(row.predicted).padStart(10)}${String(row.expected).padStart(9)}`);
  }
  // The graduation question is not "is the watcher right on average" but "is a
  // high-confidence continue safe to send", so the bands carry continue precision.
  lines.push('', `${'confidence'.padEnd(12)}${'turns'.padStart(7)}${'agree'.padStart(7)}${'continue'.padStart(10)}${'continue ok'.padStart(12)}`);
  for (const band of result.bands) {
    if (!band.total) continue;
    const cont = band.verdicts.continue;
    lines.push(`${band.label.padEnd(12)}${String(band.total).padStart(7)}${watcherPct(band.agreement).padStart(7)}`
      + `${String(cont.predicted).padStart(10)}${watcherPct(cont.precision).padStart(12)}`);
  }
  // Which ground-truth rule is driving the misses, without reading samples.
  if (result.rules && result.rules.length) {
    lines.push('', `${'ground truth rule'.padEnd(26)}${'turns'.padStart(7)}${'agree'.padStart(7)}${'rate'.padStart(7)}`);
    for (const rule of result.rules) {
      lines.push(`${rule.rule.padEnd(26)}${String(rule.total).padStart(7)}${String(rule.agreed).padStart(7)}`
        + `${watcherPct(rule.agreement).padStart(7)}`);
    }
  }
  lines.push('', 'confusion (rows = what Owner did, columns = what the watcher said)');
  lines.push(`${''.padEnd(12)}${watcher.VERDICTS.map((verdict) => verdict.padStart(12)).join('')}`);
  for (const expected of watcher.VERDICTS) {
    lines.push(`${expected.padEnd(12)}${watcher.VERDICTS.map((actual) => String(result.confusion[expected][actual]).padStart(12)).join('')}`);
  }
  return lines.join('\n');
}

function watcherStats(argv) {
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { since: 'str', json: 'bool' });
  const result = watcher.stats({ sinceMs: turnsSince(o.since) });
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`since ${new Date(result.since).toISOString().slice(0, 16).replace('T', ' ')} — ${result.total} verdicts`);
  for (const row of result.rows) {
    console.log(`  ${row.verdict.padEnd(12)} ${String(row.turns).padStart(6)}${row.replays ? ` (${row.replays} replay)` : ''}`);
  }
  if (result.total) {
    console.log(`\n${'confidence'.padEnd(12)}${'turns'.padStart(7)}${watcher.VERDICTS.map((v) => v.padStart(12)).join('')}`);
    for (const band of result.bands) {
      if (!band.total) continue;
      console.log(`${band.label.padEnd(12)}${String(band.total).padStart(7)}`
        + watcher.VERDICTS.map((verdict) => String(band.verdicts[verdict]).padStart(12)).join(''));
    }
  }
  console.log(`\ndelivery: ${require('../watcher-live.js').describeConfig(result.live)}`);
  if (result.delivered?.total) {
    console.log(`\n${result.delivered.total} delivered live:`);
    for (const row of result.delivered.rows) {
      const rate = row.judged ? `${row.agree}/${row.judged} agree` : 'none graded yet';
      console.log(`  ${row.type.padEnd(12)} ${String(row.judged + row.pending).padStart(4)} sent · ${rate}`);
    }
  }
  console.log('');
  console.log(require('../decisions.js').renderStats(result.ledger));
  if (result.replay) {
    const when = new Date(result.replay.at || 0).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`\nlast replay (${when}, ${path.basename(result.replay.file)}):\n`);
    console.log(renderScoreboard(result.replay, watcher));
  }
}

// The only switch that lets a watcher verdict reach a running agent. Per type,
// off by default, and a type cannot be turned on until its own shadow record
// says it has earned it — `--force` exists so Owner can overrule that, loudly.
function watcherLive(argv) {
  const live = require('../watcher-live.js');
  const watcher = require('../turn-watcher.js');
  const o = parseArgs(argv, { force: 'bool', json: 'bool' });
  const arg = o._[0];
  const config = live.loadConfig();
  if (arg) {
    let wanted;
    let skipped = [];
    if (arg === 'off') {
      wanted = [];
    } else if (arg === 'on') {
      // `on` means "everything that has earned it", not "everything". A new
      // verdict type has no record on day one, and the old reading made adding
      // one turn this command into a flat refusal for the types that had.
      if (o.force) {
        die('`on` turns on the types that have earned it; to overrule graduation, name them:\n'
          + `  keep watcher live ${live.TYPES.join(',')} --force`);
      }
      const stats = watcher.stats({ sinceMs: 0 }).ledger;
      const checks = live.TYPES.map((type) => ({ type, check: live.graduationCheck(type, stats) }));
      const earned = checks.filter((row) => row.check.ok).map((row) => row.type);
      // Additive, and only additive. A prompt edit resets what counts toward
      // graduation, so `on` run afterwards would otherwise silently switch off
      // whatever was already delivering — a change to live behaviour nobody
      // asked for, from a word that reads like "more". Turning something off is
      // `off`, or naming the list that should stay on.
      const alreadyLive = live.liveTypes(config);
      wanted = [...new Set([...alreadyLive, ...earned])];
      skipped = checks.filter((row) => !row.check.ok && !alreadyLive.includes(row.type));
      const added = earned.filter((type) => !alreadyLive.includes(type));
      if (alreadyLive.length) {
        const one = alreadyLive.length === 1;
        console.log(`${alreadyLive.length} type${one ? '' : 's'} ${one ? 'was' : 'were'} already live`
          + ` and ${one ? 'stays' : 'stay'} on: ${alreadyLive.join(', ')}`);
      }
      if (!added.length) {
        console.log(`nothing new has earned live delivery under prompt ${watcher.PROMPT_HASH};`
          + ` currently live: ${alreadyLive.length ? alreadyLive.join(', ') : 'none'}`);
      }
    } else {
      wanted = arg.split(',').map((type) => type.trim()).filter(Boolean);
      const unknown = wanted.filter((type) => !live.TYPES.includes(type));
      if (unknown.length) die(`unknown verdict type${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}\nvalid: ${live.TYPES.join(', ')}`);
      if (!o.force) {
        const stats = watcher.stats({ sinceMs: 0 }).ledger;
        const refusals = wanted.map((type) => live.graduationCheck(type, stats)).filter((check) => !check.ok);
        if (refusals.length) {
          die(`${refusals.map((check) => check.reason).join('\n')}\n`
            + 'Grade more with `keep decisions` (or the console), or pass --force to overrule.');
        }
      }
    }
    for (const row of skipped) console.log(`not turned on: ${row.check.reason}`);
    const next = { ...config, live: Object.fromEntries(live.TYPES.map((type) => [type, wanted.includes(type)])) };
    live.saveConfig(next);
    // Best effort: this is the riskiest switch in the system, so when the
    // registry is a git repo the change belongs in its history — but a registry
    // that is not one must still be able to turn delivery off.
    try { withLock(() => commitAndPush(`keep: watcher live ${wanted.length ? wanted.join(',') : 'off'}`, ['watch'])); }
    catch (error) { process.stderr.write(`keep: switch saved but not committed: ${error.message.split('\n')[0]}\n`); }
  }
  const current = live.loadConfig();
  if (o.json) return console.log(JSON.stringify(current, null, 2));
  console.log(`watcher delivery: ${live.describeConfig(current)}`);
  if (live.liveTypes(current).length) console.log('turn everything off instantly with: keep watcher live off');
}

const WATCHER_SUBCOMMANDS = {
  run: watcherRun, ls: watcherLs, replay: watcherReplay, stats: watcherStats, live: watcherLive,
  compare: watcherCompare, score: watcherScore,
};

commands.watcher = async (argv) => {
  const sub = WATCHER_SUBCOMMANDS[argv[0]];
  if (!sub) die('usage: keep watcher run|ls|compare|replay|score|stats|live (see keep help watcher)');
  return sub(argv.slice(1));
};

module.exports = { commands };
