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
  fixture.portableTransfers[0].policyVersion = 2;
  fixture.portableTransfers[0].status = 'launching';
  fixture.publish();
  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage .portable-transfer')).toContainText('Starting successor');
  await page.locator('#stage .portable-transfer').click();
  await expect(page.locator('.portable-transfer-dialog')).toContainText('No compatible existing successor was found');
  await page.keyboard.press('Escape');
  fixture.portableTransfers[0].status = 'ambiguous';
  fixture.publish();
  await expect(page.locator('#stage .portable-transfer')).toContainText('Resolve transfer');
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session')).toHaveLength(0);
});

test('desktop prepares, reviews, and launches a Claude source into a chosen account and model', async ({ page }) => {
  fixture.state.sessions.find(session => session.id === 'a').endedTurn = true;
  fixture.publish();
  await page.locator('#stage [data-new-portable-transfer="a"]').click();
  const modal = page.locator('.portable-transfer-dialog');
  await expect(modal).toBeVisible();
  await expect(modal.locator('[data-transfer-account]')).toBeFocused();
  await expect(modal).toContainText('The successor pauses before work');
  await expect(modal).toContainText('Automated reminders do not resume it');
  await expect(modal.locator('[data-transfer-model]')).toHaveValue('claude-fable-5-1');
  await modal.locator('[data-transfer-account]').selectOption('codex-two');
  await expect(modal.locator('[data-transfer-model]')).toHaveValue('');
  await modal.locator('[data-transfer-model]').fill('gpt-5.6-sol');
  await modal.locator('[data-transfer-context]').fill('After Jesse asks: finish the focused tests, then report back.');
  await modal.locator('[data-transfer-context]').press('Tab');

  fixture.publish();
  await expect(modal.locator('[data-transfer-context]')).toHaveValue('After Jesse asks: finish the focused tests, then report back.');
  await modal.locator('[data-prepare-transfer]').click();
  await expect(modal.locator('.portable-transfer-preview')).toContainText('Immutable saved package');
  await expect(modal.locator('.portable-transfer-preview')).toContainText('Destination account: codex-two');
  await expect(modal.locator('.portable-transfer-preview')).toContainText('gpt-5.6-sol');
  await expect(modal.locator('.portable-transfer-preview')).toContainText('WAIT for Jesse or the user');
  await expect(modal.locator('[data-refresh-transfer]')).toHaveText('Prepare new preview');
  await expect(modal.locator('[data-launch-transfer]')).toBeEnabled();
  await modal.locator('[data-launch-transfer]').click();

  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'portable-successor');
  await expect(page.locator('#qlist [data-key="running:a"]')).toBeVisible();
  const prepare = fixture.events.find(event => event.event === 'request' && event.path === '/api/portable-transfers' && event.method === 'POST');
  expect(prepare.body).toEqual(expect.objectContaining({ sourceSessionId: 'a', accountId: 'codex-two', model: 'gpt-5.6-sol',
    context: 'After Jesse asks: finish the focused tests, then report back.' }));
  expect(prepare.body.cwd).toContain('keep-ui-fixture-');
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session')).toHaveLength(1);
});

test('editing reviewed settings invalidates launch and settled-source errors are actionable', async ({ page }) => {
  await page.locator('#stage [data-new-portable-transfer="a"]').click();
  await expect(page.locator('#toast')).toContainText('source turn has not ended');

  fixture.state.sessions.find(session => session.id === 'a').endedTurn = true;
  fixture.publish();
  await page.locator('#stage [data-new-portable-transfer="a"]').click();
  const modal = page.locator('.portable-transfer-dialog');
  await modal.locator('[data-prepare-transfer]').click();
  await expect(modal.locator('[data-launch-transfer]')).toBeEnabled();
  await modal.locator('[data-transfer-context]').fill('A changed continuation must be prepared again.');
  await expect(modal.locator('[data-launch-transfer]')).toBeDisabled();
  await modal.locator('[data-transfer-context]').press('Tab');
  await expect(modal.locator('[data-prepare-transfer]')).toBeVisible();
});

test('ambiguous transfer reopens from saved preview and binds an observed receipt without relaunching', async ({ page }) => {
  const transfer = fixture.portableTransfers[0];
  Object.assign(transfer, { status: 'ambiguous', policyVersion: 2 });
  fixture.state.sessions.push({ id: 'observed-successor', kind: 'codex', title: 'Observed successor', project: transfer.cwd,
    taskId: transfer.cardId, pane: 'observed-pane', accountId: transfer.targetAccountId, accountLabel: 'Codex Two',
    portableTransferId: transfer.id, openingDelivered: true, state: 'running', endedTurn: false });
  fixture.state.panes.push({ id: 'observed-pane', pid: 901, alive: true, cwd: transfer.cwd,
    meta: { agent: 'codex', sessionId: 'observed-successor', accountId: transfer.targetAccountId,
      accountLabel: 'Codex Two', portableTransferId: transfer.id } });
  fixture.publish();
  await page.locator('#qlist [data-key="running:b"]').click();
  await page.locator('#stage [data-review-portable="portable-one"]').click();
  const modal = page.locator('.portable-transfer-dialog');
  await expect(modal.locator('.portable-transfer-preview')).toContainText('Existing CLI portable package');
  await expect(modal.locator('[data-transfer-resolution]')).toContainText('Observed successor');
  await modal.locator('[data-resolve-transfer]').click();
  await expect.poll(() => transfer.status).toBe('done');
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'observed-successor');
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session')).toHaveLength(0);
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/resolve-portable-transfer')).toHaveLength(1);
});
