import { expect, test } from '@playwright/test';

test('manages current member roles, enforces removal immediately, and preserves the removed account session', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(60_000);
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
    data: { email: 'grace@example.com', role: 'member', expiresInDays: 7 },
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
  await guestPage.goto('/app/workspaces/workspace-id/members');
  await expect(guestPage.getByText('Invited by Ada Lovelace', { exact: true })).toBeVisible();
  await expect(guestPage.getByRole('button', { name: /Change role/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Workspace members', exact: true }).click();
  await expect(page.getByText('Direct membership', { exact: true })).toBeVisible();
  await expect(page.getByText(/Assign another owner first/)).toBeVisible();
  await page.getByLabel('Role for Grace Hopper', { exact: true }).selectOption('administrator');
  await page.getByRole('button', { name: 'Change role for Grace Hopper', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Grace Hopper is now an administrator.');
  await guestPage.reload();
  await expect(guestPage.getByLabel('Role for Grace Hopper', { exact: true })).toHaveValue(
    'administrator',
  );
  await expect(
    guestPage.getByRole('button', { name: 'Change role for Ada Lovelace', exact: true }),
  ).toHaveCount(0);
  await expect(
    guestPage.getByLabel('Role for Grace Hopper', { exact: true }).locator('option[value="owner"]'),
  ).toHaveCount(0);
  const forbidden = await guest.request.patch(
    `${api}/api/v1/workspaces/workspace-id/members/user-id`,
    { headers: { origin }, data: { role: 'member' } },
  );
  expect(forbidden.status()).toBe(403);

  await page.getByLabel('Role for Grace Hopper', { exact: true }).selectOption('owner');
  await page.getByRole('button', { name: 'Change role for Grace Hopper', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Grace Hopper is now an owner.');
  await guestPage.reload();
  await guestPage
    .getByLabel('Role for Grace Hopper', { exact: true })
    .selectOption('administrator');
  await guestPage
    .getByRole('button', { name: 'Change role for Grace Hopper', exact: true })
    .click();
  await expect(guestPage.getByRole('status')).toHaveText('Grace Hopper is now an administrator.');
  await expect(
    guestPage.getByRole('button', { name: 'Change role for Ada Lovelace', exact: true }),
  ).toHaveCount(0);

  const cookieBeforeRemoval = (await guest.cookies()).find(
    (cookie) => cookie.name === 'openbot_session',
  )?.value;
  expect(cookieBeforeRemoval).toBeTruthy();
  await page.reload();
  await page.getByText('Remove Grace Hopper', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove Grace Hopper from workspace', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Member removed from this workspace');
  await expect(page.getByText('grace@example.com', { exact: true })).toHaveCount(0);
  expect((await guest.request.get(`${api}/api/v1/workspaces/workspace-id`)).status()).toBe(403);
  expect((await guest.request.get(`${api}/api/v1/workspaces/workspace-id/members`)).status()).toBe(
    403,
  );
  const identity = await guest.request.get(`${api}/api/v1/me`);
  expect(identity.status()).toBe(200);
  expect(await identity.json()).toMatchObject({
    user: { email: 'grace@example.com' },
    workspace: null,
  });
  expect((await guestPage.reload())?.status()).toBe(403);
  expect((await guest.cookies()).find((cookie) => cookie.name === 'openbot_session')?.value).toBe(
    cookieBeforeRemoval,
  );

  const reInvite = await page.request.post(`${api}/api/v1/workspaces/workspace-id/invitations`, {
    headers: { origin },
    data: { email: 'grace@example.com', role: 'administrator', expiresInDays: 7 },
  });
  expect(reInvite.status()).toBe(201);
  expect(
    (
      await guest.request.post(`${api}/api/v1/invitations/accept`, {
        headers: { origin },
        data: { token: (await reInvite.json()).token },
      })
    ).status(),
  ).toBe(200);
  await guestPage.goto('/app/workspaces/workspace-id/members');
  await guestPage.getByText('Remove Grace Hopper', { exact: true }).click();
  await guestPage
    .getByRole('button', { name: 'Remove Grace Hopper from workspace', exact: true })
    .click();
  await expect(guestPage).toHaveURL(/\/app$/u);
  await expect(guestPage.getByRole('heading', { name: '403', exact: true })).toBeVisible();
  expect((await guest.request.get(`${api}/api/v1/me`)).status()).toBe(200);
  expect((await guest.cookies()).find((cookie) => cookie.name === 'openbot_session')?.value).toBe(
    cookieBeforeRemoval,
  );
  expect(errors).toEqual([]);
  await guest.close();
});
