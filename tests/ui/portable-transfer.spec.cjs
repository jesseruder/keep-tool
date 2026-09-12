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

test('native Codex transfer keeps the session id and the portable action remains distinct', async ({ page }) => {
  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage .account-label')).toHaveText('Codex Main');
  await expect(page.locator('#stage [data-portable-transfer="portable-one"]')).toContainText('fresh conversation');
  const chooser = page.locator('#stage .account-handoff > summary');
  await expect(chooser).toHaveText('Continue on another account');
  await expect(chooser).toHaveAttribute('title', 'Continue this Codex conversation on another account');
  await chooser.click();
  await expect(page.locator('#stage [data-handoff-account="codex-two"]')).toBeVisible();
  await expect(page.locator('#stage .account-menu')).not.toContainText('Claude');
  await page.locator('#stage [data-handoff-account="codex-two"]').click();
  await expect(page.locator('#toast')).toContainText('Continued on Codex Two');
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'b');
  await expect(page.locator('#stage')).toHaveAttribute('data-pane', 'pb');
  await expect(page.locator('#stage .account-label')).toHaveText('Codex Two');
  const requests = fixture.events.filter(event => event.event === 'request' && event.path === '/api/handoff-session');
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toEqual({ sessionId: 'b', pane: 'pb', accountId: 'codex-two' });
});

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

test('reloaded preview preserves custom context and a blank destination model when only cwd is edited', async ({ page }) => {
  fixture.state.sessions.find(session => session.id === 'a').endedTurn = true;
  fixture.publish();
  await page.locator('#stage [data-new-portable-transfer="a"]').click();
  let modal = page.locator('.portable-transfer-dialog');
  await modal.locator('[data-transfer-account]').selectOption('codex-two');
  await modal.locator('[data-transfer-context]').fill('My saved instruction survives a browser reload.');
  await modal.locator('[data-prepare-transfer]').click();
  await page.reload();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'a');
  await page.locator('#stage [data-review-portable]').click();
  modal = page.locator('.portable-transfer-dialog');
  await expect(modal.locator('[data-transfer-account]')).toHaveValue('codex-two');
  await expect(modal.locator('[data-transfer-model]')).toHaveValue('');
  await expect(modal.locator('[data-transfer-context]')).toHaveValue('My saved instruction survives a browser reload.');
  const savedCwd = await modal.locator('[data-transfer-cwd]').inputValue();
  await modal.locator('[data-transfer-cwd]').fill(`${savedCwd}/.`);
  await modal.locator('[data-transfer-cwd]').press('Tab');
  await modal.locator('[data-prepare-transfer]').click();
  const prepares = fixture.events.filter(event => event.event === 'request'
    && event.path === '/api/portable-transfers' && event.method === 'POST');
  expect(prepares).toHaveLength(2);
  expect(prepares[1].body).toEqual(expect.objectContaining({
    accountId: 'codex-two', model: '', context: 'My saved instruction survives a browser reload.',
  }));
});

