const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');
let fixture;
test.beforeEach(async ({ page }) => {
  fixture = await createFixture();
  // Fixture URLs only: no fonts, telemetry, daemon or real terminal host.
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await page.goto(`${fixture.url}/app`);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'a');
  await expect(page.locator('#stage .term-state')).toHaveText('live');
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await info.attach('fixture-events', { body: Buffer.from(JSON.stringify(fixture.events, null, 2)), contentType: 'application/json' });
  await fixture.close();
});
async function down(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
async function updateDuringPress(page, update) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/state');
  update();
  await response;
  // Allow the response, pending summaries and a paint to reach the UI while held.
  await page.waitForTimeout(80);
}
async function selected(page, id) {
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', id);
  await expect(page.locator('#stage')).toHaveAttribute('data-pane', `p${id}`);
}
test('pressed session keeps its identity when rows reorder before release', async ({ page }) => {
  await down(page, '#qlist [data-key="running:b"] .t');
  await updateDuringPress(page, () => fixture.update('b', { state: 'waiting', title: 'Session B updated' }));
  await page.mouse.up();
  await selected(page, 'b');
  await page.keyboard.type('input-for-b');
  await expect.poll(() => fixture.events.filter(e => e.event === 'input').map(e => e.text).join('')).toContain('input-for-b');
  expect(fixture.events.filter(e => e.event === 'input').every(e => e.pane === 'pb')).toBe(true);
});
test('project filter click survives a background render', async ({ page }) => {
  const selector = '#rail [data-project]:not(.all)';
  await down(page, selector);
  await updateDuringPress(page, () => fixture.update('c', { title: 'Session C updated' }));
  await page.mouse.up();
  await expect(page.locator(selector)).toHaveClass(/on/);
});
test('group toggle survives a background render', async ({ page }) => {
  await down(page, '#qlist .qtoggle:first-of-type');
  await updateDuringPress(page, () => fixture.update('c', { title: 'Session C updated' }));
  await page.mouse.up();
  await expect(page.locator('#qlist [data-key="running:b"]')).toHaveCount(0);
});
test('rapid switching routes typing to the last clicked session during updates', async ({ page }) => {
  fixture.churn(true);
  for (const id of ['b', 'a', 'd', 'c', 'b']) {
    await page.locator(`#qlist [data-key="running:${id}"]`).click();
    await selected(page, id);
    await expect(page.locator('#stage .xterm-helper-textarea')).toBeFocused();
    const before = fixture.events.length;
    await page.keyboard.type(`to-${id}`);
    await expect.poll(() => fixture.events.slice(before).filter(e => e.event === 'input').map(e => e.text).join('')).toContain(`to-${id}`);
    expect(fixture.events.slice(before).filter(e => e.event === 'input').every(e => e.pane === `p${id}`)).toBe(true);
  }
});
test('Close disappears before slow response and stays hidden through stale updates', async ({ page }) => {
  fixture.configure({ closeDelay: 1800 });
  await page.locator('#stage [data-close-session]').click();
  await expect(page.locator('#qlist [data-key="running:a"]')).toHaveCount(0, { timeout: 100 });
  await expect(page.locator('#qlist [data-key="pinned:a"]')).toHaveCount(0);
  expect(fixture.state.panes[0].alive).toBe(true);
  fixture.publish();
  await page.waitForTimeout(150);
  await expect(page.locator('#qlist [data-key="running:a"]')).toHaveCount(0);
  await expect(page.locator('#stage')).not.toHaveAttribute('data-item-key', 'a');
  await expect(page.locator('#toast')).toContainText('Session closed');
  await page.reload();
  await expect(page.locator('#qlist [data-key="running:b"]')).toBeVisible();
  await expect(page.locator('#qlist [data-key="running:a"], #qlist [data-key="pinned:a"]')).toHaveCount(0);
});
test('failed Close restores session and pin without stealing a newer selection', async ({ page }) => {
  fixture.configure({ closeDelay: 900, closeFails: true });
  await page.locator('#stage [data-close-session]').click();
  await expect(page.locator('#qlist [data-key="running:a"]')).toHaveCount(0, { timeout: 100 });
  await page.locator('#qlist [data-key="running:c"]').click();
  await selected(page, 'c');
  await expect(page.locator('#toast')).toContainText('Not closed: Fixture close failure');
  await expect(page.locator('#qlist [data-key="running:a"]')).toBeVisible();
  await expect(page.locator('#qlist [data-key="pinned:a"]')).toHaveCount(1);
  await selected(page, 'c');
});
test('Watch Close hides the pane immediately', async ({ page }) => {
  await page.locator('[data-mode="watch"]').click();
  await page.locator('.wpane[data-pane="pa"] [data-close-session]').click();
  await expect(page.locator('.wpane[data-pane="pa"]')).toHaveCount(0, { timeout: 100 });
  await expect(page.locator('.wpane[data-pane="pb"]')).toBeVisible();
});

