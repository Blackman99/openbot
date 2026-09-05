import { expect, test, type Page } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
async function state(page: Page) {
  return (await page.request.get(`${api}/__stream/state`)).json();
}
async function setup(page: Page) {
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const response = await page.request.post(`${api}/__stream/setup-group-memory`);
  expect(response.status()).toBe(201);
  const { workspaceId, conversationId } = await response.json();
  await page.goto(`/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Live updates connected' }),
  ).toBeVisible();
  await page.request.post(`${api}/__stream/append-human`);
  const article = page
    .getByRole('article', { name: 'Message by Stream owner' })
    .filter({ hasText: 'Live group source' });
  await expect(article).toContainText('Live group source version one.');
  return article;
}
async function loseCommittedResponse(page: Page, action: string) {
  await page.route(
    (url) => url.searchParams.has('/' + action),
    async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    },
    { times: 1 },
  );
}
async function resetStream(page: Page) {
  const before = (await state(page)).bootstraps;
  await page.request.post(`${api}/__stream/disconnect`);
  expect((await page.request.post(`${api}/__stream/expire`)).status()).toBe(200);
  await expect.poll(async () => (await state(page)).bootstraps).toBeGreaterThan(before);
  await expect(
    page.getByRole('status').filter({ hasText: 'Live updates connected' }),
  ).toBeVisible();
}

test('a committed live memory save keeps its original command through a lost response and expired stream', async ({
  page,
}) => {
  test.setTimeout(60000);
  const article = await setup(page);
  await article.locator('summary').filter({ hasText: 'Save as group memory' }).click();
  const form = article.locator('form[action*="/saveMemory"]');
  await form.locator('[name="confidence"]').fill('0.73');
  const key = await form.locator('[name="idempotencyKey"]').inputValue();
  const sourceEventId = await form.locator('[name="expectedSourceEventId"]').inputValue();
  await loseCommittedResponse(page, 'saveMemory');
  await form.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('same command key');
  expect((await state(page)).memories).toMatchObject([{ idempotency_key: key, confidence: 0.73 }]);
  await resetStream(page);
  await expect.soft(form.locator('[name="idempotencyKey"]')).toHaveValue(key);
  await expect.soft(form.locator('[name="expectedSourceEventId"]')).toHaveValue(sourceEventId);
  await expect.soft(form.locator('[name="confidence"]')).toHaveValue('0.73');
  if (!(await form.isVisible()))
    await article.locator('summary').filter({ hasText: 'Save as group memory' }).click();
  await form.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved memory', exact: true })).toBeVisible();
  const saved = (await state(page)).memories;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    idempotency_key: key,
    source_event_id: sourceEventId,
    confidence: 0.73,
  });
});

test('a committed live edit retries its original key, version and body after response loss and rebootstrap', async ({
  page,
}) => {
  test.setTimeout(60000);
  await setup(page);
  const { humanSource } = await state(page);
  const article = page.locator(`#message-${humanSource.messageId}`);
  await article.locator('summary').filter({ hasText: 'Edit message' }).click();
  const form = article.locator('form[action*="/edit"]');
  await form.locator('[name="body"]').fill('One uncertain edit body.');
  const key = await form.locator('[name="idempotencyKey"]').inputValue();
  const version = await form.locator('[name="expectedVersion"]').inputValue();
  await loseCommittedResponse(page, 'edit');
  await form.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('same command key');
  expect((await state(page)).humanVersions).toHaveLength(2);
  await resetStream(page);
  await expect.soft(form.locator('[name="idempotencyKey"]')).toHaveValue(key);
  await expect.soft(form.locator('[name="expectedVersion"]')).toHaveValue(version);
  await expect.soft(form.locator('[name="body"]')).toHaveValue('One uncertain edit body.');
  if (!(await form.isVisible()))
    await article.locator('summary').filter({ hasText: 'Edit message' }).click();
  await form.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const versions = (await state(page)).humanVersions;
  expect(versions).toHaveLength(2);
  expect(versions[1]).toMatchObject({ version: 2, idempotency_key: key });
});
