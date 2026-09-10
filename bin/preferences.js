'use strict';
const os = require('node:os');
const rules = require('../web/app/shared/scope-rules');
function scopes() {
  return rules.validate(process.env.KEEP_SCOPES ? JSON.parse(process.env.KEEP_SCOPES) : rules.defaults);
}
function scopeForProject(project) { return rules.scopeForProject(project, scopes(), os.homedir()); }
function modelBudgets(env = process.env) {
  const defaults = { fable: { inputPrice: 15 }, opus: { inputPrice: 15 }, sonnet: { inputPrice: 3 }, haiku: { inputPrice: 1 } };
  const overrides = env.KEEP_MODEL_BUDGETS ? JSON.parse(env.KEEP_MODEL_BUDGETS) : {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('invalid KEEP_MODEL_BUDGETS');
  for (const [family, entry] of Object.entries(overrides)) {
    if (!/^[a-z][a-z0-9-]*$/.test(family) || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !['inputPrice', 'minHeadroom', 'weeklyLabel'].includes(key))
      || (entry.inputPrice !== undefined && (!Number.isFinite(entry.inputPrice) || entry.inputPrice <= 0))
      || (entry.minHeadroom !== undefined && (!Number.isFinite(entry.minHeadroom) || entry.minHeadroom < 0 || entry.minHeadroom > 100))
      || (entry.weeklyLabel !== undefined && (typeof entry.weeklyLabel !== 'string' || !entry.weeklyLabel.trim()))) {
      throw new Error('invalid model budget for ' + family);
    }
    defaults[family] = { inputPrice: 3, ...defaults[family], ...entry };
  }
  return defaults;
}
function projectCatalog() {
  const value = process.env.KEEP_PROJECT_CATALOG ? JSON.parse(process.env.KEEP_PROJECT_CATALOG) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid project catalog');
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry.name !== 'string' || (entry.icon !== undefined && typeof entry.icon !== 'string')
      || (entry.h !== undefined && !Number.isFinite(entry.h))) throw new Error('invalid project catalog entry');
  }
  return value;
}
module.exports = { scopes, scopeForProject, modelBudgets, projectCatalog };
