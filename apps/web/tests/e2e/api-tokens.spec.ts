import { expect, test } from '@playwright/test';
test('creates, copies once, inspects and revokes a workspace API token', async ({
  page,
  request,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post('http://127.0.0.1:4399/__scenario', { data: { scenario: 'unclaimed' } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/setup');
  await page.getByLabel('Display name').fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
  await page.getByRole('link', { name: 'API tokens', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();
  await page.getByLabel('Token name', { exact: true }).fill('Scheduled reports');
  await page.getByLabel('bots:read', { exact: true }).check();
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  const secret = await page.getByLabel('One-time token', { exact: true }).inputValue();
  expect(secret).toMatch(/^ob_[A-Za-z0-9_-]{43}$/u);
  await page.getByRole('button', { name: 'Copy token', exact: true }).click();
  await expect(page.getByText('Token copied.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  expect(
    (
      await request.get('http://127.0.0.1:4399/v1/me', {
        headers: { authorization: `Bearer ${secret}` },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await expect(page.getByLabel('One-time token', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Scheduled reports', exact: true })).toBeVisible();
  await expect(page.getByText('me:read, bots:read', { exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(secret);
  await page.getByRole('button', { name: 'Revoke Scheduled reports', exact: true }).click();
  await expect(
    page.getByText('Token revoked. It can no longer access the API.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Revoke Scheduled reports', exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await request.get('http://127.0.0.1:4399/v1/me', {
        headers: { authorization: `Bearer ${secret}` },
      })
    ).status(),
  ).toBe(401);
  expect(errors).toEqual([]);
});
