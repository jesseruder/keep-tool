'use strict';

// Static policy for code that can execute on keep serve's event loop. This is not
// a JavaScript type checker: it deliberately handles the CommonJS forms used by
// Keep and reports the forms it cannot resolve so the guard stays auditable.

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const BUILTINS = new Map([
  ['fs', 'fs'], ['node:fs', 'fs'],
  ['child_process', 'child_process'], ['node:child_process', 'child_process'],
]);
const CHILD_SYNC = new Set(['execFileSync', 'execSync', 'spawnSync']);
// Inventory only: filenames grant no exemption. They are off-thread solely when
// reached through a Worker/process launch, which is not a CommonJS call edge.
const KNOWN_WORKER_CHILDREN = new Set([
  'bin/close-transcript-worker.js',
  'bin/dashboard-build-worker.js',
  'bin/fleet-usage-worker.js',
  'bin/session-text-search-worker.js',
  'bin/ui-request-worker-child.js',
  'bin/daemon-read-worker-child.js',
]);

const MAIN_SURFACES = ['bin/serve.js'];

function staticProperty(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  return null;
}

function literalString(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function isRequire(node) {
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier'
    && node.callee.name === 'require' && node.arguments.length === 1 && literalString(node.arguments[0]) !== null;
}

function childNodes(node) {
  const out = [];
  for (const [key, value] of Object.entries(node || {})) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'parentObject') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push(item);
    } else if (value && typeof value.type === 'string') out.push(value);
  }
  return out;
}

function resolveLocalFile(root, fromFile, request) {
  if (!request.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, `${base}.cjs`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.relative(root, candidate).split(path.sep).join('/');
    } catch {}
  }
  return null;
}

function parseModule(root, file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
  const module = { root, file, source, ast, functions: [], nodeFunction: new Map(), exports: new Map(), exportAll: null };
  let serial = 0;

  function labelFor(node, parent, key, owner) {
    if (node.id?.name) return node.id.name;
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
    if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && !parent.computed) {
      const prop = parent.key.name || parent.key.value || 'property';
      if (prop === 'handle' && parent.parentObject) {
        const route = parent.parentObject.properties?.find((p) => p.type === 'Property' && !p.computed && (p.key.name || p.key.value) === 'path');
        const method = parent.parentObject.properties?.find((p) => p.type === 'Property' && !p.computed && (p.key.name || p.key.value) === 'method');
        const routePath = literalString(route?.value);
        if (routePath) return `handle ${literalString(method?.value) || '*'} ${routePath}`;
      }
      return String(prop);
    }
    if (parent?.type === 'CallExpression') {
      const callee = parent.callee.type === 'Identifier' ? parent.callee.name : staticProperty(parent.callee) || 'call';
      return `${callee} callback`;
    }
    if (parent?.type === 'ReturnStatement') return 'returned callback';
    return `${key || 'anonymous'} callback`;
  }

  function visit(node, owner, parent = null, key = '') {
    if (!node) return;
    const isFunction = /Function(?:Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression';
    let nextOwner = owner;
    if (isFunction) {
      const base = labelFor(node, parent, key, owner);
      const siblings = module.functions.filter((fn) => fn.parent === owner && fn.base === base).length;
      const lexical = owner ? `${owner.lexical}>${base}${siblings ? `[${siblings + 1}]` : ''}` : base;
      nextOwner = { module, node, base, lexical, id: `${file}::${lexical}`, parent: owner, scope: null, calls: [], sinks: [] };
      module.functions.push(nextOwner);
      module.nodeFunction.set(node, nextOwner);
      if (owner) owner.calls.push({ kind: 'function', target: nextOwner, line: node.loc.start.line, nested: true });
    }
    if (node.type === 'ObjectExpression') for (const property of node.properties) property.parentObject = node;
    for (const [childKey, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'parentObject'].includes(childKey)) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, nextOwner, node, childKey);
      } else if (value && typeof value.type === 'string') {
        visit(value, nextOwner, node, childKey);
      }
    }
  }
  visit(ast, null);
  module.top = { module, node: ast, base: '(top level)', lexical: '(top level)', id: `${file}::(top level)`, parent: null, calls: [], sinks: [] };
  module.functions.unshift(module.top);
  module.nodeFunction.set(ast, module.top);
  module.serial = () => ++serial;
  return module;
}

