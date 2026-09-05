import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const graceId = 'bb661304-a1bc-4767-9a87-c47de763f749';
const base = `/app/workspaces/${workspaceId}/bots`;
const detail = `${base}/${botId}`;
const permissions = `${detail}/permissions`;

test('owners manage independent Bot roles and discovery; last-owner and next-request revocation preserve sessions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  expect((await page.request.post(`${api}/__bot-acl/setup`)).status()).toBe(200);
  await page.goto(detail);
  await page.getByRole('link', { name: 'Manage permissions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permissions for Researcher' })).toBeVisible();
  const ada = page.getByRole('region', { name: 'Access for Ada', exact: true });
  await ada.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('owner with current workspace access');
  const lin = page.getByRole('region', { name: 'Access for Lin', exact: true });
  await expect(lin).toContainText('No current workspace access');
  await lin.getByLabel('Role for Lin', { exact: true }).selectOption('editor');
  await lin.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(
    lin.getByLabel('Role for Lin', { exact: true }).locator('option[value="owner"]'),
  ).toBeDisabled();
  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__bot-acl/viewer`);
  const guestPage = await guest.newPage();
  guestPage.on('pageerror', (error) => errors.push(error.message));
  const guestCookie = (await guest.cookies()).find(
    (cookie) => cookie.name === 'openbot_session',
  )?.value;
  await guestPage.goto(base);
  await expect(guestPage.getByRole('link', { name: 'Researcher', exact: true })).toHaveCount(0);
  expect((await guestPage.goto(detail))?.status()).toBe(403);
  expect((await guestPage.goto(permissions))?.status()).toBe(403);
  expect((await guest.cookies()).find((cookie) => cookie.name === 'openbot_session')?.value).toBe(
    guestCookie,
  );
  await page.getByLabel('Who can discover this Bot?', { exact: true }).selectOption('workspace');
  await page.getByRole('button', { name: 'Save discovery settings', exact: true }).click();
  await guestPage.goto(detail);
  await expect(
    guestPage.getByText('Only Bot metadata is available.', { exact: false }),
  ).toBeVisible();
  await expect(
    guestPage.getByRole('heading', { name: 'System instructions', exact: true }),
  ).toHaveCount(0);
  await expect(
    guestPage.getByRole('link', { name: 'Manage permissions', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Workspace member', { exact: true }).selectOption(graceId);
  await expect(page.getByLabel('Bot role', { exact: true })).toHaveValue('user');
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Grace now has user access.');
  await guestPage.reload();
  await expect(guestPage.locator('pre')).toHaveText('Private review instructions.');
  await expect(guestPage.getByText('Your Bot role: user', { exact: true })).toBeVisible();
  expect((await guestPage.goto(permissions))?.status()).toBe(403);
  const grace = page.getByRole('region', { name: 'Access for Grace', exact: true });
  await grace.getByLabel('Role for Grace', { exact: true }).selectOption('editor');
  await grace.getByRole('button', { name: 'Save role', exact: true }).click();
  await guestPage.goto(detail);
  await expect(guestPage.getByText('Your Bot role: editor', { exact: true })).toBeVisible();
  await expect(
    guestPage.getByRole('link', { name: 'Manage permissions', exact: true }),
  ).toHaveCount(0);
  expect((await guestPage.goto(permissions))?.status()).toBe(403);
  await grace.getByLabel('Role for Grace', { exact: true }).selectOption('owner');
  await grace.getByRole('button', { name: 'Save role', exact: true }).click();
  await guestPage.goto(permissions);
  await expect(
    guestPage.getByRole('heading', { name: 'Permissions for Researcher' }),
  ).toBeVisible();
  await ada.getByLabel('Role for Ada', { exact: true }).selectOption('editor');
  await ada.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${detail}$`, 'u'));
  await expect(page.getByText('Your Bot role: editor', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage permissions', exact: true })).toHaveCount(0);
  const guestGrace = guestPage.getByRole('region', { name: 'Access for Grace', exact: true });
  await guestGrace.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await expect(guestPage.getByRole('alert')).toContainText('owner with current workspace access');
  const guestAda = guestPage.getByRole('region', { name: 'Access for Ada', exact: true });
  await guestAda.getByLabel('Role for Ada', { exact: true }).selectOption('owner');
  await guestAda.getByRole('button', { name: 'Save role', exact: true }).click();
  await page.goto(permissions);
  await expect(page.getByRole('heading', { name: 'Permissions for Researcher' })).toBeVisible();
  const ownerCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'openbot_session',
  )?.value;
  await guestPage.getByLabel('Who can discover this Bot?', { exact: true }).selectOption('private');
  await guestPage.getByRole('button', { name: 'Save discovery settings', exact: true }).click();
  await guestAda.getByRole('button', { name: 'Revoke access', exact: true }).click();
  expect((await page.reload())?.status()).toBe(403);
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'openbot_session')?.value,
  ).toBe(ownerCookie);
  expect((await page.request.get(`${api}/api/v1/me`)).status()).toBe(200);
  expect((await page.goto(detail))?.status()).toBe(403);
  const state = await (await request.get(`${api}/__bot-acl/state`)).json();
  expect(state.version).toBe(1);
  expect(state.audits).toEqual(
    expect.arrayContaining([
      'bot.acl_granted',
      'bot.acl_role_changed',
      'bot.acl_revoked',
      'bot.visibility_changed',
    ]),
  );
  expect(errors).toEqual([]);
  await guest.close();
});

test('workspace removal disables retained Bot grants; rejoin restores them and self-revocation returns to the list', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(60_000);
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-acl/setup`);
  await page.goto(permissions);
  await page.getByLabel('Workspace member', { exact: true }).selectOption(graceId);
  await page.getByLabel('Bot role', { exact: true }).selectOption('owner');
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__bot-acl/viewer`);
  const guestPage = await guest.newPage();
  await guestPage.goto(permissions);
  const cookie = (await guest.cookies()).find((item) => item.name === 'openbot_session')?.value;
  await request.post(`${api}/__bot-acl/state`, { data: { graceWorkspaceAccess: false } });
  expect((await guestPage.reload())?.status()).toBe(403);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  const identity = await guest.request.get(`${api}/api/v1/me`);
  expect(identity.status()).toBe(200);
  expect((await identity.json()).workspace).toBeNull();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Access for Grace', exact: true })).toContainText(
    'No current workspace access',
  );
  await page
    .getByRole('region', { name: 'Access for Ada', exact: true })
    .getByRole('button', { name: 'Revoke access', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('owner with current workspace access');
  await request.post(`${api}/__bot-acl/state`, { data: { graceWorkspaceAccess: true } });
  await guestPage.reload();
  await expect(
    guestPage.getByRole('heading', { name: 'Permissions for Researcher' }),
  ).toBeVisible();
  await guestPage
    .getByRole('region', { name: 'Access for Grace', exact: true })
    .getByRole('button', { name: 'Revoke access', exact: true })
    .click();
  await expect(guestPage).toHaveURL(new RegExp(`${base}$`, 'u'));
  await expect(guestPage.getByRole('link', { name: 'Researcher', exact: true })).toHaveCount(0);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  expect((await guestPage.goto(permissions))?.status()).toBe(403);
  await guest.close();
});
