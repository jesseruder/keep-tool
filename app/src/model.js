import scopeRules from './scope-rules';

// All that survives the move to the WebView shell: the terminal viewer still names
// the project a pane belongs to. `scope-rules.js` is generated from the console's
// own copy by `npm run mobile:theme`.
export const PROJECTS = { keep: { name: 'Keep', h: 210 } };
const scopeSettings = scopeRules.defaults;

export function hashHue(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash) % 360;
}

export function projectFor(projectPath = '') {
  // Cards store projects as `~/castle/x` while sessions and panes use the absolute path;
  // both must resolve to the same PROJECTS entry or the terminal shows a raw folder name.
  const clean = String(projectPath || 'unknown').replace(/\/$/, '');
  const relative = clean.replace(/^\/Users\/[^/]+\/|^\/home\/[^/]+\/|^~\//, '');
  const worktree = relative.match(/^wt\/([^/]+)\/([^/]+)/);
  let key = relative;
  if (worktree) key = Object.keys(PROJECTS).find((candidate) => candidate.split('/').pop() === worktree[1]) || worktree[1];
  const known = PROJECTS[key];
  return {
    key,
    path: clean,
    name: known?.name || relative.split('/').filter(Boolean).pop() || 'Unknown',
    scope: scopeRules.scopeForProject(worktree && known ? '~/' + key : clean, scopeSettings, scopeSettings.home) || scopeSettings.default,
    h: known?.h ?? hashHue(clean),
    wt: worktree?.[2] || null,
  };
}