function enclosingFunction(module, node) {
  let best = module.top;
  for (const fn of module.functions) {
    if (fn === module.top) continue;
    if (fn.node.start <= node.start && fn.node.end >= node.end
        && (best === module.top || fn.node.end - fn.node.start < best.node.end - best.node.start)) best = fn;
  }
  return best;
}

function buildScopes(module) {
  const moduleScope = { parent: null, bindings: new Map(), owner: module.top };
  module.top.scope = moduleScope;

  function bindPattern(pattern, value, scope) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, value);
    else if (pattern.type === 'AssignmentPattern') {
      // The daemon normally takes the default; tests may inject a replacement.
      // Treat the default as the production capability rather than letting an
      // injectable seam hide a synchronous operation.
      bindPattern(pattern.left, { type: 'expr-ref', expr: pattern.right, scope }, scope);
    }
    else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type !== 'Property') continue;
        const name = prop.computed ? literalString(prop.key) : prop.key.name || prop.key.value;
        bindPattern(prop.value, { type: 'member-ref', object: value, property: name }, scope);
      }
    }
  }

  function walk(node, scope, skipFunction = false) {
    let current = scope;
    const fn = module.nodeFunction.get(node);
    if (fn && fn !== module.top && !skipFunction) {
      current = { parent: scope, bindings: new Map(), owner: fn };
      fn.scope = current;
      if (node.type === 'FunctionDeclaration' && node.id) scope.bindings.set(node.id.name, { type: 'function-ref', fn });
      for (const param of node.params) bindPattern(param, { type: 'unknown-ref' }, current);
    }
    if (node.type === 'VariableDeclarator') bindPattern(node.id, { type: 'expr-ref', expr: node.init, scope: current }, current);
    if (node.type === 'ClassDeclaration' && node.id) current.bindings.set(node.id.name, { type: 'unknown-ref' });
    for (const child of childNodes(node)) walk(child, current);
  }
  walk(module.ast, moduleScope, true);
  // Function declarations were bound while entering them; named function
  // expressions also need their self-name inside their own scope.
  for (const fn of module.functions) if (fn.node.id?.name && fn.scope) fn.scope.bindings.set(fn.node.id.name, { type: 'function-ref', fn });
}

function assignmentExport(node) {
  if (node.type !== 'AssignmentExpression' || node.operator !== '=') return null;
  const left = node.left;
  if (left.type === 'MemberExpression' && !left.computed && left.object.type === 'Identifier'
      && left.object.name === 'module' && left.property.name === 'exports') return { all: true, expr: node.right };
  if (left.type !== 'MemberExpression') return null;
  const name = staticProperty(left);
  if (left.object.type === 'Identifier' && left.object.name === 'exports') return { name, expr: node.right };
  if (left.object.type === 'MemberExpression' && staticProperty(left.object) === 'exports'
      && left.object.object.type === 'Identifier' && left.object.object.name === 'module') return { name, expr: node.right };
  return null;
}

function indexExports(module) {
  function walk(node) {
    const hit = assignmentExport(node);
    if (hit) {
      if (hit.all && hit.expr.type === 'ObjectExpression') {
        for (const prop of hit.expr.properties) {
          if (prop.type !== 'Property') continue;
          const name = prop.computed ? literalString(prop.key) : prop.key.name || prop.key.value;
          if (name) module.exports.set(name, { expr: prop.value, scope: module.top.scope });
        }
      } else if (hit.all) module.exportAll = { expr: hit.expr, scope: module.top.scope };
      else if (hit.name) module.exports.set(hit.name, { expr: hit.expr, scope: module.top.scope });
    }
    for (const child of childNodes(node)) walk(child);
  }
  walk(module.ast);
}

