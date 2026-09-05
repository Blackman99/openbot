import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';

test('round-trips a public Bot through the real UI, preserves its avatar and history, rejects stale writes and archives the same identity', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const setup = await page.request.post(`${api}/__public-bot/setup`);
  expect(setup.status()).toBe(201);
  const { workspaceId, modelBinding, userId } = await setup.json();
  const tokenResponse = await page.request.post(
    `${api}/api/v1/workspaces/${workspaceId}/api-tokens`,
    {
      headers: { origin },
      data: {
        name: 'Browser public client',
        scopes: ['bots:read', 'bots:write'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  );
  expect(tokenResponse.status()).toBe(201);
  const token = await tokenResponse.json();
  const headers = { authorization: `Bearer ${token.secret}` };
  const configuration = {
    name: 'Public researcher',
    roleDescription: 'Research role',
    description: 'Created through the public API',
    instructions: '  Public instructions\nPreserve this whitespace.',
    modelBinding,
    limits: { maxTotalTokens: 19000, maxDurationSeconds: 250, maxTurns: 9, maxDelegationDepth: 2 },
  };
  const created = await request.post(`${api}/v1/bots`, { headers, data: configuration });
  expect(created.status()).toBe(201);
  const initial = (await created.json()).bot;
  expect(initial.currentVersion.configuration).toEqual(configuration);
  expect(initial.currentVersion.author.id).toBe(userId);
  const publicPath = `${api}/v1/bots/${initial.id}`;
  const path = `/app/workspaces/${workspaceId}/bots/${initial.id}`;
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Public researcher', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  await expect(page.locator('pre')).toHaveText(configuration.instructions);
  await page.getByLabel('Avatar image', { exact: true }).setInputFiles({
    name: 'public-avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Upload avatar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible();
  const withAvatar = (await (await request.get(publicPath, { headers })).json()).bot.currentVersion;
  expect(withAvatar.configuration.avatarObjectId).toBeTruthy();
  await page.getByRole('link', { name: 'Edit configuration', exact: true }).click();
  await page.getByLabel('Bot name', { exact: true }).fill('UI researcher');
  await page.getByLabel('Role description', { exact: true }).fill('Evidence reviewer');
  await page.getByLabel('Description', { exact: true }).fill('Description edited in the UI');
  const instructions = 'UI instructions ✓\n  Preserve spacing.\n\nSecond paragraph.';
  await page.getByLabel('System instructions', { exact: true }).fill(instructions);
  await page.getByLabel('Total token limit', { exact: true }).fill('22345');
  await page.getByLabel('Duration limit (seconds)', { exact: true }).fill('123');
  await page.getByLabel('Turn limit', { exact: true }).fill('11');
  await page.getByLabel('Delegation depth limit', { exact: true }).fill('3');
  await page.getByLabel('Rationale (optional)', { exact: true }).fill('UI round trip');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Version 3', exact: true })).toBeVisible();
  const uiVersion = (await (await request.get(publicPath, { headers })).json()).bot.currentVersion;
  expect(uiVersion.configuration).toEqual({
    ...configuration,
    name: 'UI researcher',
    roleDescription: 'Evidence reviewer',
    description: 'Description edited in the UI',
    instructions,
    avatarObjectId: withAvatar.configuration.avatarObjectId,
    limits: { maxTotalTokens: 22345, maxDurationSeconds: 123, maxTurns: 11, maxDelegationDepth: 3 },
  });
  const updated = await request.patch(publicPath, {
    headers,
    data: {
      expectedCurrentVersionId: uiVersion.id,
      changes: { description: 'Public description after UI edit' },
      rationale: 'Public round trip',
    },
  });
  expect(updated.status()).toBe(200);
  const publicVersion = (await updated.json()).version;
  expect(publicVersion.configuration).toEqual({
    ...uiVersion.configuration,
    description: 'Public description after UI edit',
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Version 4', exact: true })).toBeVisible();
  await expect(page.getByText('Public description after UI edit', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Avatar for UI researcher', exact: true }),
  ).toBeVisible();
  const stale = await request.patch(publicPath, {
    headers,
    data: { expectedCurrentVersionId: uiVersion.id, changes: { name: 'Must not overwrite' } },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toEqual({ error: { code: 'bot_version_conflict' } });
  expect((await (await request.get(publicPath, { headers })).json()).bot.currentVersion).toEqual(
    publicVersion,
  );
  const firstPage = await (await request.get(`${publicPath}/versions?limit=2`, { headers })).json();
  expect(firstPage.versions.map((version: { number: number }) => version.number)).toEqual([4, 3]);
  const secondPage = await (
    await request.get(`${publicPath}/versions?limit=2&before=${firstPage.nextBefore}`, { headers })
  ).json();
  expect(secondPage.versions.map((version: { number: number }) => version.number)).toEqual([2, 1]);
  expect(secondPage.nextBefore).toBeNull();
  expect(
    (await (await request.get(`${publicPath}/versions/${withAvatar.id}`, { headers })).json())
      .version,
  ).toEqual(withAvatar);
  await page.goto(`${path}/versions/${withAvatar.id}`);
  await expect(
    page.getByRole('img', { name: 'Avatar for Public researcher', exact: true }),
  ).toBeVisible();
  const archived = await request.post(`${publicPath}/archive`, { headers });
  expect(archived.status()).toBe(200);
  expect((await archived.json()).lifecycle).toMatchObject({ botId: initial.id, state: 'archived' });
  await page.goto(path);
  await expect(page.getByText('Archived Bot · New work blocked', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Version 4', exact: true })).toBeVisible();
  expect((await (await request.get(publicPath, { headers })).json()).bot.currentVersion).toEqual(
    publicVersion,
  );
  expect(await page.content()).not.toMatch(
    /browser-provider-key-sentinel|browser-provider-header-sentinel|ciphertext|sealed_credentials/u,
  );
  expect(
    JSON.stringify([initial, withAvatar, uiVersion, publicVersion, firstPage, secondPage]),
  ).not.toMatch(
    /browser-provider-key-sentinel|browser-provider-header-sentinel|token_digest|ciphertext|sealed_credentials/u,
  );
  expect(
    (
      await page.request.delete(
        `${api}/api/v1/workspaces/${workspaceId}/api-tokens/${token.token.id}`,
        { headers: { origin } },
      )
    ).status(),
  ).toBe(204);
  const revoked = await request.get(publicPath, { headers });
  expect(revoked.status()).toBe(401);
  expect(await revoked.json()).toEqual({ error: { code: 'invalid_api_token' } });
  expect(errors).toEqual([]);
});
