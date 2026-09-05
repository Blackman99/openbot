import { expect, test } from '@playwright/test';

test('creates, switches and refreshes isolated workspace contexts, edits settings and recovers an invalid route', async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await request.post('http://127.0.0.1:4399/__scenario', { data: { scenario: 'unclaimed' } });
  await page.goto('/setup');
  await page.getByLabel('Display name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
  await page.getByRole('button', { name: 'Create owner' }).click();
  await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
  await page.getByLabel('New workspace name').fill('Research');
  await page.getByLabel('New workspace description').fill('Private research context');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Research');
  const researchUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(researchUrl);
  await expect(page.getByLabel('Workspace description', { exact: true })).toHaveValue(
    'Private research context',
  );
  await page.getByRole('link', { name: 'My Workspace', exact: true }).click();
  await expect(page.getByLabel('Workspace description', { exact: true })).toHaveValue('');
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(page).toHaveURL(researchUrl);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Research');
  await page.getByLabel('Workspace name', { exact: true }).fill('Research team');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Workspace settings saved.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Research team');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Research team');
  await expect(page.getByLabel('Workspace name', { exact: true })).toHaveValue('Research team');
  await page.goto('/app/workspaces/not-accessible');
  await expect(page).toHaveURL(/\/app\/workspaces\/workspace-id$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Workspace');
  expect(browserErrors).toEqual([]);
});