test('ambiguous transfer reopens from saved preview and binds an observed receipt without relaunching', async ({ page }) => {
  const transfer = fixture.portableTransfers[0];
  Object.assign(transfer, { status: 'ambiguous', policyVersion: 2 });
  fixture.state.sessions.push({ id: 'observed-successor', kind: 'codex', title: 'Observed successor', project: transfer.cwd,
    pane: 'observed-pane', accountId: transfer.targetAccountId, accountLabel: 'Codex Two',
    portableTransferId: transfer.id, openingDelivered: true, state: 'running', endedTurn: false });
  fixture.state.panes.push({ id: 'observed-pane', pid: 901, alive: true, cwd: transfer.cwd,
    meta: { agent: 'codex', sessionId: 'observed-successor', accountId: transfer.targetAccountId,
      accountLabel: 'Codex Two', card: transfer.cardId, portableTransferId: transfer.id } });
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

test('an intact pre-stop native failure offers an explicit fresh continuation and preserves the source', async ({ page }) => {
  const source = fixture.state.sessions.find(session => session.id === 'a');
  source.endedTurn = true;
  fixture.state.handoffs.push({ id: 'handoff-safe-fallback', transactionId: 'handoff-safe-fallback',
    sessionId: 'a', pane: 'pa', sourceAccountId: 'claude-main', targetAccountId: 'claude-two',
    status: 'recovery-needed', phase: 'stopping-source', reason: 'Job ledger evidence is incomplete',
    portableFallbackAvailable: true });
  fixture.publish();
  const fallback = page.locator('#stage [data-portable-fallback="handoff-safe-fallback"]');
  await expect(fallback).toHaveText('Start fresh continuation');
  await fallback.click();
  await expect(page.locator('.portable-transfer-dialog')).toBeVisible();
  await expect(page.locator('.portable-transfer-dialog')).toContainText('source session stays intact');
  expect(source.accountId).toBe('claude-main');
  expect(fixture.state.panes.find(pane => pane.id === 'pa').alive).toBe(true);
  const abandon = fixture.events.find(event => event.event === 'request' && event.path === '/api/abandon-account-handoff');
  expect(abandon.body).toEqual({ sessionId: 'a', pane: 'pa', transactionId: 'handoff-safe-fallback' });
});

test('trust-blocked transfer foregrounds and retries the existing successor after reload', async ({ page }) => {
  const transfer = fixture.portableTransfers[0];
  Object.assign(transfer, { status: 'awaiting-setup', policyVersion: 2, openingStatus: 'pending',
    setupKind: 'workspace-trust', destinationSessionId: 'trust-successor', destinationPane: 'trust-pane' });
  fixture.state.sessions.push({ id: 'trust-successor', kind: 'codex', title: 'Trust successor', project: transfer.cwd,
    taskId: transfer.cardId, pane: 'trust-pane', accountId: transfer.targetAccountId, accountLabel: 'Codex Two',
    portableTransferId: transfer.id, state: 'running', endedTurn: false });
  fixture.state.panes.push({ id: 'trust-pane', pid: 902, alive: true, cwd: transfer.cwd,
    meta: { agent: 'codex', sessionId: 'trust-successor', accountId: transfer.targetAccountId,
      accountLabel: 'Codex Two', card: transfer.cardId, portableTransferId: transfer.id } });
  fixture.publish();
  await page.locator('#qlist [data-key="running:b"]').click();
  await page.reload();
  await page.locator('#qlist [data-key="running:b"]').click();
  await expect(page.locator('#stage [data-open-portable="trust-successor"]')).toContainText('Finish setup');
  await page.locator('#stage [data-open-portable="trust-successor"]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'trust-successor');

  await page.locator('#qlist [data-key="running:b"]').click();
  await page.locator('#stage [data-review-portable="portable-one"]').click();
  const modal = page.locator('.portable-transfer-dialog');
  await expect(modal).toContainText('accept the prompt yourself');
  await modal.locator('[data-retry-delivery]').click();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'trust-successor');
  expect(fixture.state.sessions.filter(session => session.id === 'trust-successor')).toHaveLength(1);
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session')).toHaveLength(1);
});

test('trust-blocked Codex successor opens its saved pane before a session id exists', async ({ page }) => {
  const transfer = fixture.portableTransfers[0];
  Object.assign(transfer, { status: 'awaiting-setup', policyVersion: 2, openingStatus: 'pending',
    setupKind: 'workspace-trust', destinationSessionId: null, destinationPane: 'unregistered-trust-pane' });
  fixture.state.panes.push({ id: transfer.destinationPane, pid: 903, alive: true, cwd: transfer.cwd,
    meta: { agent: 'codex', accountId: transfer.targetAccountId, card: transfer.cardId,
      portableTransferId: transfer.id, title: 'Codex workspace trust' } });
  fixture.publish();

  await page.locator('#qlist [data-key="running:b"]').click();
  await page.locator('#stage [data-review-portable="portable-one"]').click();
  const modal = page.locator('.portable-transfer-dialog');
  await expect(modal).toContainText('waiting for workspace trust');
  await modal.locator('[data-open-setup]').click();

  await expect(modal).not.toBeVisible();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'unregistered-trust-pane');
  await expect(page.locator('#stage')).toHaveAttribute('data-pane', 'unregistered-trust-pane');
  await expect(page.locator('#stage')).toContainText('Codex workspace trust');
  await expect(page.locator('#stage .xterm-helper-textarea')).toBeFocused();
  expect(fixture.events.filter(event => event.event === 'request' && event.path === '/api/transfer-session')).toHaveLength(0);
});
