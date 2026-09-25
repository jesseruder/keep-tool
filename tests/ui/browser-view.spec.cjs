const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');

let fixture;

const view = (extra = {}) => {
  const session = fixture.state.sessions.find(s => s.id === 'a');
  return {
    id: 'b0b0b0b0', sessionId: 'a', num: 7, pane: session.pane, node: 'aws1', tabId: null,
    note: 'Sign in to the dashboard', createdAt: Date.now(), expiresAt: Date.now() + 7200e3, ...extra,
  };
};

test.beforeEach(async ({ page }) => {
  fixture = await createFixture();
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await page.goto(`${fixture.url}/app`);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'a');
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await info.attach('fixture-events', {
    body: Buffer.from(JSON.stringify(fixture.events, null, 2)), contentType: 'application/json',
  });
  await fixture.close();
});

const panel = page => page.locator('#stage .browser-view');
const browserEvents = () => fixture.events.filter(event => event.event === 'browser');

test('the view floats over the terminal without resizing it, and starts on the sign-in pop-up', async ({ page }) => {
  const terminal = page.locator('#stage .stage-terminal');
  await expect(page.locator('#stage .xterm')).toBeVisible();
  const before = await terminal.boundingBox();
  const resizes = () => fixture.events.filter(event => event.event === 'terminal' && event.t === 'resize').length;
  const resizesBefore = resizes();

  fixture.configure({ browserViews: [view()] });
  await expect(panel(page).locator('.bv-card')).toBeVisible();
  await expect(panel(page)).toContainText('Sign in to the dashboard');
  await expect(panel(page).locator('.bv-where')).toHaveText('#7 · aws1');
  expect(await terminal.boundingBox()).toEqual(before);

  // Connected for session #7 on the session's pane, and started on the pop-up.
  await expect.poll(() => browserEvents().find(e => e.t === 'start')?.tabId).toBe(12);
  expect(browserEvents().find(e => e.t === 'connect').session).toBe('7');
  const start = browserEvents().find(e => e.t === 'start');
  const screen = await panel(page).locator('.bv-screen').boundingBox();
  expect(Math.abs(start.width - Math.round(screen.width))).toBeLessThanOrEqual(1);
  await expect(panel(page).locator('.bv-tab')).toHaveCount(2);
  await expect(panel(page).locator('.bv-tab.on')).toContainText('Sign in');
  await expect(panel(page).locator('.bv-url')).toHaveText('https://accounts.example.test/signin');

  // The frame is drawn and acknowledged.
  await expect(panel(page).locator('.bv-status')).toBeHidden();
  await expect.poll(() => browserEvents().filter(e => e.t === 'ack').length).toBeGreaterThan(0);

  await page.waitForTimeout(300);
  expect(resizes()).toBe(resizesBefore);
  expect(await terminal.boundingBox()).toEqual(before);
});

test('clicks, keys and pastes go to the page in its own pixels, not to the terminal', async ({ page }) => {
  fixture.configure({ browserViews: [view({ tabId: 11 })] });
  await expect.poll(() => browserEvents().find(e => e.t === 'start')?.tabId).toBe(11);
  await expect(panel(page).locator('.bv-status')).toBeHidden();
  // The view restarts once its layout settles (the tab strip and note take their room);
  // click only once no restart has come for a while, on the frame for the last one.
  const starts = () => browserEvents().filter(e => e.t === 'start').length;
  for (let seen = -1; seen !== starts();) { seen = starts(); await page.waitForTimeout(500); }
  const canvas = panel(page).locator('.bv-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
  await expect.poll(() => browserEvents().filter(e => e.t === 'input' && e.input.kind === 'mouse' && e.input.type === 'mouseReleased').length).toBe(1);
  const pressed = browserEvents().find(e => e.t === 'input' && e.input.type === 'mousePressed').input;
  // The size the page was last laid out at, which is what the picture shows.
  const start = browserEvents().filter(e => e.t === 'start').at(-1);
  expect(Math.abs(pressed.x - start.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(pressed.y - start.height / 4)).toBeLessThanOrEqual(2);
  expect(pressed.button).toBe('left');

  const terminalBefore = fixture.events.filter(event => event.event === 'input').length;
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await expect.poll(() => browserEvents().filter(e => e.t === 'input' && e.input.kind === 'key' && e.input.type === 'keyDown').map(e => e.input.text).join('')).toBe('hi\r');
  expect(fixture.events.filter(event => event.event === 'input').length).toBe(terminalBefore);

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'pasted secret');
    document.querySelector('#stage .bv-screen').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect.poll(() => browserEvents().find(e => e.t === 'input' && e.input.kind === 'text')?.input.text).toBe('pasted secret');
});

test('Hide folds it to a button and drops the stream; Close ends it for good', async ({ page }) => {
  fixture.configure({ browserViews: [view()] });
  await expect.poll(() => browserEvents().filter(e => e.t === 'connect').length).toBe(1);
  await panel(page).locator('.bv-fold').click();
  await expect(panel(page).locator('.bv-card')).toBeHidden();
  await expect(panel(page).locator('.bv-pill')).toBeVisible();
  await expect.poll(() => browserEvents().filter(e => e.t === 'disconnect').length).toBe(1);

  // Still folded after a state refresh, and it only reconnects when opened.
  fixture.update('a', { title: 'Session A again' });
  await expect(page.locator('#stage .session-heading')).toContainText('Session A again');
  await expect(panel(page).locator('.bv-pill')).toBeVisible();
  await panel(page).locator('.bv-pill').click();
  await expect(panel(page).locator('.bv-card')).toBeVisible();
  await expect.poll(() => browserEvents().filter(e => e.t === 'connect').length).toBe(2);
  // A new connection is a new view on the far side: it must be started again.
  await expect.poll(() => browserEvents().filter(e => e.t === 'start').length).toBeGreaterThanOrEqual(2);
  await expect(panel(page).locator('.bv-status')).toBeHidden();

  await panel(page).locator('.bv-close').click();
  await expect(panel(page)).toBeHidden();
  await expect.poll(() => fixture.events.find(e => e.event === 'browser-view-close')?.id).toBe('b0b0b0b0');
  await expect.poll(() => browserEvents().filter(e => e.t === 'disconnect').length).toBe(2);
});

test('the view shows only on the session that asked', async ({ page }) => {
  fixture.configure({ browserViews: [view()] });
  await expect(panel(page)).toBeVisible();
  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'b');
  await expect(panel(page)).toBeHidden();
  await expect.poll(() => browserEvents().filter(e => e.t === 'disconnect').length).toBe(1);
  await page.locator('#qlist [data-key="running:a"]').click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => browserEvents().filter(e => e.t === 'connect').length).toBe(2);
});
