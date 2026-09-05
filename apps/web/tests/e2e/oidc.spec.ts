import { expect, test } from '@playwright/test';
test('links explicitly, signs in, registers by invitation, and rejects invalid state and callback replay', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Security settings', exact: true }).click();
  await page.getByRole('button', { name: 'Link OIDC identity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mock identity provider' })).toBeVisible();
  const savedBrowserCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'openbot_oidc',
  )!;
  expect(savedBrowserCookie.httpOnly).toBe(true);
  expect(savedBrowserCookie.sameSite).toBe('Lax');
  let callbackUrl = '';
  page.on('request', (event) => {
    if (event.url().includes('/auth/oidc/callback?')) callbackUrl = event.url();
  });
  await page.getByRole('button', { name: 'Continue as test identity' }).click();
  await expect(page).toHaveURL(/\/app\/security$/u);
  await expect(page.getByText('OIDC identity linked.', { exact: true })).toBeVisible();
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'openbot_oidc')).toBe(
    false,
  );
  expect(callbackUrl).toContain('code=');
  const replay = await browser.newContext();
  await replay.addCookies([savedBrowserCookie]);
  const replayPage = await replay.newPage();
  await replayPage.goto(callbackUrl);
  await expect(replayPage).toHaveURL(/\/sign-in\?oidcError=invalid_flow$/u);
  await expect(replayPage.getByRole('alert')).toBeVisible();
  await replay.close();
  await page.goto('/app');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with OIDC', exact: true }).click();
  await page.getByRole('button', { name: 'Continue as test identity' }).click();
  await expect(page.getByRole('heading', { name: 'My Workspace', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Manage invitations', exact: true }).click();
  await page.getByLabel('Invited email').fill('grace@example.com');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const invitation = await page.getByLabel('Invitation link', { exact: true }).inputValue();
  await request.post('http://127.0.0.1:4399/__oidc/claims', {
    data: { sub: 'grace-subject', email: 'grace@example.com', email_verified: true, name: 'Grace' },
  });
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  guestPage.on('pageerror', (error) => errors.push(error.message));
  await guestPage.goto(invitation);
  await guestPage.getByRole('button', { name: 'Join with OIDC', exact: true }).click();
  await guestPage.getByRole('button', { name: 'Continue as test identity' }).click();
  await expect(guestPage.getByText('Grace', { exact: true })).toBeVisible();
  await expect(guestPage.getByText('Your role: member', { exact: true })).toBeVisible();
  await guestPage.getByRole('link', { name: 'Security settings', exact: true }).click();
  await expect(guestPage.getByText('OIDC identity linked.', { exact: true })).toBeVisible();
  await expect(
    guestPage.getByRole('button', { name: 'Unlink OIDC identity', exact: true }),
  ).toBeDisabled();
  await guest.close();
  const invalid = await browser.newContext();
  const invalidPage = await invalid.newPage();
  await invalidPage.goto('/sign-in');
  await invalidPage.getByRole('button', { name: 'Sign in with OIDC', exact: true }).click();
  await invalidPage.locator('input[name="state"]').evaluate((input: HTMLInputElement) => {
    input.value = 'x'.repeat(43);
  });
  await invalidPage.getByRole('button', { name: 'Continue as test identity' }).click();
  await expect(invalidPage).toHaveURL(/\/sign-in\?oidcError=invalid_flow$/u);
  await expect(invalidPage.getByRole('alert')).toBeVisible();
  await invalid.close();
  const counts = await (await request.get('http://127.0.0.1:4399/__oidc/counts')).json();
  expect(counts.users).toBe(2);
  expect(counts.identities).toBe(2);
  await page.goto('/app/security');
  await page.getByRole('button', { name: 'Unlink OIDC identity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Link OIDC identity', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
