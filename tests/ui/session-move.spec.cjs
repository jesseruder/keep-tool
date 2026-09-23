const { test, expect } = require('@playwright/test');
const { createFixture } = require('./fixture.cjs');

const fleet = [
  { name: 'main', daemon: true, capabilities: [], ok: true },
  { name: 'aws1', daemon: false, capabilities: [], ok: true },
  { name: 'mini', daemon: false, capabilities: [], ok: false, reason: 'timeout' },
];
let fixture;
test.beforeEach(async ({ page }) => {
  fixture = await createFixture();
  fixture.configure({ nodes: fleet });
  await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await page.goto(`${fixture.url}/app`);
  await expect(page.locator('#stage')).toHaveAttribute('data-item-key', 'a');
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await info.attach('fixture-events', { body: Buffer.from(JSON.stringify(fixture.events, null, 2)), contentType: 'application/json' });
  await fixture.close();
});
const moves = () => fixture.events.filter(event => event.event === 'request' && event.path === '/api/move-session').map(event => event.body);
async function openMove(page) {
  const menu = page.locator('#stage .session-actions');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await page.locator('#stage .session-move > summary').click();
}

test('a session moves to the machine picked, checked dry first', async ({ page }) => {
  await openMove(page);
  await expect(page.locator('#stage [data-move-node="main"]')).toHaveCount(0);
  await expect(page.locator('#stage [data-move-node="mini"]')).toBeDisabled();
  await expect(page.locator('#stage [data-move-node="mini"] small')).toHaveText('unreachable: timeout');
  await page.locator('#stage [data-move-node="aws1"]').click();
  await expect(page.locator('#toast')).toContainText('Moved to aws1 (pane pa)');
  expect(moves()).toEqual([
    { sessionId: 'a', node: 'aws1', ownerForce: true, dry: true },
    { sessionId: 'a', node: 'aws1', ownerForce: true },
  ]);
  // Now on aws1, the session is offered the way back.
  await openMove(page);
  await expect(page.locator('#stage [data-move-node="main"]')).toContainText('main (this machine)');
  await expect(page.locator('#stage [data-move-node="aws1"]')).toHaveCount(0);
});

test('a refused check says why and moves nothing', async ({ page }) => {
  fixture.configure({ moveRefusal: { error: '/repo does not exist on aws1; create it there first', reason: 'cwd-missing' } });
  await openMove(page);
  await page.locator('#stage [data-move-node="aws1"]').click();
  await expect(page.locator('#toast')).toContainText('Not moved: /repo does not exist on aws1');
  expect(moves()).toHaveLength(1);
  await expect(page.locator('#writeFailure')).toBeHidden();
});

test('the Machine select starts a new session on the node picked', async ({ page }) => {
  await page.locator('#rail [data-shell]').click();
  const chooser = page.locator('.session-launch-dialog');
  await chooser.locator('[data-launch-kind]').selectOption('claude');
  await expect(chooser.locator('[data-launch-node]')).toHaveValue('');
  await expect(chooser.locator('[data-launch-node] option[value="mini"]')).toHaveAttribute('disabled', '');
  await chooser.locator('[data-launch-node]').selectOption('aws1');
  await chooser.locator('[data-launch-submit]').click();
  await expect.poll(() => fixture.events.filter(event => event.event === 'request' && event.path === '/api/open').length).toBe(1);
  const open = fixture.events.find(event => event.event === 'request' && event.path === '/api/open');
  expect(open.body).toMatchObject({ fresh: true, agent: 'claude', node: 'aws1' });
});

test('the review queue chooser offers the Machine select and sends the node picked', async ({ page }) => {
  fixture.state.reviewQueue.items.push({ id: 'idea:on-aws1', type: 'idea', card: 'card-review', title: 'Review on aws1',
    body: 'Start this on another machine.', project: fixture.state.sessions[0].project, status: 'needs-decision', at: Date.now(), sessions: [] });
  fixture.state.reviewQueue.counts['needs-decision'] = 1;
  fixture.publish();
  await page.locator('[data-mode=review-queue]').click();
  await page.locator('[data-review-action=start]').click();
  const chooser = page.locator('.session-launch-dialog');
  await expect(chooser.locator('[data-launch-node]')).toHaveValue('');
  await expect(chooser.locator('[data-launch-node] option[value="mini"]')).toHaveAttribute('disabled', '');
  await chooser.locator('[data-launch-node]').selectOption('aws1');
  await chooser.locator('[data-launch-submit]').click();
  await expect(chooser).not.toBeVisible();
  const review = fixture.events.filter(event => event.event === 'request' && event.path === '/api/review-queue');
  expect(review).toHaveLength(1);
  expect(review[0].body).toMatchObject({ id: 'idea:on-aws1', action: 'start', agent: 'claude', accountId: 'claude-main', node: 'aws1' });
});

test('an exited session on another machine shows where it is and can be moved from there', async ({ page }) => {
  const pane = fixture.state.panes.find(candidate => candidate.id === 'pa');
  pane.alive = false; pane.agentAlive = false; pane.node = 'aws1';
  fixture.update('a', { exited: true, state: 'exited', alive: false, node: 'aws1', nodeRecorded: true });
  await expect(page.locator('#stage .shead .node-badge')).toHaveText('aws1');
  await openMove(page);
  await expect(page.locator('#stage [data-move-node="aws1"]')).toHaveCount(0);
  await page.locator('#stage [data-move-node="main"]').click();
  await expect(page.locator('#toast')).toContainText('Moved to main');
  expect(moves()).toEqual([
    { sessionId: 'a', node: 'main', ownerForce: true, dry: true },
    { sessionId: 'a', node: 'main', ownerForce: true },
  ]);
});
