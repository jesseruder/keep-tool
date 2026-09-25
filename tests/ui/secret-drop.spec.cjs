const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');

let fixture;

const request = (extra = {}) => ({
  id: 'a1b2c3d4', name: 'GITHUB_TOKEN', purpose: 'Fine-grained PAT for the release script', sessionId: 'a',
  node: 'aws1', path: '/Users/j/castle/app/.env', key: 'GITHUB_TOKEN', replace: false, multiline: false,
  status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 86400e3, ...extra,
});

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

const panel = page => page.locator('#stage .secret-drop');
const terminalInput = () => fixture.events.filter(event => event.event === 'input');

test('the panel shows only on the session that asked, and hands the value off once', async ({ page }) => {
  fixture.configure({ secretRequests: [request()] });
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('GITHUB_TOKEN');
  await expect(panel(page)).toContainText('aws1');
  await expect(panel(page)).toContainText('/Users/j/castle/app/.env');
  await expect(panel(page).locator('.sd-save')).toBeDisabled();

  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'b');
  await expect(panel(page)).toBeHidden();
  await page.locator('#qlist [data-key="running:a"]').click();
  await expect(panel(page)).toBeVisible();

  const field = panel(page).locator('.sd-value');
  await field.click();
  await page.keyboard.type('ghp_SECRETVALUE123');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(panel(page).locator('.sd-shape')).toHaveText('18 chars · one line');
  // A state refresh while typing must not rebuild the panel under the cursor.
  fixture.update('a', { title: 'Session A retitled' });
  await expect(page.locator('#stage .session-heading')).toContainText('Session A retitled');
  await expect(field).toHaveValue('ghp_SECRETVALUE123');
  await expect(field).toBeFocused();

  await panel(page).locator('.sd-reveal').click();
  await expect(field).toHaveAttribute('type', 'text');
  await panel(page).locator('.sd-reveal').click();
  await expect(field).toHaveAttribute('type', 'password');

  await field.press('Enter');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#toast')).toContainText('GITHUB_TOKEN written');
  expect(fixture.secretWrites).toEqual([{ id: 'a1b2c3d4', value: 'ghp_SECRETVALUE123' }]);
  // Nothing typed into the panel reached the session's terminal.
  expect(terminalInput().map(event => event.text).join('')).not.toContain('SECRET');
  // And nothing in the page kept it.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('SECRETVALUE');
  expect(await page.locator('#stage').innerHTML()).not.toContain('SECRETVALUE');
});

test('a refused write keeps the value and says why; the next request takes the panel', async ({ page }) => {
  fixture.configure({ secretRequests: [request(), request({ id: 'b2c3d4e5', name: 'NPM_TOKEN', createdAt: Date.now() + 1 })],
    secretRefusal: '/Users/j/castle/app/.env is inside the git repository /Users/j/castle/app and is not gitignored' });
  await expect(panel(page)).toContainText('+1 more');
  const field = panel(page).locator('.sd-value');
  await field.fill('tok-1');
  await panel(page).locator('.sd-save').click();
  await expect(panel(page).locator('.sd-error')).toContainText('not gitignored');
  await expect(field).toHaveValue('tok-1');
  await expect(page.locator('#writeFailure')).toBeHidden();
  await panel(page).locator('.sd-save').click();
  await expect(panel(page)).toContainText('NPM_TOKEN');
  await expect(panel(page).locator('.sd-value')).toHaveValue('');
  expect(fixture.secretWrites).toEqual([{ id: 'a1b2c3d4', value: 'tok-1' }]);
});

test('declining sends the reason and clears the panel', async ({ page }) => {
  fixture.configure({ secretRequests: [request({ key: null, multiline: true, path: '/Users/j/.config/x/sa.json' })] });
  await expect(panel(page).locator('textarea.sd-value')).toBeVisible();
  await panel(page).locator('.sd-decline').click();
  await panel(page).locator('.sd-reason').fill('use the staging key');
  await panel(page).locator('.sd-decline-confirm').click();
  await expect(panel(page)).toBeHidden();
  const declines = fixture.events.filter(event => event.event === 'request' && event.path === '/api/secrets/decline');
  expect(declines.map(event => event.body)).toEqual([{ id: 'a1b2c3d4', reason: 'use the staging key' }]);
  expect(fixture.secretWrites).toEqual([]);
});
