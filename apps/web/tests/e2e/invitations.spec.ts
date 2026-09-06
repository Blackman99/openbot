import { expect, test } from '@playwright/test';

test('invites a second user, joins the same workspace, signs in for a later invitation, and rejects revoked links', async ({
  page,
  browser,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post('http://127.0.0.1:4399/__scenario', { data: { scenario: 'unclaimed' } });
  await page.goto('/setup');
  await page.getByLabel('Display name').fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
  await page.getByRole('button', { name: 'Create owner' }).click();
  await page.getByRole('link', { name: 'Manage invitations' }).click();
  await page.getByLabel('Invited email').fill('grace@example.com');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const invitationLink = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  expect(invitationLink).toMatch(/\/join#token=[A-Za-z0-9_-]{43}$/u);
  const guest = await browser.newContext();
  const joinPage = await guest.newPage();
  joinPage.on('pageerror', (error) => errors.push(error.message));
  const seenUrls: string[] = [];
  joinPage.on('request', (request) => seenUrls.push(request.url()));
  await joinPage.goto(invitationLink);
  await expect(joinPage).toHaveURL(/\/join$/u);
  await joinPage.getByLabel('Display name').fill('Grace Hopper');
  await joinPage.getByLabel('Invited email').fill('grace@example.com');
  await joinPage
    .getByLabel('New password', { exact: true })
    .fill('second correct horse battery staple');
  const acceptanceResponse = joinPage.waitForResponse((response) =>
    response.url().includes('/join?/accept'),
  );
  await joinPage.getByRole('button', { name: 'Create account and join', exact: true }).click();
  const reply = await acceptanceResponse;
  expect(await reply.request().headerValue('origin')).toBe('http://127.0.0.1:4173');
  expect(reply.ok()).toBe(true);
  await expect(joinPage).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
  await expect(joinPage.getByRole('heading', { level: 1 })).toHaveText('My Workspace');
  await expect(joinPage.getByText('Grace Hopper', { exact: true })).toBeVisible();
  await expect(joinPage.getByText('Your role: member', { exact: true })).toBeVisible();
  await expect(joinPage.getByRole('link', { name: 'Manage invitations' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Invitation link', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Back to My Workspace' }).click();
  await page.getByLabel('New workspace name').fill('Research');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/workspace-2$/u);
  await page.getByRole('link', { name: 'Manage invitations' }).click();
  await page.getByLabel('Invited email').fill('grace@example.com');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const secondLink = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  const signOutResponse = joinPage.waitForResponse((response) =>
    response.url().includes('?/signOut'),
  );
  await joinPage.getByRole('button', { name: 'Sign out', exact: true }).click();
  const signOutReply = await signOutResponse;
  expect(await signOutReply.request().headerValue('origin')).toBe('http://127.0.0.1:4173');
  await expect(joinPage).toHaveURL(/\/sign-in$/u);
  await joinPage.goto(secondLink);
  await joinPage.getByLabel('Account email').fill('grace@example.com');
  await joinPage.getByLabel('Account password').fill('second correct horse battery staple');
  await joinPage.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(joinPage.getByText('Signed in as grace@example.com', { exact: true })).toBeVisible();
  await joinPage.getByRole('button', { name: 'Join workspace', exact: true }).click();
  await expect(joinPage).toHaveURL(/\/app\/workspaces\/workspace-2$/u);
  await expect(joinPage.getByRole('heading', { level: 1 })).toHaveText('Research');

  await page.getByLabel('Invited email').fill('revoked@example.com');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const revokedLink = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Revoke invitation for revoked@example.com' }).click();
  await expect(page.getByRole('status')).toHaveText('Invitation revoked.');
  await joinPage.goto(revokedLink);
  await joinPage.getByRole('button', { name: 'Join workspace', exact: true }).click();
  await expect(joinPage.getByRole('alert')).toContainText('This invitation is unavailable');
  expect(seenUrls.some((url) => url.includes('token='))).toBe(false);
  expect(errors).toEqual([]);
  await guest.close();
});
