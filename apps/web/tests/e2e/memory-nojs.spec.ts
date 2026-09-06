import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
test.use({ javaScriptEnabled: false });

test('ordinary forms save and search without JavaScript and retain a denied exact-scope search form', async ({
  page,
}) => {
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const setup = await page.request.post(`${api}/__stream/setup-group-memory`);
  expect(setup.status()).toBe(201);
  const { workspaceId, conversationId, grantId } = await setup.json();
  await page.goto(`/app/workspaces/${workspaceId}/conversations/${conversationId}`);
  await page.locator('summary').filter({ hasText: 'Save as group memory' }).click();
  await page.getByRole('button', { name: 'Save group memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved memory', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to group memories' }).click();
  await page.getByLabel('Search memory text').fill('no matching private needle');
  await page.getByRole('button', { name: 'Search memories', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Group memories', exact: true })).toBeVisible();
  await expect(page.getByText('No current memories in this scope.')).toBeVisible();
  await expect(page.getByLabel('Search memory text')).toHaveValue('no matching private needle');
  expect(page.url()).not.toContain('needle');
  await page.getByLabel('Search memory text').fill('EXPLAIN');
  await page.getByRole('button', { name: 'Search memories', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Saved memory' })).toContainText(
    'Explain the stream evidence.',
  );
  expect(page.url()).not.toContain('EXPLAIN');
  await page.getByLabel('View memories available to').selectOption(grantId);
  await page.getByRole('button', { name: 'Apply scope', exact: true }).click();
  expect((await page.request.post(`${api}/__stream/close-grant`)).status()).toBe(200);
  await page.getByLabel('Search memory text').fill('private denied needle');
  await page.getByRole('button', { name: 'Search memories', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Group memories', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('current group access or source visibility');
  await expect(page.getByLabel('Search memory text')).toHaveValue('private denied needle');
  await expect(page.getByRole('article', { name: 'Saved memory' })).toHaveCount(0);
  expect(page.url()).not.toContain('needle');
});
