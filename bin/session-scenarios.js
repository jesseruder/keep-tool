#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { replay, minimize, ScenarioFailure } = require('./scenarios/harness');
const { cases, generated } = require('./scenarios/cases');
function run(argv) {
  let seed = 1, count = 50, file;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--seed') seed = Number(argv[++i]);
    else if (flag === '--cases') count = Number(argv[++i]);
    else if (flag === '--replay') file = argv[++i];
    else throw Error('Usage: npm run test:scenarios -- [--seed N] [--cases N] [--replay file.json]');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(count) || count < 0 || count > 1000) throw Error('seed must be uint32; cases must be 0..1000');
  const suite = file ? [JSON.parse(fs.readFileSync(file, 'utf8'))] : ['claude', 'codex'].flatMap(agent => [
    ...cases.filter(c => !c.agent || c.agent === agent).map(c => ({ ...c, agent })),
    ...Array.from({ length: count }, (_, i) => ({ name: `seed-${(seed + i) >>> 0}`, agent, events: generated((seed + i) >>> 0) })),
  ]);
  let transitions = 0;
  for (const scenario of suite) {
    try { transitions += replay(scenario.agent, scenario.events).length; }
    catch (error) {
      if (!(error instanceof ScenarioFailure)) throw error;
      const minimal = minimize(scenario.agent, scenario.events, error);
      console.error(`FAIL ${scenario.agent}/${scenario.name}: ${error.message}`);
      console.error('Observed trace:', JSON.stringify(error.timeline, null, 2));
      console.error('Reduced replay JSON, preserving semantic events (save and pass --replay):');
      console.error(JSON.stringify({ name: scenario.name, agent: scenario.agent, events: minimal }, null, 2));
      return 1;
    }
  }
  console.log(`PASS ${suite.length} scenarios, ${transitions} transitions; seed=${seed}, generated cases per agent=${count}`);
  return 0;
}
if (require.main === module) { try { process.exitCode = run(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { run };