function createAnalyzer(root) {
  const modules = new Map();
  const unresolved = [];

  function load(file) {
    file = file.split(path.sep).join('/');
    if (modules.has(file)) return modules.get(file);
    const module = parseModule(root, file);
    modules.set(file, module);
    buildScopes(module);
    indexExports(module);
    return module;
  }

  function binding(scope, name) {
    for (let here = scope; here; here = here.parent) if (here.bindings.has(name)) return here.bindings.get(name);
    return null;
  }

  function resolveRef(ref, module, seen = new Set()) {
    if (!ref || seen.has(ref)) return { type: 'unknown' };
    seen.add(ref);
    if (ref.type === 'function-ref') return { type: 'function', fn: ref.fn };
    if (ref.type === 'unknown-ref') return { type: 'unknown' };
    if (ref.type === 'expr-ref') return resolveExpr(ref.expr, module, ref.scope, seen);
    if (ref.type === 'member-ref') return memberOf(resolveRef(ref.object, module, seen), ref.property, seen);
    return ref;
  }

  function memberOf(object, property, seen) {
    if (!property) return { type: 'unknown' };
    if (object.type === 'builtin-module') {
      if (object.name === 'fs' && property.endsWith('Sync')) return { type: 'sink', operation: `fs.${property}` };
      if (object.name === 'child_process' && CHILD_SYNC.has(property)) return { type: 'sink', operation: `child_process.${property}` };
      return { type: 'unknown' };
    }
    if (object.type === 'atomics' && property === 'wait') return { type: 'sink', operation: 'Atomics.wait' };
    if (object.type === 'local-module') return resolveExport(object.module, property, seen);
    if (object.type === 'object') {
      const prop = object.node.properties.find((item) => item.type === 'Property'
        && (item.computed ? literalString(item.key) : item.key.name || item.key.value) === property);
      return prop ? resolveExpr(prop.value, object.module, object.scope, seen) : { type: 'unknown' };
    }
    return { type: 'unknown' };
  }

  function resolveExport(module, name, seen = new Set()) {
    const item = module.exports.get(name);
    if (item) return resolveExpr(item.expr, module, item.scope, seen);
    if (module.exportAll) {
      const all = resolveExpr(module.exportAll.expr, module, module.exportAll.scope, seen);
      if (all.type === 'local-module') return resolveExport(all.module, name, seen);
    }
    return { type: 'unknown' };
  }

  function resolveExpr(node, module, scope, seen = new Set()) {
    if (!node) return { type: 'unknown' };
    if (node.type === 'Identifier') {
      if (node.name === 'Atomics') return { type: 'atomics' };
      return resolveRef(binding(scope, node.name), module, seen);
    }
    if (isRequire(node)) {
      const request = literalString(node.arguments[0]);
      const builtin = BUILTINS.get(request);
      if (builtin) return { type: 'builtin-module', name: builtin };
      const file = resolveLocalFile(root, module.file, request);
      if (!file) return { type: 'unknown' };
      const local = load(file);
      return local ? { type: 'local-module', module: local } : { type: 'worker-module' };
    }
    if (node.type === 'MemberExpression') return memberOf(resolveExpr(node.object, module, scope, seen), staticProperty(node), seen);
    if (node.type === 'ObjectExpression') return { type: 'object', node, module, scope };
    if (node.type === 'LogicalExpression') {
      const left = resolveExpr(node.left, module, scope, seen);
      return left.type === 'unknown' ? resolveExpr(node.right, module, scope, seen) : left;
    }
    if (node.type === 'ConditionalExpression') {
      const yes = resolveExpr(node.consequent, module, scope, seen);
      const no = resolveExpr(node.alternate, module, scope, seen);
      return yes.type === 'unknown' ? no : yes;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && staticProperty(node.callee) === 'bind') {
      // `const read = fs.readFileSync.bind(fs)` preserves the blocking
      // capability even though the bind operation itself does not invoke it.
      return resolveExpr(node.callee.object, module, scope, seen);
    }
    if (/Function(?:Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression') {
      const fn = module.nodeFunction.get(node);
      return fn ? { type: 'function', fn } : { type: 'unknown' };
    }
    return { type: 'unknown' };
  }

  function analyzeModule(module) {
    if (module.analyzed) return;
    module.analyzed = true;
    function walk(node, scope) {
      let current = scope;
      const fnNode = module.nodeFunction.get(node);
      if (fnNode?.scope) current = fnNode.scope;
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const owner = enclosingFunction(module, node);
        const resolved = resolveExpr(node.callee, module, current);
        if (resolved.type === 'sink') owner.sinks.push({ operation: resolved.operation, line: node.loc.start.line });
        else if (resolved.type === 'function') owner.calls.push({ kind: 'function', target: resolved.fn, line: node.loc.start.line });
        else if (node.callee.type === 'MemberExpression' && staticProperty(node.callee) === null) {
          unresolved.push({ file: module.file, function: owner.lexical, line: node.loc.start.line, reason: 'computed call target' });
        }
        // A function passed to invoke/map/then is executable by that higher-order
        // call. Model the conservative edge even when parameter flow is opaque.
        for (const argument of node.arguments || []) {
          if (/FunctionExpression$/.test(argument.type) || argument.type === 'ArrowFunctionExpression') continue;
          const passed = resolveExpr(argument, module, current);
          if (passed.type === 'sink') owner.sinks.push({ operation: passed.operation, line: argument.loc.start.line, passed: true });
          else if (passed.type === 'function') owner.calls.push({ kind: 'function', target: passed.fn, line: argument.loc.start.line, passed: true });
        }
      }
      for (const child of childNodes(node)) walk(child, current);
    }
    walk(module.ast, module.top.scope);
    for (const fn of module.functions) {
      for (const call of fn.calls) if (call.target?.module) analyzeModule(call.target.module);
    }
  }

  function contextBindings() {
    const serve = load('bin/serve.js');
    let object = null;
    function find(node) {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'ctx'
          && node.init?.type === 'ObjectExpression') object = node.init;
      for (const child of childNodes(node)) find(child);
    }
    find(serve.ast);
    const refs = new Map();
    if (!object) return refs;
    const scope = enclosingFunction(serve, object).scope;
    for (const prop of object.properties) {
      if (prop.type !== 'Property' || prop.kind === 'get') continue;
      const name = prop.computed ? literalString(prop.key) : prop.key.name || prop.key.value;
      if (!name) continue;
      const resolved = resolveExpr(prop.value, serve, scope);
      if (resolved.type === 'function') refs.set(name, { type: 'function-ref', fn: resolved.fn });
      else if (resolved.type !== 'unknown') refs.set(name, resolved);
    }
    return refs;
  }

  function injectContext(module, functionName, refs) {
    const fn = module.functions.find((item) => item.base === functionName);
    if (!fn?.scope) return;
    for (const [name, ref] of refs) if (fn.scope.bindings.has(name)) fn.scope.bindings.set(name, ref);
  }

  function run(surfaceFiles = MAIN_SURFACES) {
    const roots = [];
    const defaultRun = surfaceFiles === MAIN_SURFACES;
    if (defaultRun) {
      const refs = contextBindings();
      injectContext(load('bin/serve/routes.js'), 'routes', refs);
      injectContext(load('bin/serve/schedulers.js'), 'startSchedulers', refs);
    }
    for (const file of surfaceFiles) {
      const module = load(file);
      if (defaultRun && file === 'bin/serve.js') {
        const start = module.functions.find((fn) => fn.base === 'start');
        if (!start) throw new Error('bin/serve.js has no start() entrypoint');
        roots.push(start);
      } else roots.push(...module.functions);
      analyzeModule(module);
    }
    const reachable = new Map();
    const queue = [...roots];
    while (queue.length) {
      const fn = queue.pop();
      if (reachable.has(fn.id)) continue;
      reachable.set(fn.id, fn);
      for (const call of fn.calls) if (call.target) queue.push(call.target);
    }
    const blocking = new Set([...reachable.values()].filter((fn) => fn.sinks.length).map((fn) => fn.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const fn of reachable.values()) {
        if (blocking.has(fn.id)) continue;
        if (fn.calls.some((call) => call.target && blocking.has(call.target.id))) {
          blocking.add(fn.id); changed = true;
        }
      }
    }
    const sinks = [];
    const edges = [];
    for (const fn of reachable.values()) {
      const grouped = new Map();
      for (const sink of fn.sinks) grouped.set(sink.operation, (grouped.get(sink.operation) || 0) + 1);
      for (const [operation, count] of grouped) sinks.push({ function: fn.id, operation, count });
      for (const call of fn.calls) {
        if (call.target && reachable.has(call.target.id) && blocking.has(call.target.id)) {
          edges.push({ caller: fn.id, callee: call.target.id });
        }
      }
    }
    const groupedEdges = new Map();
    for (const edge of edges) {
      const key = `${edge.caller} -> ${edge.callee}`;
      const current = groupedEdges.get(key) || { ...edge, count: 0 };
      current.count += 1;
      groupedEdges.set(key, current);
    }
    const predecessors = new Map();
    const pathQueue = [...roots];
    const seenPaths = new Set(roots.map((fn) => fn.id));
    while (pathQueue.length) {
      const fn = pathQueue.shift();
      for (const call of fn.calls) {
        if (!call.target || !reachable.has(call.target.id) || seenPaths.has(call.target.id)) continue;
        seenPaths.add(call.target.id);
        predecessors.set(call.target.id, fn.id);
        pathQueue.push(call.target);
      }
    }
    const sinkPaths = sinks.filter((sink) => sink.operation.startsWith('child_process.') || sink.operation === 'Atomics.wait')
      .map((sink) => {
        const chain = [sink.function];
        while (predecessors.has(chain[0])) chain.unshift(predecessors.get(chain[0]));
        return { operation: sink.operation, count: sink.count, path: chain };
      }).sort(compareRecord);
    const groupedUnresolved = new Map();
    for (const item of unresolved) {
      const key = `${item.file}|${item.function}|${item.reason}`;
      const current = groupedUnresolved.get(key) || { file: item.file, function: item.function, reason: item.reason, count: 0 };
      current.count += 1;
      groupedUnresolved.set(key, current);
    }
    return {
      sinks: sinks.sort(compareRecord),
      edges: [...groupedEdges.values()].sort(compareRecord),
      sinkPaths,
      reachable: [...reachable.keys()].sort(),
      knownWorkerChildren: [...KNOWN_WORKER_CHILDREN].sort(),
      unresolved: [...groupedUnresolved.values()].sort(compareRecord),
    };
  }
  return { run };
}

