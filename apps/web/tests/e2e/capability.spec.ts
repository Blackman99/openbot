import { expect, test, type Page } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';
const input = (name: string, protocol: string) => ({
  name,
  protocol,
  baseUrl: 'https://models.example/v1',
  modelId: name.toLowerCase().replaceAll(' ', '-'),
  apiKey: 'capability-secret',
  headers: { 'x-private': 'header-secret' },
});
async function owner(page: Page) {
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  const response = await page.request.post(`${api}/api/v1/setup`, {
    headers: { origin, 'x-openbot-setup-token': 'local-only-openbot-setup-token-change-me' },
    data: {
      displayName: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    },
  });
  expect(response.status()).toBe(201);
}
test('edits attributable personal capabilities, ordered fallbacks and conflict reloads', async ({
  page,
}) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await owner(page);
  const base = `${api}/api/v1/model-connections`;
  const ids: string[] = [];
  for (const [name, protocol] of [
    ['Basic Chat', 'openai-chat'],
    ['Team Responses', 'openai-responses'],
    ['Backup Anthropic', 'anthropic-messages'],
  ]) {
    const response = await page.request.post(base, {
      headers: { origin },
      data: input(name!, protocol!),
    });
    expect(response.status()).toBe(201);
    ids.push((await response.json()).id);
  }
  const [primary, team, backup] = ids;
  await page.goto('/app/settings/models');
  await page
    .getByRole('article', { name: 'Basic Chat', exact: true })
    .getByRole('link', { name: 'Capabilities and fallbacks' })
    .click();
  await expect(page.getByRole('heading', { name: 'Basic · chat-only', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collaboration: unavailable' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Vision input: unknown' })).toBeVisible();
  expect(await page.content()).not.toMatch(/capability-secret|header-secret/u);
  expect(await page.getByRole('main').innerText()).not.toMatch(/x-private|models\.example/u);
  await page.getByRole('combobox', { name: 'Capability', exact: true }).selectOption('visionInput');
  await page.getByLabel('Rationale').fill('Image input verified against a sample.');
  await page.getByRole('button', { name: 'Save manual override' }).click();
  await expect(page.getByRole('status')).toHaveText('Manual override saved.');
  const vision = page.getByRole('article', { name: 'Vision input: supported' });
  await expect(vision).toContainText('Manual override · Active');
  await expect(vision).toContainText('user-id');
  await page.getByRole('button', { name: 'Re-probe capabilities' }).click();
  await expect(page.getByRole('status')).toHaveText('Capabilities re-probed.');
  await expect(vision).toContainText('Image input verified against a sample.');
  await page.request.put(`${base}/${primary}`, {
    headers: { origin },
    data: { ...input('Basic Chat', 'openai-chat'), modelId: 'new-target' },
  });
  await page.reload();
  const staleVision = page.getByRole('article', { name: 'Vision input: unknown' });
  await expect(staleVision).toContainText('Stale — target changed');
  await expect(staleVision).toContainText('does not grant support');
  await page
    .getByRole('combobox', { name: 'Required capability', exact: true })
    .selectOption('collaboration');
  await page.getByRole('button', { name: 'Add fallback' }).click();
  await page.getByLabel('Fallback priority 1').selectOption(team!);
  await page.getByRole('button', { name: 'Add fallback' }).click();
  await page.getByLabel('Fallback priority 2').selectOption(backup!);
  await page
    .getByRole('list', { name: 'Fallback editor' })
    .getByRole('listitem')
    .nth(1)
    .getByRole('button', { name: 'Move up' })
    .click();
  await expect(page.getByLabel('Fallback priority 1')).toHaveValue(backup!);
  await page.getByRole('button', { name: 'Save fallback order' }).click();
  await expect(page.getByRole('status')).toHaveText('Fallback order saved.');
  await expect(
    page.getByRole('list', { name: 'Saved fallback order' }).getByRole('listitem').first(),
  ).toContainText('Backup Anthropic');
  await page.getByLabel('Requested capability').selectOption('collaboration');
  await page.getByRole('button', { name: 'Preview resolution' }).click();
  await expect(page.getByText('Selected model: Backup Anthropic', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Resolution candidates' }).getByRole('listitem').first(),
  ).toContainText('Excluded · Capability unknown');
  await page.request.patch(`${base}/${backup}`, { headers: { origin }, data: { enabled: false } });
  await page.reload();
  await expect(page.getByText('Selected model: Team Responses', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Resolution candidates' }).getByRole('listitem').nth(1),
  ).toContainText('Excluded · Disabled');
  await page.getByRole('button', { name: 'Save fallback order' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Choose enabled, accessible fallback models in the same scope.',
  );
  await expect(
    page.getByRole('list', { name: 'Saved fallback order' }).getByRole('listitem').first(),
  ).toContainText('Backup Anthropic');
  const policy = await (await page.request.get(`${base}/${primary}/policy`)).json();
  expect(
    (
      await page.request.post(`${base}/${primary}/reprobe`, {
        headers: { origin },
        data: { expectedRevision: policy.revision },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole('combobox', { name: 'Capability', exact: true }).selectOption('toolCalling');
  await page.getByLabel('Rationale').fill('Stale page attempt');
  await page.getByRole('button', { name: 'Save manual override' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'This connection changed. Reload the page before making another change.',
  );
  await expect(page.getByRole('button', { name: 'Save manual override' })).toBeDisabled();
  await page.getByRole('link', { name: 'Reload capabilities' }).click();
  await expect(page.getByRole('button', { name: 'Save manual override' })).toBeEnabled();
  expect(errors).toEqual([]);
});
test('lets workspace members inspect and preview while current administrators manage evidence', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(10_000);
  await owner(page);
  const base = `${api}/api/v1/workspaces/workspace-id/model-connections`;
  const connection = await (
    await page.request.post(base, {
      headers: { origin },
      data: input('Shared Anthropic', 'anthropic-messages'),
    })
  ).json();
  const id = connection.connection.id;
  await page.goto('/app/workspaces/workspace-id/models');
  await page.getByRole('link', { name: 'Capabilities and fallbacks' }).click();
  await expect(page.getByRole('heading', { name: 'Shared Anthropic capabilities' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save manual override' })).toBeVisible();
  const invitation = await (
    await page.request.post(`${api}/api/v1/workspaces/workspace-id/invitations`, {
      headers: { origin },
      data: { email: 'grace@example.com', role: 'member', expiresInDays: 7 },
    })
  ).json();
  const guest = await browser.newContext({ baseURL: origin });
  try {
    expect(
      (
        await guest.request.post(`${api}/api/v1/invitations/accept`, {
          headers: { origin },
          data: {
            token: invitation.token,
            email: 'grace@example.com',
            displayName: 'Grace',
            password: 'second correct horse battery staple',
          },
        })
      ).status(),
    ).toBe(201);
    const member = await guest.newPage();
    member.setDefaultTimeout(10_000);
    const errors: string[] = [];
    member.on('pageerror', (error) => errors.push(error.message));
    await member.goto('/app/workspaces/workspace-id/models');
    await member.getByRole('link', { name: 'Capabilities and fallbacks' }).click();
    await expect(member.getByRole('heading', { name: 'Collaboration: available' })).toBeVisible();
    await expect(member.getByRole('button', { name: 'Save manual override' })).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Re-probe capabilities' })).toHaveCount(0);
    expect(await member.content()).not.toMatch(
      /capability-secret|header-secret|x-private|models\.example/u,
    );
    await member.getByLabel('Requested capability').selectOption('visionInput');
    await member.getByRole('button', { name: 'Preview resolution' }).click();
    await expect(member.getByText('Selected model: None available', { exact: true })).toBeVisible();
    await expect(member.getByRole('list', { name: 'Resolution candidates' })).toContainText(
      'Capability unknown',
    );
    expect(
      (
        await guest.request.post(`${base}/${id}/overrides`, {
          headers: { origin },
          data: {
            expectedRevision: 0,
            capability: 'visionInput',
            value: true,
            rationale: 'Forged',
          },
        })
      ).status(),
    ).toBe(403);
    await page.request.patch(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
      headers: { origin },
      data: { role: 'administrator' },
    });
    await member.reload();
    await member
      .getByRole('combobox', { name: 'Capability', exact: true })
      .selectOption('visionInput');
    await member.getByLabel('Rationale').fill('Administrator verified image support.');
    await member.getByRole('button', { name: 'Save manual override' }).click();
    await expect(member.getByRole('article', { name: 'Vision input: supported' })).toContainText(
      'user-2',
    );
    await member.getByRole('button', { name: 'Re-probe capabilities' }).click();
    await expect(
      member.getByRole('article', { name: 'Text: supported', exact: true }),
    ).toContainText('user-2');
    await page.request.patch(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
      headers: { origin },
      data: { role: 'member' },
    });
    await member.getByLabel('Rationale').fill('After demotion');
    await member.getByRole('button', { name: 'Save manual override' }).click();
    await expect(member.getByRole('alert')).toContainText('permission');
    await expect(member.getByRole('button', { name: 'Save manual override' })).toHaveCount(0);
    await page.request.delete(`${api}/api/v1/workspaces/workspace-id/members/user-2`, {
      headers: { origin },
    });
    expect((await member.reload())?.status()).toBe(403);
    expect((await guest.request.get(`${api}/api/v1/me`)).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally {
    await guest.close().catch(() => undefined);
  }
});
