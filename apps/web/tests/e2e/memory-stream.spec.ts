import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399';

test('saves current human and Bot messages delivered live with their exact source event and stable command', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const setup = await page.request.post(`${api}/__stream/setup-group-memory`);
  expect(setup.status()).toBe(201);
  const { workspaceId, conversationId } = await setup.json();
  const conversationUrl = `/app/workspaces/${workspaceId}/conversations/${conversationId}`;
  await page.goto(conversationUrl);
  await expect(
    page.getByRole('status').filter({ hasText: 'Live updates connected' }),
  ).toBeVisible();
  await page.request.post(`${api}/__stream/append-human`);
  const human = page
    .getByRole('article', { name: 'Message by Stream owner' })
    .filter({ hasText: 'Live group source' });
  await expect(human).toContainText('Live group source version one.');
  const form = human.locator('form[action*="/saveMemory"]');
  const key = await form.locator('[name="idempotencyKey"]').inputValue();
  expect(key).toMatch(/^[0-9a-f-]{36}$/u);
  const originalEvent = await form.locator('[name="expectedSourceEventId"]').inputValue();
  const edited = await page.request.post(`${api}/__stream/edit-human`);
  expect(edited.status()).toBe(200);
  const { humanSource } = await edited.json();
  expect(humanSource.eventId).not.toBe(originalEvent);
  await expect(human).toContainText('Live group source version two.');
  await expect(form.locator('[name="expectedSourceEventId"]')).toHaveValue(humanSource.eventId);
  await expect(form.locator('[name="idempotencyKey"]')).toHaveValue(key);
  await human.locator('summary').filter({ hasText: 'Save as group memory' }).click();
  await human.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved memory', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Saved memory' })).toContainText(
    'Live group source version two.',
  );
  const first = await (await page.request.get(`${api}/__stream/state`)).json();
  expect(first.memories).toMatchObject([
    { source_message_id: humanSource.messageId, source_event_id: humanSource.eventId },
  ]);
  await page.goto(conversationUrl);
  await expect(
    page.getByRole('status').filter({ hasText: 'Live updates connected' }),
  ).toBeVisible();
  await page.request.post(`${api}/__stream/start`);
  await expect(page.getByLabel('Draft answer')).toContainText('Live draft');
  await page.request.post(`${api}/__stream/release`);
  const bot = page.getByRole('article', { name: 'Message by Stream helper' });
  await expect(bot).toContainText('Live draft plus more');
  await expect(bot.locator('summary').filter({ hasText: 'Edit message' })).toHaveCount(0);
  await bot.locator('summary').filter({ hasText: 'Save as group memory' }).click();
  const botForm = bot.locator('form[action*="/saveMemory"]');
  const botEvent = await botForm.locator('[name="expectedSourceEventId"]').inputValue();
  expect(await botForm.locator('[name="idempotencyKey"]').inputValue()).toMatch(/^[0-9a-f-]{36}$/u);
  await bot.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved memory', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Saved memory' })).toContainText(
    'Live draft plus more',
  );
  const final = await (await page.request.get(`${api}/__stream/state`)).json();
  expect(final.memories).toHaveLength(2);
  expect(final.memories).toContainEqual(expect.objectContaining({ source_event_id: botEvent }));
  expect(final.outputs).toMatchObject([{ id: botEvent }]);
  expect(final.taskCount).toBe(1);
  expect(errors).toEqual([]);
});
