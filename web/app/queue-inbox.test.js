import test from 'node:test';
import assert from 'node:assert/strict';

// queue-inbox.js imports api.js transitively, which reads `location` inside its
// request helpers; nothing here calls one, but the import must not throw.
globalThis.location = new URL('http://localhost:7777/app/');

const card = (id, status, project, updated) => ({ id, fm: { status, project, updated } });

// The rail no longer lists a project whose only open work is an inbox card, so
// the Inbox's own filtering is pinned here rather than by the browser test that
// used to reach it through a rail button.
test('the project filter narrows the Inbox, and the client filter leaves cards alone', async () => {
  const { inboxCards } = await import('./queue-inbox.js');
  const ctx = {
    state: { filter: null, providerFilter: 'codex' },
    projectOf: (path) => ({ key: path, path }),
    data: {
      tasks: [
        card('alpha-new', 'inbox', '/work/a', '2026-09-20T10:00'),
        card('alpha-old', 'inbox', '/work/a', '2026-09-01T09:00'),
        card('beta', 'inbox', '/work/b', '2026-09-19T10:00'),
        card('started', 'active', '/work/b', '2026-09-21T08:00'),
      ],
    },
  };
  assert.deepEqual(inboxCards(ctx).map((task) => task.id), ['alpha-new', 'beta', 'alpha-old'],
    'every open card, newest first, whatever client is selected');
  ctx.state.filter = '/work/b';
  assert.deepEqual(inboxCards(ctx).map((task) => task.id), ['beta']);
  ctx.state.filter = '/work/c';
  assert.deepEqual(inboxCards(ctx).map((task) => task.id), []);
});
