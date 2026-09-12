const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');

let fixture;

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

const requests = path => fixture.events.filter(event => event.event === 'request' && event.path === path);
const chooser = page => page.locator('.session-launch-dialog');

test('rail chooser cancels without spawning and freezes one explicit agent launch', async ({ page }) => {
  await page.locator('#rail [data-shell]').click();
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page).locator('[data-launch-kind]')).toHaveValue('shell');
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue(fixture.state.sessions[0].project);
  await chooser(page).locator('[data-launch-cancel]').last().click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/panes/spawn')).toHaveLength(0);
  expect(requests('/api/open')).toHaveLength(0);

  fixture.configure({ openDelay: 350 });
  await page.locator('#rail [data-shell]').click();
  const directory = `${fixture.state.sessions[0].project}/edited-worktree`;
  await chooser(page).locator('[data-launch-directory]').fill(directory);
  await chooser(page).locator('[data-launch-kind]').selectOption('claude');
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue(directory);
  await expect(chooser(page).locator('[data-launch-model]')).toHaveValue('claude-fable-5-1');
  await chooser(page).locator('[data-launch-account]').selectOption('claude-two');
  await chooser(page).locator('[data-launch-model]').fill('claude-sonnet-4-5');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page).locator('[data-launch-kind]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-account]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-model]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-directory]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-cancel]').last()).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/open')).toHaveLength(1);
  expect(requests('/api/open')[0].body).toMatchObject({ fresh: true, cwd: directory,
    agent: 'claude', accountId: 'claude-two', model: 'claude-sonnet-4-5' });
  expect(typeof requests('/api/open')[0].body.requestId).toBe('string');
  expect(requests('/api/panes/spawn')).toHaveLength(0);
});

test('post-spawn setup error focuses its saved pane and retry cannot duplicate it', async ({ page }) => {
  fixture.configure({ openFailsAfterSpawn: true });
  await page.locator('#rail [data-shell]').click();
  await chooser(page).locator('[data-launch-kind]').selectOption('codex');
  await chooser(page).locator('[data-launch-account]').selectOption('codex-two');
  const directory = `${fixture.state.sessions[0].project}/recoverable-worktree`;
  await chooser(page).locator('[data-launch-directory]').fill(`  ${directory}  `);
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('existing pane is open for inspection');
  await expect(chooser(page).locator('[data-launch-kind]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-account]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-directory]')).toBeDisabled();
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue(directory);
  await expect(chooser(page).locator('[data-launch-submit]')).toHaveText('Resume setup');
  expect(requests('/api/open')).toHaveLength(1);
  const requestId = requests('/api/open')[0].body.requestId;
  const opened = fixture.state.sessions.filter(session => session.id.startsWith('opened-'));
  expect(opened).toHaveLength(1);
  await expect(page.locator('#stage')).toHaveAttribute('data-pane', opened[0].pane);

  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/open')).toHaveLength(2);
  expect(requests('/api/open').map(request => request.body.requestId)).toEqual([requestId, requestId]);
  expect(requests('/api/open').map(request => request.body.cwd)).toEqual([directory, directory]);
  expect(fixture.state.sessions.filter(session => session.id.startsWith('opened-'))).toHaveLength(1);
});

test('Watch new session keeps the selected project and Plain shell option', async ({ page }) => {
  await page.locator('[data-mode=watch]').click();
  const project = await page.locator('#shellProject').inputValue();
  await page.locator('#spawnShell').click();
  await expect(chooser(page).locator('[data-launch-kind]')).toHaveValue('shell');
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue(project);
  await chooser(page).locator('[data-launch-directory]').fill('   ');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('Directory is required');
  await expect(chooser(page).locator('[data-launch-directory]')).toBeFocused();
  expect(requests('/api/panes/spawn')).toHaveLength(0);
  await chooser(page).locator('[data-launch-directory]').fill('relative/project');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('Directory must be an absolute path');
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue('relative/project');
  await expect(chooser(page).locator('[data-launch-directory]')).toBeFocused();
  expect(requests('/api/panes/spawn')).toHaveLength(0);
  const directory = `${project}/alternate-shell-project`;
  await chooser(page).locator('[data-launch-directory]').fill(directory);
  await chooser(page).locator('[data-launch-kind]').selectOption('codex');
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue(directory);
  await chooser(page).locator('[data-launch-kind]').selectOption('shell');
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveValue(directory);
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/panes/spawn')).toHaveLength(1);
  expect(requests('/api/panes/spawn')[0].body).toEqual({ cwd: directory, name: 'alternate-shell-project' });
  await expect(page.locator('.wpane[data-pane^="shell-"]')).toBeVisible();
});

