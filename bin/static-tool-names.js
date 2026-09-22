'use strict';

// Resolve only immutable literal tool-name bindings. Unknown computed dispatch
// stays a possible child launch. This never evaluates code or invokes tools.
function resolve(property, ancestors, ast) {
  const nodes = [];
  const walk = (node, parent = null) => {
    if (!node || typeof node.type !== 'string') return;
    nodes.push({ node, parent });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, node));
      else if (value && typeof value.type === 'string') walk(value, node);
    }
  };
  walk(ast);
  const contains = (node, name) => node?.type === 'Identifier' ? node.name === name
    : node?.type === 'ArrayPattern' ? node.elements.some(p => contains(p, name))
    : node?.type === 'ObjectPattern' ? node.properties.some(p => contains(p.value || p.argument, name))
    : node?.type === 'AssignmentPattern' ? contains(node.left, name) : node?.type === 'RestElement' ? contains(node.argument, name) : false;
  const unique = name => nodes.filter(({ node }) => (node.type === 'VariableDeclarator' && contains(node.id, name))
    || (/Function/.test(node.type) && (contains(node.id, name) || node.params?.some(p => contains(p, name))))
    || (/^Class/.test(node.type) && contains(node.id, name)) || (node.type === 'CatchClause' && contains(node.param, name))
    || (/^Import.*Specifier$/.test(node.type) && contains(node.local, name))).length === 1;
  if (property.type === 'Identifier' && unique(property.name)) {
    for (const loop of ancestors.slice().reverse()) {
      if (loop.type !== 'ForOfStatement' || loop.left.type !== 'VariableDeclaration' || loop.left.kind !== 'const'
          || loop.left.declarations.length !== 1 || loop.right.type !== 'ArrayExpression') continue;
      const pattern = loop.left.declarations[0].id;
      let values;
      if (pattern.type === 'Identifier' && pattern.name === property.name) values = loop.right.elements;
      else if (pattern.type === 'ArrayPattern') {
        const index = pattern.elements.findIndex(p => p?.type === 'Identifier' && p.name === property.name);
        if (index >= 0) values = loop.right.elements.map(row => row?.type === 'ArrayExpression' ? row.elements[index] : null);
      }
      if (values?.length && values.every(v => v?.type === 'Literal' && typeof v.value === 'string')) return values.map(v => v.value);
    }
  }
  if (property.type !== 'MemberExpression' || property.computed || property.optional || property.property.name !== 'name'
      || property.object.type !== 'Identifier' || !unique(property.object.name)) return null;
  const name = property.object.name;
  const declaration = ast.body.find(n => n.type === 'VariableDeclaration' && n.kind === 'const' && n.declarations.length === 1 && n.declarations[0].id.name === name);
  const d = declaration?.declarations[0], call = d?.init, fn = call?.arguments?.[0];
  const nameOf = node => node?.type === 'MemberExpression' && !node.computed && !node.optional
    && node.object.name === fn.params[0].name && node.property.name === 'name';
  if (call?.type !== 'CallExpression' || call.optional || call.arguments.length !== 1
      || call.callee.type !== 'MemberExpression' || call.callee.computed || call.callee.optional
      || call.callee.object.name !== 'ALL_TOOLS' || call.callee.property.name !== 'find'
      || fn?.type !== 'ArrowFunctionExpression' || fn.async || fn.params.length !== 1 || fn.params[0].type !== 'Identifier') return null;
  const body = fn.body;
  let result;
  if (body.type === 'BinaryExpression' && body.operator === '===' && nameOf(body.left)
      && body.right.type === 'Literal' && typeof body.right.value === 'string') result = [body.right.value];
  // `/…literal$/.test(x.name)`: whatever the inventory holds, the match ends in that literal.
  else if (body.type === 'CallExpression' && !body.optional && body.arguments.length === 1 && nameOf(body.arguments[0])
      && body.callee.type === 'MemberExpression' && !body.callee.computed && !body.callee.optional
      && body.callee.property.name === 'test' && body.callee.object.type === 'Literal' && body.callee.object.regex) {
    const suffix = anchoredSuffix(body.callee.object.regex);
    if (!suffix) return null;
    result = { suffix };
  } else return null;
  // Metadata never escapes or mutates, and the tool inventory isn't shadowed.
  for (const { node, parent } of nodes) {
    if (node.type === 'Identifier' && node.name === 'ALL_TOOLS' && node !== call.callee.object) return null;
    if (node.type === 'Identifier' && node.name === name && node !== d.id
        && !(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && !parent.optional && parent.property.name === 'name')) return null;
    if (['AssignmentExpression', 'UpdateExpression', 'UnaryExpression'].includes(node.type)) {
      const target = node.left || node.argument;
      if (target?.type === 'MemberExpression' && target.object.name === name) return null;
    }
    // A regex match is only as fixed as RegExp itself.
    if (!Array.isArray(result) && ((node.type === 'Identifier' && REFLECTIVE.has(node.name))
        || (node.type === 'MemberExpression' && (node.computed ? !(node.object.name === 'tools'
          || (node.property.type === 'Literal' && typeof node.property.value === 'number'))
          : REFLECTIVE.has(node.property.name))))) return null;
  }
  return result;
}

const REFLECTIVE = new Set(['RegExp', 'Reflect', 'Symbol', 'Object', 'Proxy', 'globalThis', 'eval', 'Function',
  'prototype', '__proto__', 'constructor', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'exec', 'lastIndex']);

// The literal every match of a `$`-anchored pattern must end with, or null when
// that is not certain (alternation, flags other than `i`, a class or group or
// quantifier at the tail). Lowercased under `i` so callers compare lowercase.
function anchoredSuffix({ pattern, flags }) {
  if (!/^i?$/.test(flags) || pattern.includes('|')) return null;
  let tail = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[++i];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) tail = ''; // \d, \b, \1, \c… are not literals
      else tail += next;
    } else if (c === '$' && i === pattern.length - 1) return tail ? (flags ? tail.toLowerCase() : tail) : null;
    else if (/[A-Za-z0-9_\-]/.test(c)) tail += c;
    else {
      if (c === '[') { // skip the class; its members are not a fixed tail
        for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++;
      }
      // A quantifier binds to the atom before it, so that atom leaves the tail too.
      tail = '';
    }
  }
  return null;
}
module.exports = { resolve, anchoredSuffix };
