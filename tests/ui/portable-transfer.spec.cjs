const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');

let fixture;
test.beforeEach(async ({ page }) => {
  fixture = await createFixture();
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await page.goto(`${fixture.url}/app`);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'a');
});
test.afterEach(async () => { await fixture.close(); });

test('prepared Codex transfer starts a fresh successor, focuses it, and preserves the source', async ({ page }) => {
  await expect(page.locator('#stage [data-portable-transfer]')).toHaveCount(0);
  await page.locator('#qlist [data-key="running:b"]').click();
  const transfer = page.locator('#stage [data-portable-transfer="portable-one"]');
  await expect(transfer).toContainText('Continue on Codex Two');
  await expect(transfer).toContainText('fresh conversation with saved context');
  await expect(page.locator('#stage')).not.toContainText('/private/fixture');

  await transfer.click();
  await expect(page.locator('#toast')).toContainText('fresh conversation with the saved context');
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'portable-successor');
  await expect(page.locator('#stage')).toHaveAttribute('data-pane', 'portable-pane');
  await expect(page.locator('#stage .xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('#qlist [data-key="running:b"]')).toBeVisible();
  const requests = fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session');
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toEqual({ transferId: 'portable-one' });

  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage [data-open-portable="portable-successor"]')).toContainText('Open successor');
  await page.locator('#stage [data-open-portable="portable-successor"]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'portable-successor');
});

test('launching and ambiguous metadata prevent duplicate portable launches', async ({ page }) => {
  fixture.portableTransfers[0].status = 'launching';
  fixture.publish();
  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage .portable-transfer')).toBeDisabled();
  await expect(page.locator('#stage .portable-transfer')).toContainText('Starting on Codex Two');
  fixture.portableTransfers[0].status = 'ambiguous';
  fixture.publish();
  await expect(page.locator('#stage .portable-transfer-state')).toContainText('no duplicate was started');
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session')).toHaveLength(0);
});