test('Triage and Watch Reopen share the recorded-account chooser', async ({ page }) => {
  const session = fixture.state.sessions[0];
  session.state = 'exited'; session.exited = true; session.endedTurn = true;
  fixture.state.panes[0].alive = false; fixture.publish();
  await page.reload();
  await page.locator('#qlist .qtoggle').filter({ hasText: 'Recent' }).click();
  await page.locator('#qlist [data-key="recent:a"]').click();
  await page.locator('#stage [data-reopen]').click();
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('claude-main');
  await expect(chooser(page).locator('[data-launch-model]')).toHaveCount(0);
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveCount(0);
  await chooser(page).locator('[data-launch-cancel]').last().click();
  expect(requests('/api/open')).toHaveLength(0);

  await page.locator('[data-mode=watch]').click();
  await page.locator('.wpane[data-pane="pa"] [data-reopen]').click();
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('claude-main');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/open')).toHaveLength(1);
  expect(requests('/api/open')[0].body).toEqual({ sessionId: 'a', agent: 'claude', accountId: 'claude-main' });
  expect(requests('/api/reopen-session')).toHaveLength(0);
  expect(fixture.events.filter(event => event.event === 'input')).toHaveLength(0);
});

test('Fleet shows accounts and reopen keeps a failed explicit choice without launching fresh', async ({ page }) => {
  const session = fixture.state.sessions[0];
  session.state = 'exited'; session.exited = true; session.endedTurn = true;
  fixture.state.panes[0].alive = false;
  fixture.configure({ reopenFails: true });
  fixture.publish();
  await page.locator('[data-mode=fleet]').click();
  await expect(page.locator('#fleet')).toContainText('Claude Main');
  await page.locator(`#fleet [data-reopen="${session.id}"]`).click();
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('claude-main');
  await chooser(page).locator('[data-launch-account]').selectOption('claude-two');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('source remains available');
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('claude-two');
  await expect(chooser(page).locator('[data-launch-transfer]')).toBeVisible();
  expect(requests('/api/reopen-session')).toHaveLength(1);
  expect(requests('/api/open')).toHaveLength(0);
  expect(fixture.events.filter(event => event.event === 'input')).toHaveLength(0);
  expect(session.accountId).toBe('claude-main');
  expect(session.state).toBe('exited');

  fixture.configure({ reopenFails: false });
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/reopen-session')).toHaveLength(2);
  expect(requests('/api/reopen-session').every(request => request.body.sessionId === session.id && request.body.accountId === 'claude-two')).toBe(true);
  expect(requests('/api/open')).toHaveLength(0);
});

test('missing recorded account requires an explicit replacement', async ({ page }) => {
  const session = fixture.state.sessions[0];
  session.state = 'exited'; session.exited = true; session.endedTurn = true;
  session.accountId = 'claude-retired'; session.accountLabel = 'Retired Claude';
  fixture.state.panes[0].alive = false;
  fixture.state.panes[0].meta.accountId = 'claude-retired'; fixture.state.panes[0].meta.accountLabel = 'Retired Claude';
  fixture.publish();
  await page.locator('[data-mode=fleet]').click();
  await page.locator(`#fleet [data-reopen="${session.id}"]`).click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('recorded account claude-retired is unavailable');
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('');
  await expect(chooser(page).locator('[data-launch-submit]')).toBeDisabled();
  expect(requests('/api/reopen-session')).toHaveLength(0);
  await chooser(page).locator('[data-launch-account]').selectOption('claude-two');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/reopen-session')).toHaveLength(1);
  expect(requests('/api/reopen-session')[0].body).toEqual({ sessionId: session.id, accountId: 'claude-two' });
});

test('absent recorded account identity never falls back to the provider default', async ({ page }) => {
  const session = fixture.state.sessions[0];
  session.state = 'exited'; session.exited = true; session.endedTurn = true;
  delete session.accountId; delete session.accountLabel;
  fixture.state.panes[0].alive = false;
  delete fixture.state.panes[0].meta.accountId; delete fixture.state.panes[0].meta.accountLabel;
  fixture.publish();
  await page.locator('[data-mode=fleet]').click();
  await page.locator(`#fleet [data-reopen="${session.id}"]`).click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('recorded account identity is unavailable');
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('');
  await expect(chooser(page).locator('[data-launch-submit]')).toBeDisabled();
  expect(requests('/api/open')).toHaveLength(0);
  expect(requests('/api/reopen-session')).toHaveLength(0);
  await chooser(page).locator('[data-launch-account]').selectOption('claude-two');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/reopen-session')).toHaveLength(1);
  expect(requests('/api/reopen-session')[0].body).toEqual({ sessionId: session.id, accountId: 'claude-two' });
});

