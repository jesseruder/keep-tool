'use strict';

// A bounded symbolic interpreter, never eval. It maps printed result slots for
// literal loops and Promise.all. Unsupported control flow/mutation fails closed.
function polls(code) {
  if (typeof code !== 'string' || code.length > 2 * 1024 * 1024) return [];
  const TOOL = Symbol('tool'), UNKNOWN = Symbol('unknown');
  let fuel = 2048;
  const outputs = [], printed = new Set();
  const fail = () => { throw Error('unverified code-mode output'); };
  const reserved = new Set(['tools', 'text', 'JSON', 'Promise']);
  const bind = (pattern, value, env) => {
    if (pattern?.type === 'Identifier' && !reserved.has(pattern.name)) { env.set(pattern.name, value); return; }
    if (pattern?.type === 'ArrayPattern' && Array.isArray(value) && pattern.elements.length === value.length) {
      pattern.elements.forEach((p, i) => bind(p, value[i], env)); return;
    }
    fail();
  };
  const member = (n, object, property) => n?.type === 'MemberExpression' && !n.computed && !n.optional
    && n.object.type === 'Identifier' && n.object.name === object && n.property.name === property;
  const result = (name, input) => {
    const target = name === 'write_stdin' ? input?.session_id : name === 'wait' ? input?.cell_id : null;
    return { [TOOL]: true, poll: target != null && /^[\w-]{1,160}$/.test(String(target)) ? { name, target: String(target) } : null };
  };
  const plain = value => value == null || ['string', 'number', 'boolean'].includes(typeof value)
    || (typeof value === 'object' && !Object.getOwnPropertySymbols(value).length && Object.values(value).every(plain));
  const expr = (n, env, awaited = false) => {
    if (!n || --fuel < 0) fail();
    if (n.type === 'Literal' && !n.regex && !n.bigint) return n.value;
    if (n.type === 'Identifier' && env.has(n.name)) return env.get(n.name);
    if (n.type === 'ArrayExpression') {
      if (n.elements.length > 64) fail();
      return n.elements.map(e => expr(e, env));
    }
    if (n.type === 'TemplateLiteral') {
      const values = n.expressions.map(e => expr(e, env));
      if (values.some(v => !['string', 'number', 'boolean'].includes(typeof v))) fail();
      return n.quasis.map((q, i) => q.value.cooked + (i < values.length ? String(values[i]) : '')).join('');
    }
    if (n.type === 'BinaryExpression' && n.operator === '+') {
      const a = expr(n.left, env), b = expr(n.right, env);
      if (!['string', 'number'].includes(typeof a) || !['string', 'number'].includes(typeof b)) fail();
      return a + b;
    }
    if (n.type === 'UnaryExpression' && n.operator === '-') {
      const value = expr(n.argument, env); if (typeof value !== 'number') fail(); return -value;
    }
    if (n.type === 'ObjectExpression') {
      const value = Object.create(null);
      for (const p of n.properties) {
        if (p.type === 'SpreadElement') {
          const spread = expr(p.argument, env);
          // Transformed tool results occupy a slot but never prove completion.
          if (spread?.[TOOL]) value[UNKNOWN] = true;
          else if (spread && typeof spread === 'object') Object.assign(value, spread);
          else fail();
        } else {
          if (p.type !== 'Property' || p.computed || p.method || p.kind !== 'init') fail();
          value[p.key.name ?? p.key.value] = expr(p.value, env);
        }
      }
      return value;
    }
    if (n.type === 'AwaitExpression') return expr(n.argument, env, true);
    if (n.type === 'LogicalExpression' && n.operator === '??' && n.right.type === 'Identifier'
        && member(n.left, n.right.name, 'structuredContent')) {
      const value = expr(n.right, env);
      if (!value?.[TOOL] || value.poll) fail(); return UNKNOWN;
    }
    if (n.type === 'MemberExpression' && !n.optional) {
      const array = expr(n.object, env);
      if (!Array.isArray(array)) fail();
      if (!n.computed && n.property.name === 'length') return array.length;
      const i = n.computed ? expr(n.property, env) : null;
      if (!Number.isInteger(i) || i < 0 || i >= array.length) fail(); return array[i];
    }
    if (n.type !== 'CallExpression' || n.optional || n.arguments.some(a => a.type === 'SpreadElement')) fail();
    if (n.callee.type === 'Identifier' && n.callee.name === 'text' && n.arguments.length === 1 && !awaited) {
      const arg = n.arguments[0];
      const serialized = arg.type === 'CallExpression' && !arg.optional && arg.arguments.length === 1 && member(arg.callee, 'JSON', 'stringify');
      // Identity is safe only for the direct serialization of a whole tool
      // result being printed, never for values later used as IDs or arrays.
      const inner = serialized ? expr(arg.arguments[0], env) : null;
      const value = serialized ? inner?.[TOOL] ? inner : plain(inner) ? JSON.stringify(inner) : fail() : expr(arg, env);
      if (value?.[TOOL]) { if (printed.has(value)) fail(); printed.add(value); }
      outputs.push(value?.[TOOL] ? value.poll : null); return UNKNOWN;
    }
    if (member(n.callee, 'JSON', 'stringify') && n.arguments.length === 1 && !awaited) {
      const value = expr(n.arguments[0], env); if (!plain(value)) fail(); return JSON.stringify(value);
    }
    if (n.callee.type === 'MemberExpression' && !n.callee.computed && !n.callee.optional
        && n.callee.object.type === 'Identifier' && n.callee.object.name === 'tools' && n.arguments.length === 1 && awaited) {
      const before = outputs.length, input = expr(n.arguments[0], env);
      if (outputs.length !== before || !plain(input)) fail();
      return result(n.callee.property.name, input);
    }
    if (member(n.callee, 'Promise', 'all') && n.arguments.length === 1 && awaited) {
      const input = n.arguments[0];
      if (input.type === 'ArrayExpression' && input.elements.length <= 64) return input.elements.map(e => expr(e, env, true));
      if (input.type !== 'CallExpression' || input.optional || input.arguments.length !== 1
          || input.callee.type !== 'MemberExpression' || input.callee.computed || input.callee.optional || input.callee.property.name !== 'map') fail();
      const values = expr(input.callee.object, env), fn = input.arguments[0];
      if (!Array.isArray(values) || values.length > 64 || fn.type !== 'ArrowFunctionExpression' || !fn.async || fn.params.length !== 1) fail();
      const start = outputs.length, mapped = values.map(value => {
        const scope = new Map(env); bind(fn.params[0], value, scope);
        if (fn.body.type === 'BlockStatement') { statements(fn.body.body, scope); return UNKNOWN; }
        return expr(fn.body, scope);
      });
      // These prints race; their total count is known, their ordering is not.
      outputs.fill(null, start);
      return mapped;
    }
    fail();
  };
  const statements = (body, env) => {
    for (const n of body) {
      if (--fuel < 0) fail();
      if (n.type === 'VariableDeclaration' && n.kind === 'const') {
        for (const d of n.declarations) bind(d.id, expr(d.init, env), env);
      } else if (n.type === 'ExpressionStatement') expr(n.expression, env);
      else if (n.type === 'BlockStatement') statements(n.body, new Map(env));
      else if (n.type === 'ForOfStatement' && !n.await && n.left.type === 'VariableDeclaration'
          && n.left.kind === 'const' && n.left.declarations.length === 1 && !n.left.declarations[0].init) {
        const values = expr(n.right, env);
        if (!Array.isArray(values) || values.length > 64) fail();
        for (const value of values) { const scope = new Map(env); bind(n.left.declarations[0].id, value, scope); statements([n.body], scope); }
      } else if (n.type === 'ForStatement') {
        const d = n.init?.type === 'VariableDeclaration' && n.init.kind === 'let' && n.init.declarations.length === 1 ? n.init.declarations[0] : null;
        if (d?.id.type !== 'Identifier' || reserved.has(d.id.name) || d.init?.type !== 'Literal' || d.init.value !== 0
            || n.test?.type !== 'BinaryExpression' || n.test.operator !== '<' || n.test.left.type !== 'Identifier' || n.test.left.name !== d.id.name
            || n.test.right.type !== 'MemberExpression' || n.test.right.computed || n.test.right.optional || n.test.right.property.name !== 'length'
            || n.update?.type !== 'UpdateExpression' || n.update.operator !== '++' || n.update.argument.type !== 'Identifier' || n.update.argument.name !== d.id.name) fail();
        const count = expr(n.test.right, env); if (!Number.isInteger(count) || count < 0 || count > 64) fail();
        for (let i = 0; i < count; i++) { const scope = new Map(env); bind(d.id, i, scope); statements([n.body], scope); }
      } else fail();
    }
  };
  try {
    const body = require('acorn').parse(code, { ecmaVersion: 'latest', sourceType: 'module' }).body;
    if (body.length > 64) return [];
    statements(body, new Map());
    if (outputs.length > 256) return [];
    return outputs.flatMap((poll, i) => poll ? [{ ...poll, index: i + 1, count: outputs.length }] : []);
  } catch { return []; }
}
module.exports = { polls };
