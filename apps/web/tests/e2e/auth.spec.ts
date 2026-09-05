import { expect, test } from '@playwright/test';

test.describe('local owner authentication', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:4399/__scenario', {
      data: { scenario: 'unclaimed' },
    });
  });

  test('claims the instance, persists the session, signs out, and signs back in', async ({
    context,
    page,
  }) => {
    await page.goto('/setup');
    await page.getByLabel('Display name').fill('Ada Lovelace');
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
    await page.getByRole('button', { name: 'Create owner' }).click();

    await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Workspace');
    await expect(page.getByText('Ada Lovelace')).toBeVisible();

    const session = (await context.cookies()).find(({ name }) => name === 'openbot_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false });
    expect(session?.expires).toBeGreaterThan(Date.now() / 1_000);

    await page.reload();
    await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/u);

    await page.goto('/app');
    await expect(page).toHaveURL(/\/sign-in$/u);

    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
  });

  test('rejects a second setup and handles invalid credentials without exposing the password', async ({
    page,
  }) => {
    await page.goto('/setup');
    await page.getByLabel('Display name').fill('Ada Lovelace');
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
    await page.getByRole('button', { name: 'Create owner' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.goto('/setup');
    await expect(page).toHaveURL(/\/sign-in$/u);
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password').fill('wrong password value');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await expect(page.locator('body')).not.toContainText('wrong password value');
    await expect(page.getByLabel('Password')).toHaveValue('');
  });
});
