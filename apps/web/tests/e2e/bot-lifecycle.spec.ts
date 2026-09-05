import { expect, test, type Page } from '@playwright/test';
const api = 'http://127.0.0.1:4399',
  origin = 'http://127.0.0.1:4173';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
async function setup(page: Page) {
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot/setup`);
  const created = await page.request.post(`${api}/api/v1/workspaces/${workspaceId}/bots`, {
    headers: { origin },
    data: {
      name: 'Lifecycle helper',
      roleDescription: 'Research assistant',
      instructions: 'Retained protected instructions',
      modelBinding: {
        scope: { kind: 'workspace', id: workspaceId },
        connectionId: 'ce661304-a1bc-4767-9a87-c47de763f749',
        modelId: 'basic-model',
      },
    },
  });
  expect(created.status()).toBe(201);
  const bot = (await created.json()).bot;
  await page.goto(`/app/workspaces/${workspaceId}/bots/${bot.id}`);
  return bot;
}
test('owner archives, validates current model, deletes and recovers through the reachable UI', async ({
  page,
  browser,
}) => {
  const bot = await setup(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('link', { name: 'Manage lifecycle', exact: true }).click();
  await page.getByRole('button', { name: 'Archive Bot', exact: true }).click();
  await expect(page.getByText('Current state: archived', { exact: true })).toBeVisible();
  await page.request.post(`${api}/__bot/state`, { data: { disabled: true } });
  await page.getByRole('button', { name: 'Restore Bot', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('exact model must be enabled');
  await page.request.post(`${api}/__bot/state`, { data: { disabled: false } });
  await page.getByRole('button', { name: 'Restore Bot', exact: true }).click();
  await expect(page.getByText('Current state: active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Bot', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Deleted Bot', exact: true })).toBeVisible();
  await expect(page.getByText('2030-02-01T00:00:00.000Z', { exact: true })).toBeVisible();
  await page.goto(`/app/workspaces/${workspaceId}/bots`);
  await expect(page.getByRole('list', { name: 'Bots', exact: true })).not.toContainText(
    'Lifecycle helper',
  );
  await page.getByRole('link', { name: 'Deleted Bots and recovery', exact: true }).click();
  await page.getByRole('link', { name: 'Lifecycle helper', exact: true }).click();
  await page.getByRole('button', { name: 'Undo deletion', exact: true }).click();
  await expect(page.getByText('Current state: active', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Bot', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  await expect(page.locator('pre')).toHaveText('Retained protected instructions');
  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__bot/viewer`);
  await page.request.post(`${api}/__bot/state`, { data: { discoverable: true } });
  const guestPage = await guest.newPage();
  expect(
    (await guestPage.goto(`/app/workspaces/${workspaceId}/bots/${bot.id}/lifecycle`))?.status(),
  ).toBe(403);
  await guestPage.goto(`/app/workspaces/${workspaceId}/bots/${bot.id}`);
  await expect(guestPage.getByRole('link', { name: 'Manage lifecycle' })).toHaveCount(0);
  await guest.close();
  expect(errors).toEqual([]);
});
test('reports an expired window and an unconfirmed mutation while retaining historical identity', async ({
  page,
}) => {
  const bot = await setup(page);
  await page.getByRole('link', { name: 'Manage lifecycle', exact: true }).click();
  await page.request.post(`${api}/__bot/state`, { data: { uncertainLifecycle: true } });
  await page.getByRole('button', { name: 'Archive Bot', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await page.reload();
  await expect(page.getByText('Current state: archived', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Bot', exact: true }).click();
  await page.request.post(`${api}/__bot/state`, { data: { now: '2030-02-01T00:00:00.000Z' } });
  await page.getByRole('button', { name: 'Undo deletion', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('recovery deadline has passed');
  await expect(page.getByText('Current state: deleted', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Bot', exact: true }).click();
  await expect(
    page.getByText('Deleted Bot · Historical identity retained', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`Bot ID: ${bot.id}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
});
