const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');

let fixture;

function markExited(id, fullText) {
  const session = fixture.state.sessions.find((candidate) => candidate.id === id);
  const pane = fixture.state.panes.find((candidate) => candidate.id === session.pane);
  Object.assign(session, {
    state: 'exited', stateLabel: 'Exited', exited: true, alive: false, endedTurn: true,
    lastAssistant: `${fullText.slice(0, 80)}…`, lastAssistantFull: fullText,
    lastUserAt: Date.now() + id.charCodeAt(0), mtime: Date.now(),
  });
  Object.assign(pane, { alive: false, exitedAt: new Date().toISOString() });
  return session;
}

function detailRequests(kind, id) {
  return fixture.events.filter((event) => event.event === 'request'
    && event.path === '/api/dashboard-detail' && event.query?.kind === kind && event.query?.id === id);
}

async function openRecent(page) {
  await page.locator('#qlist .qtoggle', { hasText: 'Recent' }).click();
}

test.beforeEach(async ({ page }) => {
  fixture = await createFixture();
  fixture.state.sessions[0].lastAssistant = 'Active preview stays in the regular state response.';
  fixture.state.sessions[0].lastAssistantFull = 'Active full text stays available without a detail request.';
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
});

test.afterEach(async () => { await fixture.close(); });

test('exited conversation text loads only when opened and refreshes by stable content version', async ({ page }) => {
  const first = 'Historical full answer '.repeat(80) + 'FIRST-END';
  const old = markExited('k', first);
  fixture.configure({ delayDetail: { kind: 'session', id: 'k', ms: 500 } });
  await page.goto(`${fixture.url}/app`);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'a');
  await expect(page.locator('#stage .term-state')).toHaveText('live');
  expect(detailRequests('session', 'a')).toHaveLength(0);
  expect(detailRequests('session', 'k')).toHaveLength(0);

  await openRecent(page);
  await expect(page.locator('#qlist [data-key="recent:k"]')).toContainText('Session K');
  expect(detailRequests('session', 'k')).toHaveLength(0);
  await page.locator('#qlist [data-key="recent:k"]').click();
  await expect(page.locator('#stage .legacy [role="status"]')).toHaveText('Loading recent conversation…');
  await expect(page.locator('#stage .legacy pre')).toContainText('FIRST-END');
  expect(await page.locator('#stage .legacy pre').textContent()).toBe(first);
  expect(detailRequests('session', 'k')).toHaveLength(1);

  const refreshResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  old.title = 'Renamed historical session';
  old.accountLabel = 'Claude Secondary';
  fixture.publish();
  await refreshResponse;
  await expect(page.locator('#stage h2')).toHaveText('Renamed historical session');
  expect(detailRequests('session', 'k')).toHaveLength(1);

  const second = 'New historical answer '.repeat(80) + 'SECOND-END';
  old.lastAssistant = `${second.slice(0, 80)}…`;
  old.lastAssistantFull = second;
  fixture.publish();
  await expect(page.locator('#stage .legacy pre')).toContainText('SECOND-END');
  expect(await page.locator('#stage .legacy pre').textContent()).toBe(second);
  expect(detailRequests('session', 'k')).toHaveLength(2);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'k');
});

test('delayed old detail cannot replace a newer selection and errors wait for manual retry', async ({ page }) => {
  const first = 'Delayed historical answer '.repeat(60) + 'K-END';
  const second = 'Retry historical answer '.repeat(60) + 'L-END';
  markExited('k', first);
  markExited('l', second);
  fixture.configure({ delayDetail: { kind: 'session', id: 'k', ms: 250 } });
  fixture.configure({ failDetail: { kind: 'session', id: 'l' } });
  await page.goto(`${fixture.url}/app`);
  await openRecent(page);

  await page.locator('#qlist [data-key="recent:k"]').click();
  await expect(page.locator('#stage .legacy [role="status"]')).toHaveText('Loading recent conversation…');
  await page.locator('#qlist [data-key="recent:l"]').click();
  await expect(page.locator('#stage .legacy [role="alert"]')).toContainText('Fixture detail failure');
  await page.waitForTimeout(350);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'l');
  await expect(page.locator('#stage .legacy pre')).not.toContainText('K-END');
  expect(detailRequests('session', 'k')).toHaveLength(1);
  expect(detailRequests('session', 'l')).toHaveLength(1);

  const refreshResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  fixture.publish();
  await refreshResponse;
  await page.waitForTimeout(100);
  await expect(page.locator('#stage .legacy [role="alert"]')).toContainText('Fixture detail failure');
  expect(detailRequests('session', 'l')).toHaveLength(1);

  await page.locator('#stage [data-retry-session-detail]').click();
  await expect(page.locator('#stage .legacy pre')).toContainText('L-END');
  expect(await page.locator('#stage .legacy pre').textContent()).toBe(second);
  expect(detailRequests('session', 'l')).toHaveLength(2);
});