function compareRecord(a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); }
function keySink(item) { return `${item.function}|${item.operation}|${item.count}`; }
function keyEdge(item) { return `${item.caller}|${item.callee}|${item.count}`; }
function keyUnresolved(item) { return `${item.file}|${item.function}|${item.reason}|${item.count}`; }

function comparePolicy(analysis, manifest) {
  const problems = [];
  const actualSinks = new Map(analysis.sinks.map((item) => [keySink(item), item]));
  const allowedSinks = new Map((manifest.sinks || []).map((item) => [keySink(item), item]));
  for (const [key, item] of actualSinks) if (!allowedSinks.has(key)) problems.push(`new direct sink: ${item.function} calls ${item.operation} ${item.count} time(s)`);
  for (const [key, item] of allowedSinks) {
    if (!item.reason || item.reason.trim().length < 12) problems.push(`debt entry lacks a useful reason: ${item.function} ${item.operation}`);
    if (!actualSinks.has(key)) problems.push(`stale direct-sink debt: ${item.function} ${item.operation} x${item.count}`);
  }
  const actualEdges = new Map(analysis.edges.map((item) => [keyEdge(item), item]));
  const allowedEdges = new Set(manifest.edges || []);
  for (const [key] of actualEdges) if (!allowedEdges.has(key)) problems.push(`new blocking call edge: ${key}`);
  for (const key of allowedEdges) if (!actualEdges.has(key)) problems.push(`stale blocking-edge debt: ${key}`);
  const actualUnresolved = new Map(analysis.unresolved.map((item) => [keyUnresolved(item), item]));
  const allowedUnresolved = new Map((manifest.unresolved || []).map((item) => [keyUnresolved(item), item]));
  for (const [key, item] of actualUnresolved) if (!allowedUnresolved.has(key)) {
    problems.push(`new unresolved call: ${item.file} ${item.function} (${item.reason}); use a static property or add a narrow debt entry`);
  }
  for (const [key, item] of allowedUnresolved) {
    if (!item.reasonWhy || item.reasonWhy.trim().length < 12) problems.push(`unresolved-call debt lacks a useful reason: ${key}`);
    if (!actualUnresolved.has(key)) problems.push(`stale unresolved-call debt: ${key}`);
  }
  return problems.sort();
}