test('partial review launch closes the picker and exposes its persisted recovery state', async ({ page }) => {
  fixture.state.reviewQueue.items.push({ id: 'idea:partial', type: 'idea', card: 'card-partial', title: 'Partial review launch',
    body: 'A launched conversation whose delivery needs inspection.', project: fixture.state.sessions[0].project,
    status: 'needs-decision', at: Date.now(), sessions: [] });
  fixture.state.reviewQueue.counts['needs-decision'] = 1;
  fixture.configure({ reviewPartialOnce: true }); fixture.publish();
  await page.locator('[data-mode=review-queue]').click();
  await page.locator('[data-review-action=start]').click();
  await expect(chooser(page).locator('[data-launch-directory]')).toHaveCount(0);
  await chooser(page).locator('[data-launch-account]').selectOption('claude-two');
  await chooser(page).locator('[data-launch-model]').fill('claude-fable-5-1');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  await expect(page.locator('[data-review-detail="idea:partial"] .review-action-error')).toContainText('delivery could not be confirmed');
  await expect(page.locator('[data-review-detail="idea:partial"] [data-review-session]').first()).toBeVisible();
  await expect(page.locator('[data-review-detail="idea:partial"] [data-review-action]')).toHaveCount(0);
  const review = requests('/api/review-queue');
  expect(review).toHaveLength(1);
  expect(review[0].body).toMatchObject({ id: 'idea:partial', action: 'start', agent: 'claude',
    accountId: 'claude-two', model: 'claude-fable-5-1' });
});

test('card fallback and review actions send exact provider account and model choices', async ({ page }) => {
  fixture.state.tasks.push({ id: 'card-fresh', fm: { title: 'Fresh card', project: fixture.state.sessions[0].project, tags: ['personal'] } });
  fixture.state.attention = [{ kind: 'input', taskId: 'card-fresh', title: 'Fresh card', project: fixture.state.sessions[0].project, pri: -1 }];
  fixture.publish();
  await page.reload();
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'card-fresh');
  await page.locator('#stage [data-reopen]').click();
  await expect(chooser(page).locator('[data-launch-kind]')).toHaveValue('claude');
  await expect(chooser(page).locator('[data-launch-model]')).toHaveValue('claude-fable-5-1');
  await chooser(page).locator('[data-launch-kind]').selectOption('codex');
  await chooser(page).locator('[data-launch-account]').selectOption('codex-two');
  await chooser(page).locator('[data-launch-model]').fill('gpt-5.6');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  expect(requests('/api/open').at(-1).body).toMatchObject({ taskId: 'card-fresh', fresh: true,
    agent: 'codex', accountId: 'codex-two', model: 'gpt-5.6' });

  fixture.state.reviewQueue.items.push({ id: 'idea:chooser', type: 'idea', card: 'card-review', title: 'Chooser idea',
    body: 'Test explicit review launch settings.', project: fixture.state.sessions[0].project, status: 'needs-decision', at: Date.now(), sessions: [] });
  fixture.state.reviewQueue.counts['needs-decision'] = 1;
  fixture.configure({ reviewFailsOnce: true }); fixture.publish();
  await page.locator('[data-mode=review-queue]').click();
  await page.locator('[data-review-action=start]').click();
  await chooser(page).locator('[data-launch-kind]').selectOption('codex');
  await chooser(page).locator('[data-launch-account]').selectOption('codex-two');
  await chooser(page).locator('[data-launch-model]').fill('gpt-5.6');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page).locator('[role=alert]')).toContainText('Fixture review launch failed');
  await expect(chooser(page).locator('[data-launch-kind]')).toHaveValue('codex');
  await expect(chooser(page).locator('[data-launch-account]')).toHaveValue('codex-two');
  await expect(chooser(page).locator('[data-launch-model]')).toHaveValue('gpt-5.6');
  await chooser(page).locator('[data-launch-submit]').click();
  await expect(chooser(page)).not.toBeVisible();
  const launchedReview = fixture.state.sessions.find(session => session.id.startsWith('review-'));
  await expect(page.locator('#stage')).toHaveAttribute('data-pane', launchedReview.pane);
  await expect(page.locator('#stage .xterm-helper-textarea')).toBeFocused();
  const review = requests('/api/review-queue');
  expect(review).toHaveLength(2);
  expect(review.map(request => ({ ...request.body, requestId: '<stable>' }))).toEqual([
    { id: 'idea:chooser', action: 'start', requestId: '<stable>', agent: 'codex', accountId: 'codex-two', model: 'gpt-5.6' },
    { id: 'idea:chooser', action: 'start', requestId: '<stable>', agent: 'codex', accountId: 'codex-two', model: 'gpt-5.6' },
  ]);
  expect(review[0].body.requestId).toBe(review[1].body.requestId);
});
