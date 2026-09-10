'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { polls } = require('./code-mode-polls');

test('labelled ordered results map polls to exact output slots', () => {
  assert.deepEqual(polls('const r=await Promise.all([tools.write_stdin({session_id:12}),tools.exec_command({cmd:"true"})]); for(let i=0;i<r.length;i++){text(`---${i+1}---`);text(r[i]);}'),
    [{ name: 'write_stdin', target: '12', index: 2, count: 4 }]);
});

test('literal connector loops and parallel maps have bounded counts around polls', () => {
  assert.deepEqual(polls('text(await tools.write_stdin({session_id:12})); for(const id of ["a","b"]){const r=await tools.ci({id});text(r.structuredContent??r);}text(await tools.exec_command({cmd:"true"}));'),
    [{ name: 'write_stdin', target: '12', index: 1, count: 4 }]);
  assert.deepEqual(polls('await Promise.all(["a","b"].map(async id=>{const r=await tools.ci({id});text(r.structuredContent??r);}));text(await tools.write_stdin({session_id:12}));'),
    [{ name: 'write_stdin', target: '12', index: 3, count: 3 }]);
  assert.deepEqual(polls('text(await tools.write_stdin({session_id:12}));await Promise.all([["x","y"],["z","w"]].map(async ([op,out])=>text({op,out,...await tools.exec_command({cmd:`echo ${op} ${out}`})})));'),
    [{ name: 'write_stdin', target: '12', index: 1, count: 3 }]);
});

test('parallel callback prints cannot prove the individual poll result order', () => {
  assert.deepEqual(polls('await Promise.all([12,13].map(async session_id=>text(await tools.write_stdin({session_id}))));'), []);
});

test('JSON serialization cannot change the inferred process ID', () => {
  assert.deepEqual(polls('const ids=JSON.stringify([12,13]);text(await tools.write_stdin({session_id:ids[1]}));'), []);
  assert.deepEqual(polls('const r=await tools.write_stdin({session_id:12});text(JSON.stringify(r));'),
    [{ name: 'write_stdin', target: '12', index: 1, count: 1 }]);
  assert.deepEqual(polls('const ids=JSON.stringify(12);text(await tools.write_stdin({session_id:ids}));'),
    [{ name: 'write_stdin', target: '12', index: 1, count: 1 }]);
});

test('unbounded, mutated, shadowed and nonliteral programs stay unverified', () => {
  const prefix = 'const r=await Promise.all([tools.write_stdin({session_id:12})]);';
  for (const suffix of [
    'for(let i=1;i<r.length;i++){text(r[i]);}',
    'for(let i=0;i<=r.length;i++){text(r[i]);}',
    'for(let i=0;i<r.length;i--){text(r[i]);}',
    'for(let i=0;i<r.length;i++){r[i].exit_code=0;text(r[i]);}',
    'for(let i=0;i<r.length;i++){text(r[i]);break;}',
    'text(r[0]);function text(x){}',
    'text(r[0]);const tools = {}',
    'text(r[0]);text(r[0]);',
    'text(r[0]);await mystery();',
  ]) assert.deepEqual(polls(prefix + suffix), [], suffix);
  assert.deepEqual(polls('const ids=await tools.ci({});for(const session_id of ids)text(await tools.write_stdin({session_id}));'), []);
});

test('computed non-child dispatch resolves only immutable literal tool names', () => {
  const { hasChildCall } = require('./code-mode-polls');
  assert.equal(hasChildCall('for(const n of ["mcp__castle__cw_get_active_alarms"]){const r=await tools[n]({});text(r);}'), false);
  assert.equal(hasChildCall('for(const [n,args] of [["mcp__castle__cw_get_active_alarms",{}]]){text(await tools[n](args));}'), false);
  assert.equal(hasChildCall('const tool=ALL_TOOLS.find(x=>x.name==="mcp__node_repl__js");const r=await tools[tool.name]({});text(r);'), false);
  for (const code of [
    'for(const n of ["spawn_agent"]){await tools[n]({});}',
    'for(const n of unknown){await tools[n]({});}',
    'for(const n of ["other"]){function f(n){tools[n]({});}}',
    'for(const n of ["other"]){try{}catch(n){tools[n]({});}}',
    'for(const n of ["other"]){const n=unknown;tools[n]({});}',
    'const tool=ALL_TOOLS.find(x=>x.name==="mcp__node_repl__js");tool.name=unknown;tools[tool.name]({});',
    'const tool=ALL_TOOLS.find(x=>x.name==="mcp__node_repl__js");mutate(tool);tools[tool.name]({});',
    'const tool=ALL_TOOLS.find(x=>x.name==="mcp__node_repl__js");ALL_TOOLS.find=unknown;tools[tool.name]({});',
  ]) assert.equal(hasChildCall(code), true, code);
  assert.equal(hasChildCall('tools['), true);
});

test('replay disproves obsolete dynamic-dispatch launch hints without dropping owned children', () => {
  const state = { restart: { completed: true, children: { child: 'owned' }, launches: { old: true }, mapped: {} } };
  require('./restart-evidence').consume(state, { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'old', name: 'exec',
    input: 'for(const n of ["mcp__castle__cw_get_active_alarms"]){await tools[n]({});}' } }, 'codex');
  assert.deepEqual(state.restart.launches, {});
  assert.deepEqual(state.restart.children, { child: 'owned' });
  require('./restart-evidence').consume(state, { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'new', name: 'exec', input: 'tools[unknown]({})' } }, 'codex');
  assert.equal(state.restart.launches.new, true);
});

test('only source-plus-harness agreement on parse failure disproves execution', () => {
  const { consume } = require('./restart-evidence');
  const error = [{ type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
    { type: 'input_text', text: 'Script error:\nSyntaxError: Unexpected token' }];
  for (const [code, output, remains] of [
    ['tools[', error, false],
    ['await tools.spawn_agent({});eval("(");', error, true],
    ['tools[', [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, error[1]], true],
  ]) {
    const state = {};
    consume(state, { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'test', input: code } }, 'codex');
    consume(state, { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'test', output } }, 'codex');
    assert.equal(Boolean(state.restart.launches.test), remains);
  }
  const patch = {};
  consume(patch, { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** End Patch' } }, 'codex');
  assert.deepEqual(patch.restart.launches, {});
});