function defaultReason(sink) {
  const [file, lexical] = sink.function.split('::');
  if (sink.operation.startsWith('child_process.')) {
    return `Conservative subprocess debt: the static daemon graph reaches ${file} ${lexical}; this exact synchronous invocation count is frozen. Verify production injection before classifying the branch as runtime work.`;
  }
  if (sink.operation === 'Atomics.wait') {
    return `Conservative lock/backoff debt: the static daemon graph reaches ${file} ${lexical}; this exact wait count is frozen. If selected in production it parks the daemon thread.`;
  }
  if (/\.(?:write|append|rename|unlink|rm|mkdir|truncate|chmod|close)/.test(sink.operation)) {
    return `Conservative state-mutation debt: the static daemon graph reaches ${file} ${lexical}; this exact synchronous filesystem mutation count is frozen, including fallback branches.`;
  }
  if (/\.(?:stat|lstat|fstat|exists|realpath|access)/.test(sink.operation)) {
    return `Conservative metadata debt: the static daemon graph reaches ${file} ${lexical}; this exact synchronous lookup count is frozen rather than treated as safe, even when production injects another implementation.`;
  }
  return `Conservative read/scan debt: the static daemon graph reaches ${file} ${lexical}; this exact synchronous operation count is frozen, including test or CLI fallback branches.`;
}

function manifestFrom(analysis) {
  return {
    version: 1,
    note: 'Conservative branch-insensitive daemon graph. Exact sinks and blocking edges are ratcheted; test/CLI fallbacks may be listed even when production injects a worker. This is not a claim that every entry executes on the production daemon or that the daemon is nonblocking.',
    sinks: analysis.sinks.map((sink) => ({ ...sink, reason: defaultReason(sink) })),
    edges: analysis.edges.map(keyEdge),
    unresolved: analysis.unresolved.map((item) => ({ ...item,
      reasonWhy: `Legacy computed dispatch in ${item.file} ${item.function}; exact site is ratcheted because static call resolution cannot prove its target.` })),
  };
}

module.exports = {
  MAIN_SURFACES, KNOWN_WORKER_CHILDREN, createAnalyzer, comparePolicy, manifestFrom,
};
