import { expect, test, type Page } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
async function setup(page: Page, seedPage = false) {
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const response = await page.request.post(`${api}/__stream/setup`);
  expect(response.status()).toBe(201);
  const fixture = await response.json();
  if (seedPage) expect((await page.request.post(`${api}/__stream/seed-page`)).status()).toBe(200);
  await page.goto(`/app/workspaces/${fixture.workspaceId}/conversations/${fixture.conversationId}`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Live updates connected' }),
  ).toBeVisible();
  return fixture;
}
async function state(page: Page) {
  return (await page.request.get(`${api}/__stream/state`)).json();
}
test('bounded live bootstrap continues from its own message page without skipping current sources', async ({
  page,
}) => {
  await setup(page, true);
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(page.getByRole('article').last()).toContainText('Seed message 19');
  await page.getByRole('link', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(11);
  await expect(page.getByRole('article').first()).toContainText('Seed message 20');
  await expect(page.getByRole('article').last()).toContainText('Seed message 30');
  await expect(page.getByRole('status').filter({ hasText: 'Live updates connected' })).toHaveCount(
    0,
  );
});
test('real Fastify and Worker stream a draft through the BFF before one final ledger answer', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await page.request.post(`${api}/__stream/start`);
  await expect(
    page.getByLabel('Draft answer').getByText('Live draft', { exact: true }),
  ).toBeVisible();
  const before = await state(page);
  expect(before.run.status).toBe('running');
  expect(before.outputs).toHaveLength(0);
  expect(before.delivery.at(-1)).toMatchObject({
    event_type: 'assistant.delta',
    delta_text: 'Live draft',
  });
  await page.request.post(`${api}/__stream/release`);
  await expect(page.getByRole('article', { name: 'Message by Stream helper' })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'Message by Stream helper' })).toContainText(
    'Live draft plus more',
  );
  await expect(page.getByLabel('Draft answer')).toHaveCount(0);
  const after = await state(page);
  expect(after.outputs).toHaveLength(1);
  expect(after.run.status).toBe('completed');
  expect(
    after.delivery
      .filter((event: { event_type: string }) => event.event_type === 'assistant.delta')
      .map((event: { delta_text: string }) => event.delta_text)
      .join(''),
  ).toBe('Live draft plus more');
  expect(after.taskCount).toBe(1);
  expect(await page.content()).not.toMatch(
    /stream-private-provider-sentinel|Private stream instructions sentinel|private diagnostic sentinel/u,
  );
  expect(errors).toEqual([]);
});
test('real BFF reconnect resumes the applied cursor and keeps one final answer', async ({
  page,
}) => {
  await setup(page);
  await page.request.post(`${api}/__stream/start`);
  await expect(page.getByLabel('Draft answer')).toContainText('Live draft');
  await page.request.post(`${api}/__stream/disconnect`);
  await expect.poll(async () => (await state(page)).cursors.length).toBeGreaterThan(1);
  const connected = await state(page);
  const after = JSON.parse(Buffer.from(connected.cursors.at(-1), 'base64url').toString()).after;
  expect(after).toBe(4);
  await page.request.post(`${api}/__stream/next`);
  await expect(page.getByLabel('Draft answer')).toContainText('Live draft plus more');
  await page.request.post(`${api}/__stream/release`);
  await expect(page.getByRole('article', { name: 'Message by Stream helper' })).toHaveCount(1);
  await expect(page.getByLabel('Draft answer')).toHaveCount(0);
  expect((await state(page)).taskCount).toBe(1);
});
test('expired prefixes rebootstrap to unavailable preview and converge without another Task', async ({
  page,
}) => {
  await setup(page);
  await page.request.post(`${api}/__stream/start`);
  await expect(page.getByLabel('Draft answer')).toContainText('Live draft');
  await page.request.post(`${api}/__stream/disconnect`);
  await page.request.post(`${api}/__stream/expire`);
  await expect.poll(async () => (await state(page)).bootstraps).toBe(2);
  await expect(
    page.getByText('Some previews are unavailable. Final answers appear in conversation history.'),
  ).toBeVisible();
  await page.request.post(`${api}/__stream/next`);
  await expect(page.getByLabel('Draft answer')).toHaveText(
    'Preview unavailable; awaiting final answer.',
  );
  await page.request.post(`${api}/__stream/release`);
  await expect(page.getByRole('article', { name: 'Message by Stream helper' })).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'Message by Stream helper' })).toContainText(
    'Live draft plus more',
  );
  expect((await state(page)).taskCount).toBe(1);
});
test('current conversation permission is rechecked during an open real stream', async ({
  page,
}) => {
  await setup(page);
  await page.request.post(`${api}/__stream/start`);
  await expect(page.getByLabel('Draft answer')).toContainText('Live draft');
  await page.request.post(`${api}/__stream/revoke`);
  await expect(page.getByRole('alert')).toHaveText(
    'You no longer have permission to read this conversation.',
  );
  await expect(page.getByLabel('Draft answer')).toHaveCount(0);
  const before = (await state(page)).cursors.length;
  await page.request.post(`${api}/__stream/release`);
  expect((await state(page)).cursors).toHaveLength(before);
  await expect(page.getByRole('article', { name: 'Message by Stream helper' })).toHaveCount(0);
});