test('account handoff sends the explicit destination and confirms refreshed identity', async ({ page }) => {
  await expect(page.locator('#meters')).toContainText('Claude Main 5h');
  await expect(page.locator('#meters')).toContainText('Claude Two 5h');
  await expect(page.locator('#meters')).toContainText('Codex Main 5h');
  await expect(page.locator('#meters')).not.toContainText('legacy');
  await expect(page.locator('#stage .account-label')).toHaveText('Claude Main');
  await page.locator('#stage .account-handoff > summary').click();
  await expect(page.locator('#stage [data-handoff-account="claude-two"]')).toBeVisible();
  await expect(page.locator('#stage [data-handoff-account="claude-two"] small')).toHaveText('5h 11%');
  await expect(page.locator('#stage .account-menu')).not.toContainText('Claude Unsupported');
  await expect(page.locator('#stage .account-menu')).not.toContainText('Codex');
  await page.locator('#stage [data-handoff-account="claude-two"]').click();
  await expect(page.locator('#toast')).toContainText('Continued on Claude Two');
  await expect(page.locator('#stage .account-label')).toHaveText('Claude Two');
  const requests = fixture.events.filter(event => event.event === 'request' && event.path === '/api/handoff-session');
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toEqual({ sessionId: 'a', pane: 'pa', accountId: 'claude-two' });
});

test('interrupted account handoff exposes retry and never claims an unverified resume', async ({ page }) => {
  fixture.configure({ handoffRecoversOnce: true });
  await page.locator('#stage .account-handoff > summary').click();
  await page.locator('#stage [data-handoff-account="claude-two"]').click();
  await expect(page.locator('#toast')).toContainText('Transfer needs recovery');
  await expect(page.locator('#stage .handoff-error')).toHaveText('Transfer interrupted');
  await expect(page.locator('#stage [data-handoff-account="claude-two"]')).toHaveText('Retry');
  await expect(page.locator('#stage .account-label')).toHaveText('Claude Main');
  await page.locator('#stage [data-handoff-account="claude-two"]').click();
  await expect(page.locator('#toast')).toContainText('Continued on Claude Two');
  await expect(page.locator('#stage .account-label')).toHaveText('Claude Two');
});

test('dragging off a pressed row cancels navigation and releases queued renders', async ({ page }) => {
  await down(page, '#qlist [data-key="running:b"] .t');
  await updateDuringPress(page, () => fixture.update('b', { state: 'waiting', title: 'B after cancelled click' }));
  await page.mouse.move(1490, 940);
  await page.mouse.up();
  await selected(page, 'a');
  await expect(page.locator('#qlist [data-key="running:b"]')).toContainText('B after cancelled click');
});

test('pressed waiting row still opens that session after the request is answered', async ({ page }) => {
  fixture.state.attention = [{ kind: 'input', sessionId: 'b', pane: 'pb', title: 'Session B', project: fixture.state.sessions[1].project, pri: 0 }];
  fixture.publish();
  await expect(page.locator('#qlist [data-key="waiting:b"]')).toBeVisible();
  await down(page, '#qlist [data-key="waiting:b"] .t');
  await updateDuringPress(page, () => { fixture.state.attention = []; fixture.publish(); });
  await page.mouse.up();
  await selected(page, 'b');
});

test('closed process is not reported as close failure when unpinning fails', async ({ page }) => {
  fixture.configure({ closeDelay: 100, layoutFails: true });
  await page.locator('#stage [data-close-session]').click();
  await expect(page.locator('#toast')).toContainText('Session closed, but unpinning failed');
  await expect(page.locator('#qlist [data-key="running:a"]')).toHaveCount(0);
  expect(fixture.state.panes[0].alive).toBe(false);
  await page.locator('#qlist [data-key="pinned:a"]').click();
  await expect(page.locator('#stage [data-close-session]')).toHaveCount(0);
});

test('Fleet Close hides only its session while the operation is pending', async ({ page }) => {
  await page.locator('[data-mode="fleet"]').click();
  await page.locator('[data-close-idle="a"]').click();
  await expect(page.locator('[data-close-idle="a"]')).toHaveCount(0, { timeout: 100 });
  await expect(page.locator('[data-close-idle="b"]')).toBeVisible();
});

for (const seed of [17, 83]) test(`seed ${seed}: pointer timing and ordering variations keep input identity`, async ({ page }) => {
  let random = seed;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let step = 0; step < 10; step++) {
    const id = 'bcdef'[next() % 5];
    const row = page.locator(`#qlist [data-key="running:${id}"]`);
    await row.scrollIntoViewIfNeeded();
    await down(page, `#qlist [data-key="running:${id}"] .t`);
    await updateDuringPress(page, () => fixture.update(id, { state: next() % 2 ? 'waiting' : 'running', title: `Session ${id.toUpperCase()} seed ${seed} step ${step}` }));
    await page.mouse.up();
    await selected(page, id);
    await expect(page.locator('#stage .xterm-helper-textarea')).toBeFocused();
    const before = fixture.events.length;
    await page.keyboard.type(`s${seed}-${step}`);
    await expect.poll(() => fixture.events.slice(before).filter(e => e.event === 'input').map(e => e.text).join('')).toContain(`s${seed}-${step}`);
    expect(fixture.events.slice(before).filter(e => e.event === 'input').every(e => e.pane === `p${id}`)).toBe(true);
  }
});
