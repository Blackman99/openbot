import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399',
  workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
test('saves one source through an uncertain response, reloads provenance, searches an exact scope and excludes an edited source', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(api + '/__scenario', { data: { scenario: 'unclaimed' } });
  await page.request.post(api + '/__conversation/setup');
  await page.goto(`/app/workspaces/${workspaceId}/conversations`);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Cobalt launch decision');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  const setup = await page.request.post(api + '/__memory/setup', { data: { conversationId } });
  expect(setup.status()).toBe(200);
  const { allGrantId, futureGrantId } = await setup.json();
  await page.reload();
  await page.locator('summary').filter({ hasText: 'Save as group memory' }).click();
  const saveForm = page.locator('form[action*="/saveMemory"]');
  const key = await saveForm.locator('[name="idempotencyKey"]').inputValue();
  const sourceEventId = await saveForm.locator('[name="expectedSourceEventId"]').inputValue();
  const messageId = await saveForm.locator('[name="messageId"]').inputValue();
  await expect(page.getByLabel('Confidence (your estimate, 0–1)')).toHaveValue('0.5');
  await request.post(api + '/__memory/state', { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('same command key');
  await expect(saveForm.locator('[name="idempotencyKey"]')).toHaveValue(key);
  await expect(saveForm.locator('[name="expectedSourceEventId"]')).toHaveValue(sourceEventId);
  await page.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved memory', exact: true })).toBeVisible();
  const detailUrl = page.url();
  await page.reload();
  await expect(page.getByRole('article', { name: 'Saved memory' })).toContainText(
    'Cobalt launch decision',
  );
  await expect(page.getByRole('article', { name: 'Saved memory' })).toContainText(
    'Confidence 0.5 (human estimate)',
  );
  await page.locator('summary').filter({ hasText: 'Source provenance' }).click();
  await expect(page.getByText(sourceEventId, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'View current source message' })).toHaveAttribute(
    'href',
    `/app/workspaces/${workspaceId}/conversations/${conversationId}?messageId=${messageId}#message-${messageId}`,
  );
  await page.getByRole('link', { name: 'Back to group memories' }).click();
  await page.getByLabel('Search memory text').fill('COBALT');
  await page.getByRole('button', { name: 'Search memories', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Saved memory' })).toHaveCount(1);
  expect(page.url()).not.toContain('COBALT');
  await page.getByLabel('View memories available to').selectOption(futureGrantId);
  await page.getByRole('button', { name: 'Apply scope' }).click();
  await expect(page.getByText('No current memories in this scope.')).toBeVisible();
  await page.getByLabel('View memories available to').selectOption(allGrantId);
  await page.getByRole('button', { name: 'Apply scope' }).click();
  await expect(page.getByRole('article', { name: 'Saved memory' })).toHaveCount(1);
  await request.post(api + '/__conversation/state', {
    data: { conversationId, messageId, edit: 'The current decision has changed.' },
  });
  await page.reload();
  await expect(page.getByText('No current memories in this scope.')).toBeVisible();
  expect((await page.goto(detailUrl))?.status()).toBe(403);
  await expect(page.getByText('Cobalt launch decision', { exact: true })).toHaveCount(0);
  const state = await (await request.get(api + '/__memory/state')).json();
  expect(state.records).toHaveLength(1);
  expect(state.attempts).toHaveLength(2);
  expect(
    state.attempts.every(
      (attempt: { command: { idempotencyKey: string } }) => attempt.command.idempotencyKey === key,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('reviews a pending candidate from the conversation inbox and confirms a workspace destination', async ({
  page,
  request,
}) => {
  await request.post(api + '/__scenario', { data: { scenario: 'unclaimed' } });
  await page.request.post(api + '/__conversation/setup');
  await page.goto(`/app/workspaces/${workspaceId}/conversations`);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(
    (await page.request.post(api + '/__memory/setup-inbox', { data: { conversationId } })).status(),
  ).toBe(200);
  await page.getByRole('link', { name: 'Memory review inbox', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Memory review inbox', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('keep the edited evidence.')).toBeVisible();
  await page.getByLabel('Wider destination').selectOption(`workspace:${workspaceId}`);
  await page.getByRole('button', { name: 'Preview wider approval', exact: true }).click();
  await expect(
    page.getByText('Workspace facts are available throughout this workspace.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm this approval', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'approved', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm this approval' })).toHaveCount(0);
});

test('rejects a pending inbox candidate so later automatic approval cannot revive it', async ({
  page,
  request,
}) => {
  await request.post(api + '/__scenario', { data: { scenario: 'unclaimed' } });
  await page.request.post(api + '/__conversation/setup');
  await page.goto(`/app/workspaces/${workspaceId}/conversations`);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(
    (await page.request.post(api + '/__memory/setup-inbox', { data: { conversationId } })).status(),
  ).toBe(200);
  await page.getByRole('link', { name: 'Memory review inbox', exact: true }).click();
  await expect(page.getByText('keep the edited evidence.')).toBeVisible();
  await page.getByRole('button', { name: 'Reject candidate', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'rejected', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject candidate' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve into this group' })).toHaveCount(0);
});

test('edits a pending candidate and approves it into the origin group', async ({
  page,
  request,
}) => {
  await request.post(api + '/__scenario', { data: { scenario: 'unclaimed' } });
  await page.request.post(api + '/__conversation/setup');
  await page.goto(`/app/workspaces/${workspaceId}/conversations`);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(
    (await page.request.post(api + '/__memory/setup-inbox', { data: { conversationId } })).status(),
  ).toBe(200);
  await page.getByRole('link', { name: 'Memory review inbox', exact: true }).click();
  await page.getByLabel('Reviewed text').fill('keep the reviewed group fact.');
  await page.getByRole('button', { name: 'Save edited candidate', exact: true }).click();
  await expect(page.getByText('keep the reviewed group fact.')).toBeVisible();
  await page.getByLabel('Reviewer confidence').first().fill('0.8');
  await page.getByRole('button', { name: 'Approve into this group', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'approved', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve into this group' })).toHaveCount(0);
});
