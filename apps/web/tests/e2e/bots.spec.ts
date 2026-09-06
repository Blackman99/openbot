import { expect, test } from '@playwright/test';
test('creates a private versioned Bot with saved defaults, validates models and keeps discovery metadata private', async ({
  page,
  browser,
  request,
}) => {
  const api = 'http://127.0.0.1:4399';
  const origin = 'http://127.0.0.1:4173';
  const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  expect((await page.request.post(`${api}/__bot/setup`)).status()).toBe(200);
  await page.goto(`/app/workspaces/${workspaceId}`);
  await page.getByRole('link', { name: 'Bots', exact: true }).click();
  await expect(page.getByText('Private · Only you.', { exact: false })).toBeVisible();
  const model = page.getByLabel('Model', { exact: true });
  await expect(model.locator('option').filter({ hasText: 'Disabled model' })).toBeDisabled();
  await expect(model.locator('option').filter({ hasText: 'Unverified model' })).toBeDisabled();
  await expect(page.getByLabel('Total token limit', { exact: true })).toHaveValue('32768');
  await expect(page.getByLabel('Duration limit (seconds)', { exact: true })).toHaveValue('300');
  await expect(page.getByLabel('Turn limit', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('Delegation depth limit', { exact: true })).toHaveValue('2');
  const binding = {
    scope: { kind: 'workspace', id: workspaceId },
    connectionId: 'ce661304-a1bc-4767-9a87-c47de763f749',
    modelId: 'basic-model',
  };
  await model.selectOption(JSON.stringify(binding));
  const instructions = 'Cite sources.\n  Preserve uncertainty.';
  await page.getByLabel('Role description', { exact: true }).fill('Research assistant');
  await page.getByLabel('Description', { exact: true }).fill('Evidence and context');
  await page.getByLabel('System instructions', { exact: true }).fill(instructions);
  const name = page.getByLabel('Bot name', { exact: true });
  await expect(name).toHaveAttribute('maxlength', '100');
  await name.evaluate((element) => element.removeAttribute('maxlength'));
  await name.fill('x'.repeat(101));
  await page.getByRole('button', { name: 'Create Bot', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('field limits');
  await expect(page.getByLabel('System instructions', { exact: true })).toHaveValue(instructions);
  await name.fill('Researcher');
  await page.getByRole('button', { name: 'Create Bot', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/bots/bdcc0832-ce23-4d77-9c72-000000000001$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  await expect(
    page.getByText('Chat-only — unsuitable for reliable delegation', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('pre')).toHaveText(instructions);
  await expect(page.getByText('Your Bot role: owner', { exact: true })).toBeVisible();
  const saved = (await (await request.get(`${api}/__bot/state`)).json()).bots[0];
  expect(saved.currentVersion.configuration.limits).toEqual({
    maxTotalTokens: 32768,
    maxDurationSeconds: 300,
    maxTurns: 8,
    maxDelegationDepth: 2,
  });
  expect(saved.currentVersion.configuration.modelBinding).toEqual(binding);
  // Native HTML form submission uses CRLF; the server preserves the submitted formatting.
  expect(saved.currentVersion.configuration.instructions).toBe(
    'Cite sources.\r\n  Preserve uncertainty.',
  );
  const botUrl = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__bot/viewer`);
  const guestPage = await guest.newPage();
  const session = (await guest.cookies()).find(
    (cookie) => cookie.name === 'openbot_session',
  )?.value;
  expect((await guestPage.goto(botUrl))?.status()).toBe(403);
  expect((await guest.cookies()).find((cookie) => cookie.name === 'openbot_session')?.value).toBe(
    session,
  );
  await request.post(`${api}/__bot/state`, { data: { discoverable: true, disabled: true } });
  await guestPage.reload();
  await expect(
    guestPage.getByText('Only Bot metadata is available.', { exact: false }),
  ).toBeVisible();
  await expect(
    guestPage.getByRole('heading', { name: 'System instructions', exact: true }),
  ).toHaveCount(0);
  await expect(guestPage.getByText(binding.connectionId, { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Model unavailable.', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Chat-only — unsuitable for reliable delegation', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Bots', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Bot', exact: true })).toBeDisabled();
  await expect(page.getByText('Model unavailable.', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
  await guest.close();
});
