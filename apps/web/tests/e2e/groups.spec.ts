import { expect, test } from '@playwright/test';
test('creates groups, applies explicit roles, and preserves retained grants across workspace removal', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const api = 'http://127.0.0.1:4399';
  const origin = 'http://127.0.0.1:4173';
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.goto('/setup');
  await page.getByLabel('Display name').fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
  const invite = await page.request.post(`${api}/api/v1/workspaces/workspace-id/invitations`, {
    headers: { origin },
    data: { email: 'grace@example.com', role: 'administrator', expiresInDays: 7 },
  });
  expect(invite.status()).toBe(201);
  const guest = await browser.newContext({ baseURL: origin });
  const joined = await guest.request.post(`${api}/api/v1/invitations/accept`, {
    headers: { origin },
    data: {
      token: (await invite.json()).token,
      email: 'grace@example.com',
      displayName: 'Grace Hopper',
      password: 'second correct horse battery staple',
    },
  });
  expect(joined.status()).toBe(201);
  const guestPage = await guest.newPage();
  guestPage.on('pageerror', (error) => errors.push(error.message));
  const cookie = (await guest.cookies()).find((item) => item.name === 'openbot_session')?.value;
  await page.getByRole('link', { name: 'Groups', exact: true }).click();
  await expect(page.getByLabel('Visibility', { exact: true })).toHaveValue('private');
  await page.getByLabel('Group name', { exact: true }).fill('Research');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page).toHaveURL(/\/groups\/group-1$/u);
  await expect(
    page.getByText('Assign another eligible owner first', { exact: false }),
  ).toBeVisible();
  await guestPage.goto('/app/workspaces/workspace-id/groups');
  await expect(guestPage.getByRole('link', { name: 'Research', exact: true })).toHaveCount(0);
  expect((await guestPage.goto('/app/workspaces/workspace-id/groups/group-1'))?.status()).toBe(403);
  await page.getByLabel('Visibility', { exact: true }).selectOption('workspace');
  await page.getByLabel('Group name', { exact: true }).fill('Planning');
  await page.getByRole('button', { name: 'Save group settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeVisible();
  await guestPage.reload();
  await expect(
    guestPage.getByText('Only group metadata is available.', { exact: false }),
  ).toBeVisible();
  await expect(guestPage.getByRole('heading', { name: 'Group members', exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel('Workspace member', { exact: true }).selectOption('user-2');
  await page.getByRole('button', { name: 'Add to group', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Grace Hopper added to the group.');
  await guestPage.reload();
  await expect(
    guestPage.getByRole('heading', { name: 'Group members', exact: true }),
  ).toBeVisible();
  await expect(guestPage.getByRole('button', { name: /Change role/ })).toHaveCount(0);
  await page.getByLabel('Group role for Grace Hopper', { exact: true }).selectOption('admin');
  await page.getByRole('button', { name: 'Change role for Grace Hopper', exact: true }).click();
  await guestPage.reload();
  await expect(
    guestPage.getByRole('button', { name: 'Save group settings', exact: true }),
  ).toBeVisible();
  await expect(
    guestPage.getByRole('button', { name: 'Change role for Ada Lovelace', exact: true }),
  ).toHaveCount(0);
  await expect(
    guestPage
      .getByLabel('Group role for Grace Hopper', { exact: true })
      .locator('option[value="owner"]'),
  ).toHaveCount(0);
  await page.getByLabel('Group role for Grace Hopper', { exact: true }).selectOption('owner');
  await page.getByRole('button', { name: 'Change role for Grace Hopper', exact: true }).click();
  expect(
    (
      await page.request.delete(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
        headers: { origin },
      })
    ).status(),
  ).toBe(204);
  await page.reload();
  await expect(page.getByText('No current workspace access.', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove Ada Lovelace from group', exact: true }),
  ).toHaveCount(0);
  expect((await guestPage.reload())?.status()).toBe(403);
  expect((await guest.request.get(`${api}/api/v1/me`)).status()).toBe(200);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  const reInvite = await page.request.post(`${api}/api/v1/workspaces/workspace-id/invitations`, {
    headers: { origin },
    data: { email: 'grace@example.com', role: 'member', expiresInDays: 7 },
  });
  expect(
    (
      await guest.request.post(`${api}/api/v1/invitations/accept`, {
        headers: { origin },
        data: { token: (await reInvite.json()).token },
      })
    ).status(),
  ).toBe(200);
  await guestPage.reload();
  await expect(guestPage.getByText('Your group role: owner', { exact: true })).toBeVisible();
  await guestPage.getByText('Remove Grace Hopper', { exact: true }).click();
  await guestPage
    .getByRole('button', { name: 'Remove Grace Hopper from group', exact: true })
    .click();
  await expect(guestPage).toHaveURL(/\/workspaces\/workspace-id\/groups$/u);
  await guestPage.getByRole('link', { name: 'Planning', exact: true }).click();
  await expect(
    guestPage.getByText('Only group metadata is available.', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('grace@example.com', { exact: true })).toHaveCount(0);
  await page.getByLabel('Visibility', { exact: true }).selectOption('private');
  await page.getByRole('button', { name: 'Save group settings', exact: true }).click();
  expect((await guestPage.reload())?.status()).toBe(403);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  expect(errors).toEqual([]);
  await guest.close();
});
