// Shared by the CLI and console: configuration determines scope, never a user's name.
(function (root) {
  'use strict';
  const defaults = { names: ['work', 'personal'], default: 'personal', rules: [{ path: '~/work', scope: 'work' }] };
  function validate(value = defaults) {
    if (!value || !Array.isArray(value.names) || !value.names.length
      || value.names.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name))
      || new Set(value.names).size !== value.names.length || !value.names.includes(value.default)
      || !Array.isArray(value.rules)) throw new Error('invalid Keep scope configuration');
    for (const rule of value.rules) {
      if (!rule || typeof rule.path !== 'string' || !/^(~\/|\/)/.test(rule.path)
        || !value.names.includes(rule.scope) || (rule.excludeSegmentPrefix !== undefined
          && (typeof rule.excludeSegmentPrefix !== 'string' || !rule.excludeSegmentPrefix || rule.excludeSegmentPrefix.includes('/')))) {
        throw new Error('invalid Keep scope rule');
      }
    }
    return value;
  }
  function normalize(value, home) {
    const expanded = String(value).replace(/^~(?=\/|$)/, home || '~');
    const parts = [];
    for (const part of expanded.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (parts.length && parts.at(-1) !== '~') parts.pop(); }
      else parts.push(part);
    }
    return (expanded.startsWith('/') ? '/' : '') + parts.join('/');
  }
  function scopeForProject(project, settings = defaults, home = '') {
    if (!project || !/^(~(?:\/|$)|\/)/.test(String(project))) return null;
    const resolved = normalize(project, home);
    for (const rule of settings.rules) {
      const prefix = normalize(rule.path, home);
      if (resolved !== prefix && !resolved.startsWith(prefix === '/' ? '/' : prefix + '/')) continue;
      const segments = resolved.slice(prefix.length).split('/').filter(Boolean);
      if (rule.excludeSegmentPrefix && segments.some((part) => part.startsWith(rule.excludeSegmentPrefix))) continue;
      return rule.scope;
    }
    return settings.default;
  }
  const api = { defaults, validate, scopeForProject };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeepScopeRules = api;
})(globalThis);
