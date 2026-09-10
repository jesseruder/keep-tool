'use strict';

// Parse, never execute. Only straight-line tool calls and unmodified result
// prints have a provable one-to-one mapping to printed result blocks.
function literal(node) {
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
  if (node?.type === 'ArrayExpression') return node.elements.map(literal);
  if (node?.type === 'ObjectExpression') {
    const value = Object.create(null);
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.computed || p.method || p.shorthand || p.kind !== 'init') throw Error('not literal');
      value[p.key.name ?? p.key.value] = literal(p.value);
    }
    return value;
  }
  throw Error('not literal');
}

function simplePolls(code) {
  if (typeof code !== 'string' || code.length > 2 * 1024 * 1024) return [];
  try {
    const body = require('acorn').parse(code, { ecmaVersion: 'latest', sourceType: 'module' }).body;
    if (body.length > 64) return [];
    const result = [], bindings = new Map();
    let outputs = 0;
    const tool = (awaited) => {
      const call = awaited?.argument;
      if (awaited?.type !== 'AwaitExpression' || call?.type !== 'CallExpression' || call.optional
          || call.callee.type !== 'MemberExpression' || call.callee.computed || call.callee.optional
          || call.callee.object.type !== 'Identifier' || call.callee.object.name !== 'tools' || call.arguments.length !== 1) throw Error('not a tool call');
      const input = literal(call.arguments[0]), name = call.callee.property.name;
      const target = name === 'write_stdin' ? input?.session_id : name === 'wait' ? input?.cell_id : null;
      return target != null && /^[\w-]{1,160}$/.test(String(target)) ? { name, target: String(target) } : null;
    };
    // Promise.all preserves input order. Accept only an exact, unmodified
    // for-of print of its results; arbitrary loops/labels stay unverified.
    if (body.length === 2 && body[0].type === 'VariableDeclaration' && body[0].kind === 'const'
        && body[0].declarations.length === 1 && body[1].type === 'ForOfStatement' && !body[1].await) {
      const d = body[0].declarations[0], all = d.init?.argument, loop = body[1];
      const variable = loop.left.type === 'VariableDeclaration' && loop.left.kind === 'const' && loop.left.declarations.length === 1
        ? loop.left.declarations[0] : null;
      const statement = loop.body.type === 'BlockStatement' && loop.body.body.length === 1 ? loop.body.body[0] : loop.body;
      const print = statement.expression;
      if (d.id.type !== 'Identifier' || ['tools', 'text', 'Promise'].includes(d.id.name)
          || d.init?.type !== 'AwaitExpression' || all?.type !== 'CallExpression' || all.optional
          || all.callee.type !== 'MemberExpression' || all.callee.computed || all.callee.optional
          || all.callee.object.name !== 'Promise' || all.callee.property.name !== 'all'
          || all.arguments.length !== 1 || all.arguments[0].type !== 'ArrayExpression' || all.arguments[0].elements.length > 64
          || loop.right.type !== 'Identifier' || loop.right.name !== d.id.name || variable?.id.type !== 'Identifier' || variable.init
          || ['tools', 'text', 'Promise'].includes(variable.id.name)
          || statement.type !== 'ExpressionStatement' || print?.type !== 'CallExpression' || print.optional
          || print.callee.name !== 'text' || print.arguments.length !== 1 || print.arguments[0].type !== 'Identifier'
          || print.arguments[0].name !== variable.id.name) return [];
      const elements = all.arguments[0].elements;
      return elements.flatMap((argument, index) => {
        const poll = tool({ type: 'AwaitExpression', argument });
        return poll ? [{ index: index + 1, ...poll, count: elements.length }] : [];
      });
    }
    for (const statement of body) {
      if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length === 1) {
        const d = statement.declarations[0];
        if (d.id.type !== 'Identifier' || ['text', 'tools', 'JSON'].includes(d.id.name) || bindings.has(d.id.name)) return [];
        bindings.set(d.id.name, { poll: tool(d.init), printed: false });
        continue;
      }
      const print = statement.expression, value = print?.arguments?.[0];
      if (statement.type !== 'ExpressionStatement' || print?.type !== 'CallExpression' || print.optional
          || print.callee.type !== 'Identifier' || print.callee.name !== 'text' || print.arguments.length !== 1
          ) return [];
      let poll;
      if (value?.type === 'AwaitExpression') poll = tool(value);
      else {
        // Common connector print: const r = await tools.foo({...}); text(r.structuredContent ?? r).
        // Transformed connector output occupies one slot but cannot prove a poll.
        const fallback = value?.type === 'LogicalExpression' && value.operator === '??'
          && value.left.type === 'MemberExpression' && !value.left.computed && !value.left.optional
          && value.left.object.type === 'Identifier' && value.left.property.name === 'structuredContent'
          && value.right.type === 'Identifier' && value.right.name === value.left.object.name;
        const stringify = value?.type === 'CallExpression' && !value.optional && value.arguments.length === 1
          && value.callee.type === 'MemberExpression' && !value.callee.computed && !value.callee.optional
          && value.callee.object.name === 'JSON' && value.callee.property.name === 'stringify'
          && value.arguments[0].type === 'Identifier';
        const name = value?.type === 'Identifier' ? value.name : fallback ? value.right.name : stringify ? value.arguments[0].name : null;
        const binding = bindings.get(name);
        if (!binding || binding.printed || (fallback && binding.poll)) return [];
        binding.printed = true; poll = binding.poll;
      }
      outputs++;
      if (poll) result.push({ index: outputs, ...poll });
    }
    return result.map(poll => ({ ...poll, count: outputs }));
  } catch { return []; }
}

function hasChildCall(code) {
  if (typeof code !== 'string') return false;
  const names = /(?:^|[._])(?:spawn_agent|spawn_agents|followup_task|send_input)$/;
  try {
    if (code.length > 2 * 1024 * 1024) throw Error('oversized code');
    const ast = require('acorn').parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    const pending = [{ node: ast, ancestors: [] }];
    while (pending.length) {
      const { node, ancestors } = pending.pop();
      // Include references/aliases and unreachable branches conservatively.
      if (node.type === 'Identifier' && names.test(node.name)) return true;
      if (node.type === 'Literal' && typeof node.value === 'string' && names.test(node.value)) return true;
      if (node.type === 'MemberExpression' && node.object.name === 'tools' && node.computed && node.property.type !== 'Literal') {
        const known = require('./static-tool-names').resolve(node.property, ancestors, ast);
        if (!known || known.some(name => names.test(name))) return true;
      }
      if (node.type === 'MemberExpression' && names.test(node.computed ? node.property.value : node.property.name)) return true;
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.test(node.callee.name)) return true;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) pending.push(...value.filter(v => v && typeof v.type === 'string').map(child => ({ node: child, ancestors: [...ancestors, node] })));
        else if (value && typeof value.type === 'string') pending.push({ node: value, ancestors: [...ancestors, node] });
      }
    }
    return false;
  } catch { return true; } // Unparseable/oversized dispatch cannot disprove a launch.
}

function polls(code) {
  const simple = simplePolls(code);
  return simple.length ? simple : require('./code-mode-output').polls(code);
}
function syntaxInvalid(code) {
  if (typeof code !== 'string' || code.length > 2 * 1024 * 1024) return false;
  try { require('acorn').parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); return false; }
  catch (error) { return error instanceof SyntaxError; }
}
module.exports = { polls, hasChildCall, syntaxInvalid };
