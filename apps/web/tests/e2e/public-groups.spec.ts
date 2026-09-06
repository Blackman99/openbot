import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';

test('round-trips a public group and membership through the real UI', async ({ page, request }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const setup = await page.request.post(`${api}/__public-group/setup`);
  expect(setup.status()).toBe(201);
  const { workspaceId } = await setup.json();
  const tokenResponse = await page.request.post(
    `${api}/api/v1/workspaces/${workspaceId}/api-tokens`,
    {
      headers: { origin },
      data: {
        name: 'Browser public group client',
        scopes: ['groups:read', 'groups:write'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  );
  expect(tokenResponse.status()).toBe(201);
  const token = await tokenResponse.json();
  const headers = { authorization: `Bearer ${token.secret}` };
  const created = await request.post(`${api}/v1/groups`, {
    headers,
    data: { name: 'Public research', description: 'Created through the public API' },
  });
  expect(created.status()).toBe(201);
  const group = (await created.json()).group;
  expect(group.name).toBe('Public research');
  await page.goto(`/app/workspaces/${workspaceId}/groups/${group.id}`);
  await expect(page.getByRole('heading', { name: 'Public research', exact: true })).toBeVisible();
  await expect(page.getByText('Created through the public API')).toBeVisible();
  const invite = await page.request.post(`${api}/api/v1/workspaces/${workspaceId}/invitations`, {
    headers: { origin },
    data: { email: 'member@example.com', role: 'member', expiresInDays: 7 },
  });
  expect(invite.status()).toBe(201);
  const accepted = await request.post(`${api}/api/v1/invitations/accept`, {
    headers: { origin },
    data: {
      token: (await invite.json()).token,
      email: 'member@example.com',
      displayName: 'Casey Member',
      password: 'second correct horse battery staple',
    },
  });
  expect(accepted.status()).toBe(201);
  const memberId = (await accepted.json()).user.id;
  const added = await request.post(`${api}/v1/groups/${group.id}/members`, {
    headers,
    data: { userId: memberId, role: 'member' },
  });
  expect(added.status()).toBe(201);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Casey Member', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
