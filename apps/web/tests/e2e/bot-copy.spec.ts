import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const path = `/app/workspaces/${workspaceId}/bots/${botId}`;
const alternate = JSON.stringify({
  scope: { kind: 'workspace', id: workspaceId },
  connectionId: 'fe661304-a1bc-4767-9a87-c47de763f749',
  modelId: 'alternate-model',
});
test('reviews included and excluded fields, cancels without writes and copies as a direct Bot user with a replacement model', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  await page.request.post(`${api}/__bot-version/viewer`);
  await page.goto(path);
  await page.getByRole('link', { name: 'Copy configuration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Included', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Excluded', exact: true })).toBeVisible();
  for (const text of [
    'Provider credentials and sensitive headers',
    'Permissions and ACLs',
    'Conversation and task history',
    'Memory',
    'File contents',
    'Prior audits',
  ])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm private copy' })).toBeEnabled();
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  expect((await (await request.get(`${api}/__bot-version/state`)).json()).copies).toHaveLength(0);
  await request.post(`${api}/__bot-version/state`, {
    data: { disabledCurrent: true, lifecycleState: 'archived' },
  });
  await page.getByRole('link', { name: 'Copy configuration', exact: true }).click();
  await expect(page.getByText('A replacement is required', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm private copy' })).toBeDisabled();
  await page.getByLabel('Model for the copy').selectOption(alternate);
  await page.getByRole('button', { name: 'Confirm private copy' }).click();
  await expect(page).not.toHaveURL(new RegExp(`${botId}/copy`));
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  await expect(page.getByText('Your Bot role: owner', { exact: true })).toBeVisible();
  await expect(page.getByText('Private', { exact: true })).toBeVisible();
  const state = await (await request.get(`${api}/__bot-version/state`)).json();
  expect(state.copies).toHaveLength(1);
  expect(state.copies[0].lifecycleState).toBe('active');
  expect(state.copies[0].currentVersion.author.displayName).toBe('Grace');
  expect(state.copyAttempts[0].modelBinding.modelId).toBe('alternate-model');
  expect(errors).toEqual([]);
});
test('blocks stale preview and lost receipt retries while preserving the original confirmation version', async ({
  page,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  await page.goto(`${path}/copy`);
  const original = await page.locator('[name="expectedCurrentVersionId"]').inputValue();
  await request.post(`${api}/__bot-version/state`, { data: { changeSource: true } });
  await page.getByRole('button', { name: 'Confirm private copy' }).click();
  await expect(page.getByRole('alert')).toContainText('source Bot changed');
  await expect(page.locator('[name="expectedCurrentVersionId"]')).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Confirm private copy' })).toBeDisabled();
  expect((await (await request.get(`${api}/__bot-version/state`)).json()).copies).toHaveLength(0);
  await page.getByRole('link', { name: 'Reload preview', exact: true }).click();
  await expect(page.getByText('Review source version 2.', { exact: false })).toBeVisible();
  await request.post(`${api}/__bot-version/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Confirm private copy' }).click();
  await expect(page.getByRole('alert')).toContainText('could not confirm this copy');
  await expect(page.getByRole('button', { name: 'Confirm private copy' })).toBeDisabled();
  expect((await (await request.get(`${api}/__bot-version/state`)).json()).copies).toHaveLength(1);
  await page.getByRole('link', { name: 'Check your Bots', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bots', exact: true })).toBeVisible();
});
test('hides copying from discovery-only viewers and rejects a revoked preview confirmation', async ({
  page,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  await page.goto(`${path}/copy`);
  await request.post(`${api}/__bot-version/state`, { data: { ownerRole: null } });
  await page.getByRole('button', { name: 'Confirm private copy' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer have permission');
  expect((await (await request.get(`${api}/__bot-version/state`)).json()).copies).toHaveLength(0);
  await page.goto(path);
  await expect(page.getByRole('link', { name: 'Copy configuration', exact: true })).toHaveCount(0);
  await page.goto(`${path}/copy`);
  await expect(page.getByText('You cannot copy this Bot', { exact: true })).toBeVisible();
});

test('blocks deleted sources until recovery without offering a copy link', async ({
  page,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  await page.goto(`${path}/copy`);
  await request.post(`${api}/__bot-version/state`, { data: { lifecycleState: 'deleted' } });
  await page.getByRole('button', { name: 'Confirm private copy' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer have permission');
  await page.goto(path);
  await expect(page.getByRole('link', { name: 'Copy configuration', exact: true })).toHaveCount(0);
  await page.goto(`${path}/copy`);
  await expect(page.getByText('You cannot copy this Bot', { exact: true })).toBeVisible();
  expect((await (await request.get(`${api}/__bot-version/state`)).json()).copies).toHaveLength(0);
});
