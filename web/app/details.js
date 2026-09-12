export function createDetailStore(load, onChange = () => {}) {
  const entries = new Map();
  let serial = 0;
  const keyFor = (kind, id) => `${kind}:${id}`;

  function peek(kind, id, version) {
    const entry = entries.get(keyFor(kind, id));
    if (!entry || entry.expectedVersion !== version) return { status: 'idle', value: null, error: '' };
    return entry;
  }

  function ensure(kind, id, expectedVersion) {
    const key = keyFor(kind, id);
    const current = entries.get(key);
    if (current?.expectedVersion === expectedVersion && ['loading', 'ready', 'error'].includes(current.status)) return current.promise;
    const token = ++serial;
    const entry = { status: 'loading', value: null, error: '', expectedVersion, token, promise: null };
    entry.promise = Promise.resolve().then(() => load(kind, id)).then((result) => {
      if (entries.get(key)?.token !== token) return null;
      if (result?.version && result.version !== expectedVersion) {
        entries.set(key, {
          status: 'error', value: null, error: 'Details changed while loading. Refresh and try again.',
          expectedVersion, version: result.version, token, promise: null,
        });
        onChange();
        return null;
      }
      entries.set(key, {
        status: 'ready', value: result?.value || null, error: '',
        expectedVersion, version: result?.version || expectedVersion, token, promise: null,
      });
      onChange();
      return result?.value || null;
    }, (error) => {
      if (entries.get(key)?.token !== token) return null;
      entries.set(key, {
        status: 'error', value: null, error: error?.message || 'Detail request failed',
        expectedVersion, token, promise: null,
      });
      onChange();
      return null;
    });
    entries.set(key, entry);
    return entry.promise;
  }

  function reconcile(data) {
    const versions = new Map();
    for (const task of data.tasks || []) versions.set(keyFor('task', task.id), task._detailVersion);
    for (const session of data.sessions || []) versions.set(keyFor('session', session.id), session._detailVersion);
    for (const item of data.reviewQueue?.items || []) versions.set(keyFor('review', item.id), item._detailVersion);
    for (const [key, entry] of entries) {
      if (!versions.has(key) || versions.get(key) !== entry.expectedVersion) entries.delete(key);
    }
  }

  function retry(kind, id, expectedVersion) {
    entries.delete(keyFor(kind, id));
    return ensure(kind, id, expectedVersion);
  }

  return { peek, ensure, retry, reconcile };
}
