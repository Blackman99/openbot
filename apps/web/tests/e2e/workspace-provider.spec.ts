import { expect, test } from '@playwright/test';

test('shares model usage with members while administrators manage credentials and availability', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const api = 'http://127.0.0.1:4399';
  const origin = 'http://127.0.0.1:4173';
  const base = `${api}/api/v1/workspaces/workspace-id/model-connections`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.goto('/setup');
  await page.getByLabel('Display name').fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page).toHaveURL('/app/workspaces/workspace-id');
  await page.getByRole('link', { name: 'Workspace models', exact: true }).click();
  const add = page.getByRole('region', { name: 'Add a shared model' });
  await add.getByLabel('Name', { exact: true }).fill('Shared model');
  await add.getByLabel('Protocol').selectOption('openai-responses');
  await add.getByLabel('Base URL').fill('https://models.example/v1');
  await add.getByLabel('Model ID').fill('shared-model');
  await add.getByLabel('API key', { exact: true }).fill('workspace-api-secret');
  await add.getByLabel('Custom headers (JSON)').fill('{"x-secret":"workspace-header-secret"}');
  await add.getByRole('button', { name: 'Test and save' }).click();
  const ownerModel = page.getByRole('article', { name: 'Shared model', exact: true });
  await expect(ownerModel).toContainText('OpenAI Responses');
  await expect(ownerModel).toContainText('API key: configured');
  expect(await page.content()).not.toMatch(/workspace-api-secret|workspace-header-secret/u);

  const invite = await page.request.post(`${api}/api/v1/workspaces/workspace-id/invitations`, {
    headers: { origin },
    data: { email: 'grace@example.com', role: 'member', expiresInDays: 7 },
  });
  expect(invite.status()).toBe(201);
  const guest = await browser.newContext({ baseURL: origin });
  try {
    const joined = await guest.request.post(`${api}/api/v1/invitations/accept`, {
      headers: { origin },
      data: {
        token: (await invite.json()).token,
        email: 'grace@example.com',
        displayName: 'Grace',
        password: 'second correct horse battery staple',
      },
    });
    expect(joined.status()).toBe(201);
    const guestPage = await guest.newPage();
    guestPage.on('pageerror', (error) => errors.push(error.message));
    await guestPage.goto('/app/workspaces/workspace-id');
    await guestPage.getByRole('link', { name: 'Workspace models', exact: true }).click();
    const shared = guestPage.getByRole('article', { name: 'Shared model', exact: true });
    await expect(shared).toContainText('Text stream: passed');
    await expect(guestPage.getByRole('button', { name: 'Test and save' })).toHaveCount(0);
    await expect(guestPage.getByRole('button', { name: 'Disable', exact: true })).toHaveCount(0);
    expect(await guestPage.content()).not.toMatch(
      /models\.example|x-secret|workspace-api-secret|workspace-header-secret|Test evidence/u,
    );
    const metadata = await (await guest.request.get(base)).json();
    expect(metadata.canManage).toBe(false);
    expect(Object.keys(metadata.connections[0]).sort()).toEqual([
      'availability',
      'id',
      'lastProbe',
      'modelId',
      'name',
      'protocol',
    ]);
    const id = metadata.connections[0].id;
    expect(
      (
        await guest.request.put(`${base}/${id}`, {
          headers: { origin },
          data: { apiKey: 'forged-secret' },
        })
      ).status(),
    ).toBe(403);
    await shared.getByRole('button', { name: 'Test again' }).click();
    await expect(guestPage.getByRole('status')).toHaveText('Connection test completed.');

    expect(
      (
        await page.request.patch(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
          headers: { origin },
          data: { role: 'administrator' },
        })
      ).status(),
    ).toBe(200);
    await guestPage.reload();
    await expect(guestPage.getByRole('region', { name: 'Add a shared model' })).toBeVisible();
    await shared.getByText('Edit connection', { exact: true }).click();
    await expect(shared.getByLabel('API key', { exact: true })).toHaveValue('');
    await shared.getByLabel('Protocol').selectOption('anthropic-messages');
    await shared.getByLabel('Anthropic version').fill('2023-01-01');
    await shared.getByRole('button', { name: 'Test and save' }).click();
    await expect(shared).toContainText('Anthropic Messages');
    await expect(shared).toContainText('API key: configured');
    await page.reload();
    await ownerModel.getByText('Edit connection', { exact: true }).click();
    await expect(ownerModel.getByLabel('Anthropic version')).toHaveValue('2023-01-01');
    await ownerModel.getByLabel('Protocol').selectOption('openai-chat');
    await ownerModel.getByRole('button', { name: 'Test and save' }).click();
    await expect(ownerModel).toContainText('OpenAI Chat Completions');
    await guestPage.reload();
    await shared.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(shared).toContainText('Unavailable (disabled)');
    await expect(shared.getByRole('button', { name: 'Test again' })).toBeDisabled();

    expect(
      (
        await page.request.patch(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
          headers: { origin },
          data: { role: 'member' },
        })
      ).status(),
    ).toBe(200);
    await guestPage.reload();
    await expect(guestPage.getByRole('button', { name: 'Test and save' })).toHaveCount(0);
    await expect(shared).toContainText('Unavailable (disabled)');
    expect((await guest.request.post(`${base}/${id}/test`, { headers: { origin } })).status()).toBe(
      409,
    );
    await page.reload();
    await ownerModel.getByText('Edit connection', { exact: true }).click();
    await ownerModel.getByRole('button', { name: 'Test and save' }).click();
    await guestPage.reload();
    await shared.getByRole('button', { name: 'Test again' }).click();
    await expect(guestPage.getByRole('status')).toHaveText('Connection test completed.');

    const session = (await guest.cookies()).find(
      (cookie) => cookie.name === 'openbot_session',
    )?.value;
    expect(
      (
        await page.request.delete(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
          headers: { origin },
        })
      ).status(),
    ).toBe(204);
    expect((await guest.request.get(base)).status()).toBe(403);
    expect((await guest.request.get(`${base}/${id}`)).status()).toBe(403);
    expect((await guest.request.post(`${base}/${id}/test`, { headers: { origin } })).status()).toBe(
      403,
    );
    expect((await guestPage.reload())?.status()).toBe(403);
    expect((await guest.request.get(`${api}/api/v1/me`)).status()).toBe(200);
    expect((await guest.cookies()).find((cookie) => cookie.name === 'openbot_session')?.value).toBe(
      session,
    );
    expect(errors).toEqual([]);
  } finally {
    await guest.close();
  }
});
