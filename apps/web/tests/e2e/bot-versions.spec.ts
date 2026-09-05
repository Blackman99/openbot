import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const path = `/app/workspaces/${workspaceId}/bots/${botId}`;
const binding = (alternate = false) =>
  JSON.stringify({
    scope: { kind: 'workspace', id: workspaceId },
    connectionId: alternate
      ? 'fe661304-a1bc-4767-9a87-c47de763f749'
      : 'ce661304-a1bc-4767-9a87-c47de763f749',
    modelId: alternate ? 'alternate-model' : 'basic-model',
  });

test('creates immutable configuration versions, preserves stale drafts, compares fields and restores a retained avatar', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  await page.goto(path);
  await page.getByLabel('Avatar image', { exact: true }).setInputFiles({
    name: 'retained.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Upload avatar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible();
  const first = (await (await request.get(`${api}/__bot-version/state`)).json()).versions;
  await page.getByRole('link', { name: 'Edit configuration', exact: true }).click();
  const stale = await page.context().newPage();
  await stale.goto(`${path}/edit`);
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('keep');
  await request.post(`${api}/__bot-version/state`, { data: { disabledCurrent: true } });
  await page.getByLabel('Bot name', { exact: true }).fill('Updated researcher');
  await page.getByLabel('Role description', { exact: true }).fill('Evidence reviewer');
  await page.getByLabel('Description', { exact: true }).fill('Updated description');
  const instructions = 'Updated instructions.\n  Preserve whitespace.';
  await page.getByLabel('System instructions', { exact: true }).fill(instructions);
  await page.getByLabel('Total token limit', { exact: true }).fill('20000');
  await page.getByLabel('Duration limit (seconds)', { exact: true }).fill('240');
  await page.getByLabel('Turn limit', { exact: true }).fill('5');
  await page.getByLabel('Delegation depth limit', { exact: true }).fill('1');
  await page.getByLabel('Rationale (optional)', { exact: true }).fill('Clearer instructions');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Version 3', exact: true })).toBeVisible();
  await expect(page.getByText('Model unavailable.', { exact: false })).toBeVisible();
  await expect(page.locator('pre')).toHaveText(instructions);
  const afterEdit = await (await request.get(`${api}/__bot-version/state`)).json();
  expect(afterEdit.attempts[0].command.changes).not.toHaveProperty('modelBinding');
  expect(afterEdit.versions[2].configuration.instructions).toBe(instructions);
  await stale.getByLabel('System instructions', { exact: true }).fill('My conflicting draft');
  await stale.getByRole('button', { name: 'Save configuration' }).click();
  await expect(stale.getByRole('alert')).toContainText('Bot changed');
  await expect(stale.getByLabel('System instructions', { exact: true })).toHaveValue(
    'My conflicting draft',
  );
  await expect(stale.locator('[name="expectedCurrentVersionId"]')).toHaveValue(first[1].id);
  await expect(stale.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  await stale.close();

  await page.getByRole('link', { name: 'Edit configuration', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption(binding(true));
  await page.getByLabel('Rationale (optional)', { exact: true }).fill('Use alternate model');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Version 4', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Version history', exact: true }).click();
  await expect(page.getByText('Clearer instructions', { exact: true })).toBeVisible();
  await expect(page.getByText('Ada', { exact: false }).first()).toBeVisible();
  const current = (await (await request.get(`${api}/__bot-version/state`)).json()).versions[3];
  await page.getByLabel('From version', { exact: true }).selectOption(first[0].id);
  await page.getByLabel('To version', { exact: true }).selectOption(current.id);
  await page.getByRole('button', { name: 'Compare versions', exact: true }).click();
  for (const field of [
    'Bot name',
    'Role description',
    'Description',
    'System instructions',
    'Model connection',
    'Model ID',
    'Avatar',
    'Total token limit',
    'Duration limit (seconds)',
    'Turn limit',
    'Delegation depth limit',
  ])
    await expect(page.getByRole('rowheader', { name: field, exact: true })).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Avatar for Updated researcher after', exact: true }),
  ).toBeVisible();
  await page.goto(`${path}/versions?limit=1`);
  await expect(page.getByRole('link', { name: 'Version 4', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Older versions', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Version 3', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Version 3', exact: true })).toBeVisible();
  await page.goto(`${path}/versions/${first[1].id}`);
  await expect(
    page.getByRole('img', { name: 'Avatar for Versioned researcher', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Restore as new version' }).click();
  await expect(page.getByRole('alert')).toContainText('selected model is disabled');
  await request.post(`${api}/__bot-version/state`, {
    data: { disabledCurrent: false, missingAvatar: true },
  });
  await page.getByRole('button', { name: 'Restore as new version' }).click();
  await expect(page.getByRole('alert')).toContainText('historical avatar is unavailable');
  await request.post(`${api}/__bot-version/state`, { data: { missingAvatar: false } });
  await page.getByRole('button', { name: 'Restore as new version' }).click();
  await expect(page.getByRole('heading', { name: 'Version 5', exact: true })).toBeVisible();
  await expect(page.locator('pre')).toHaveText('Original instructions');
  const final = (await (await request.get(`${api}/__bot-version/state`)).json()).versions;
  expect(final).toHaveLength(5);
  expect(final.slice(0, 2)).toEqual(first);
  expect(final[4].configuration).toEqual(first[1].configuration);
  expect(final[4].id).not.toBe(first[1].id);
  expect(errors).toEqual([]);
});

test('retains a failed explicit model selection through native submission and requires a deliberate Keep current choice', async ({
  page,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  await page.goto(`${path}/edit`);
  await page.getByLabel('System instructions', { exact: true }).fill('Native form draft');
  await page.getByLabel('Model', { exact: true }).selectOption(binding());
  await request.post(`${api}/__bot-version/state`, { data: { refuseNextModel: true } });
  await Promise.all([
    page.waitForNavigation(),
    page.locator('form[action="?/edit"]').evaluate((form: HTMLFormElement) => form.submit()),
  ]);
  await expect(page.getByRole('alert')).toContainText('selected model is disabled');
  await expect(page.getByLabel('System instructions', { exact: true })).toHaveValue(
    'Native form draft',
  );
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue(binding());
  await expect(page.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  await page.getByLabel('Model', { exact: true }).selectOption('keep');
  await expect(page.getByRole('button', { name: 'Save configuration' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible();
  const state = await (await request.get(`${api}/__bot-version/state`)).json();
  expect(state.attempts[0].command.changes.modelBinding).toBeDefined();
  expect(state.attempts[1].command.changes).not.toHaveProperty('modelBinding');
  expect(state.versions).toHaveLength(2);
});

test('treats lost mutation responses as unconfirmed and enforces current history/edit permissions', async ({
  page,
  browser,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot-version/setup`);
  const initial = (await (await request.get(`${api}/__bot-version/state`)).json()).versions[0];
  await page.goto(`${path}/edit`);
  await page.getByLabel('System instructions', { exact: true }).fill('Committed but response lost');
  await request.post(`${api}/__bot-version/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page.getByRole('alert')).toContainText('could not confirm');
  await expect(page.getByLabel('System instructions', { exact: true })).toHaveValue(
    'Committed but response lost',
  );
  await expect(page.locator('[name="expectedCurrentVersionId"]')).toHaveValue(initial.id);
  await expect(page.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  await page.getByRole('link', { name: 'Reload current version', exact: true }).click();
  await expect(page.getByText('Editing version 2.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('System instructions', { exact: true })).toHaveValue(
    'Committed but response lost',
  );
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible();
  expect((await (await request.get(`${api}/__bot-version/state`)).json()).versions).toHaveLength(2);
  await page.goto(`${path}/versions/${initial.id}`);
  await page
    .getByLabel('Restoration rationale (optional)', { exact: true })
    .fill('Unconfirmed restore');
  await request.post(`${api}/__bot-version/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Restore as new version' }).click();
  await expect(page.getByRole('alert')).toContainText('could not confirm');
  await expect(page.getByLabel('Restoration rationale (optional)', { exact: true })).toHaveValue(
    'Unconfirmed restore',
  );
  await expect(page.getByRole('button', { name: 'Restore as new version' })).toBeDisabled();
  await page.getByRole('link', { name: 'Current Bot', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 3', exact: true })).toBeVisible();
  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__bot-version/viewer`);
  const guestPage = await guest.newPage();
  await guestPage.goto(`${path}/versions`);
  await expect(guestPage.getByRole('link', { name: 'Version 3', exact: true })).toBeVisible();
  await expect(guestPage.getByRole('link', { name: 'Edit configuration' })).toHaveCount(0);
  await guestPage.getByRole('link', { name: 'Version 1', exact: true }).click();
  await expect(guestPage.getByRole('button', { name: 'Restore as new version' })).toHaveCount(0);
  const cookie = (await guest.cookies()).find((item) => item.name === 'openbot_session')?.value;
  expect(cookie).toBeTruthy();
  expect((await guestPage.goto(`${path}/edit`))?.status()).toBe(403);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  await request.post(`${api}/__bot-version/state`, { data: { viewerRole: null } });
  expect((await guestPage.goto(`${path}/versions`))?.status()).toBe(403);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  await guestPage.goto(path);
  await expect(guestPage.getByRole('link', { name: 'Version history' })).toHaveCount(0);
  await expect(
    guestPage.getByText('Only Bot metadata is available.', { exact: false }),
  ).toBeVisible();
  await guest.close();
});
