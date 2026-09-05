import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const groupId = 'ec661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const entry = `/app/workspaces/${workspaceId}/groups/${groupId}/bots`;
test('invites with future-only history, retries uncertain writes and keeps ordinary members read-only', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__group-bot/setup`);
  expect((await page.goto(`/app/workspaces/${workspaceId}/groups/${groupId}`))?.status()).toBe(200);
  await page.getByRole('link', { name: 'Group Bots', exact: true }).click();
  await expect(page.getByLabel('History access')).toHaveValue('future-only');
  await expect(page.getByRole('option', { name: /Discovery only/u })).toHaveCount(0);
  await page.getByLabel('Bot', { exact: true }).selectOption(botId);
  const invitationKey = await page
    .locator('form[action="?/invite"] input[name="idempotencyKey"]')
    .inputValue();
  await request.post(`${api}/__group-bot/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Invite Bot', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('same command key');
  await expect(page.locator('form[action="?/invite"] input[name="idempotencyKey"]')).toHaveValue(
    invitationKey,
  );
  await expect(page.locator('form[action="?/invite"] input[name="mode"]')).toHaveValue(
    'future-only',
  );
  await page.getByRole('button', { name: 'Retry invitation unchanged' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  const firstState = await (await request.get(`${api}/__group-bot/state`)).json();
  expect(firstState.attempts).toHaveLength(2);
  expect(firstState.attempts[0].input).toEqual(firstState.attempts[1].input);
  expect(firstState.grants).toHaveLength(1);
  await page.getByRole('link', { name: 'View allowed context' }).click();
  await expect(page.getByText('Message after invitation', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier private discussion', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to group Bots' }).click();

  const viewer = await browser.newContext({ baseURL: origin });
  await viewer.request.post(`${api}/__group-bot/viewer`);
  const viewerPage = await viewer.newPage();
  await viewerPage.goto(entry);
  await expect(
    viewerPage.getByRole('img', { name: 'Default avatar for Researcher' }),
  ).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Invite Bot' })).toHaveCount(0);
  await expect(viewerPage.getByRole('link', { name: 'View Bot details' })).toHaveCount(0);
  await expect(viewerPage.getByText('Remove Researcher', { exact: true })).toHaveCount(0);
  await viewerPage.getByRole('link', { name: 'View allowed context' }).click();
  await expect(viewerPage.getByText('Message after invitation', { exact: true })).toBeVisible();
  const contextUrl = viewerPage.url();
  const cookie = (await viewer.cookies()).find((item) => item.name === 'openbot_session')?.value;

  await page.getByText('Remove Researcher', { exact: true }).click();
  const removalKey = await page
    .locator('form[action="?/remove"] input[name="idempotencyKey"]')
    .inputValue();
  await request.post(`${api}/__group-bot/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(page.getByRole('button', { name: 'Retry removal unchanged' })).toBeVisible();
  await expect(page.locator('form[action="?/remove"] input[name="idempotencyKey"]')).toHaveValue(
    removalKey,
  );
  await page.getByRole('button', { name: 'Retry removal unchanged' }).click();
  await expect(page.getByRole('link', { name: 'View allowed context' })).toHaveCount(0);
  expect((await viewerPage.goto(contextUrl))?.status()).toBe(409);
  expect((await viewer.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );

  await page.getByLabel('Bot', { exact: true }).selectOption(botId);
  await page.getByLabel('History access').selectOption('all');
  await expect(page.getByText(/explicitly shares earlier group history/u)).toBeVisible();
  await page.getByRole('button', { name: 'Invite Bot', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.getByRole('link', { name: 'View allowed context' }).click();
  await expect(page.getByText('Earlier private discussion', { exact: true })).toBeVisible();
  const finalState = await (await request.get(`${api}/__group-bot/state`)).json();
  expect(finalState.grants).toHaveLength(2);
  expect(finalState.grants[0].id).not.toBe(finalState.grants[1].id);
  expect(finalState.grants[1].history.mode).toBe('all');
  expect(errors).toEqual([]);
  await viewer.close();
});
test('supports explicit event/time choices and reports fresh cap and permission conflicts', async ({
  page,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__group-bot/setup`);
  await page.goto(entry);
  await page.getByLabel('Bot', { exact: true }).selectOption(botId);
  await page.getByLabel('History access').selectOption('since-event');
  await page.getByLabel("Event ID from this group's conversation").fill(groupId);
  await page.getByRole('button', { name: 'Invite Bot', exact: true }).click();
  await expect(page.getByText(`History: Since event ${groupId}`, { exact: true })).toBeVisible();
  await page.getByText('Remove Researcher', { exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal' }).click();
  await page.getByLabel('Bot', { exact: true }).selectOption(botId);
  await page.getByLabel('History access').selectOption('since-time');
  await page.getByLabel('Start time (ISO UTC)').fill('2026-09-04T00:00:00.000Z');
  await request.post(`${api}/__group-bot/state`, { data: { limit: true } });
  await page.getByRole('button', { name: 'Invite Bot', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('eight active Bots');
  await expect(page.getByRole('button', { name: 'Invite Bot', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Start time (ISO UTC)')).toHaveValue('2026-09-04T00:00:00.000Z');
  await request.post(`${api}/__group-bot/state`, { data: { limit: false } });
  await page.getByRole('link', { name: 'Refresh memberships' }).click();
  await page.getByLabel('Bot', { exact: true }).selectOption(botId);
  await page.getByLabel('History access').selectOption('since-time');
  await page.getByLabel('Start time (ISO UTC)').fill('2026-09-04T00:00:00.000Z');
  await page.getByRole('button', { name: 'Invite Bot', exact: true }).click();
  await expect(
    page.getByText('History: Since 2026-09-04T00:00:00.000Z', { exact: true }),
  ).toBeVisible();
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === 'openbot_session',
  )?.value;
  await request.post(`${api}/__group-bot/state`, { data: { revoked: true } });
  expect((await page.goto(entry))?.status()).toBe(403);
  expect(
    (await page.context().cookies()).find((item) => item.name === 'openbot_session')?.value,
  ).toBe(cookie);
});
