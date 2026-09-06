import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const adaId = 'ab661304-a1bc-4767-9a87-c47de763f749';
const graceId = 'bb661304-a1bc-4767-9a87-c47de763f749';
const entry = `/app/workspaces/${workspaceId}/conversations`;

test('retries a committed message once, edits with CAS, and keeps tombstone versions behind current permission', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__conversation/setup`);
  await page.goto(`/app/workspaces/${workspaceId}`);
  await page.getByRole('link', { name: 'Conversations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Discovery group' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Discovery Bot' })).toHaveCount(0);
  expect((await (await request.get(`${api}/__conversation/state`)).json()).threads).toHaveLength(0);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Group conversation' })).toBeVisible();
  const conversationUrl = page.url();
  const compose = page.getByRole('region', { name: 'Add a message' });
  const key = await compose.locator('[name="idempotencyKey"]').inputValue();
  const body = 'First message.\n  Keep this formatting.';
  await page.getByLabel('Message', { exact: true }).fill(body);
  await request.post(`${api}/__conversation/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('same command key');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(body);
  await expect(compose.locator('[name="idempotencyKey"]')).toHaveValue(key);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await expect(compose.locator('[name="idempotencyKey"]')).not.toHaveValue(key);
  const state = await (await request.get(`${api}/__conversation/state`)).json();
  expect(state.attempts).toHaveLength(2);
  expect(state.attempts[0].command).toEqual(state.attempts[1].command);
  expect(state.threads[0].messages).toHaveLength(1);
  expect(state.threads[0].messages[0].versions[0].body).toBe(body);
  const messageId = state.threads[0].messages[0].id;

  const stale = await page.context().newPage();
  await stale.goto(conversationUrl);
  await stale
    .locator('summary')
    .filter({ hasText: /^Edit message$/u })
    .click();
  await stale.getByLabel('Edit message text').fill('My stale draft');
  const staleKey = await stale
    .locator('form[action*="/edit"] [name="idempotencyKey"]')
    .inputValue();
  await page
    .locator('summary')
    .filter({ hasText: /^Edit message$/u })
    .click();
  await page.getByLabel('Edit message text').fill('Current edited message');
  await page.getByRole('button', { name: 'Save edit' }).click();
  await expect(page.locator('article pre')).toHaveText('Current edited message');
  await stale.getByRole('button', { name: 'Save edit' }).click();
  await expect(stale.getByRole('alert')).toContainText('latest version');
  await expect(stale.getByLabel('Edit message text')).toHaveValue('My stale draft');
  await expect(stale.locator('form[action*="/edit"] [name="idempotencyKey"]')).toHaveValue(
    staleKey,
  );
  await expect(stale.locator('form[action*="/edit"] [name="expectedVersion"]')).toHaveValue('1');
  await expect(stale.getByRole('button', { name: 'Save edit' })).toBeDisabled();
  await stale.getByRole('link', { name: 'Refresh messages' }).click();
  await expect(stale.locator('article pre')).toHaveText('Current edited message');
  await stale.close();
  await page.getByRole('link', { name: 'View versions' }).click();
  await expect(page.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible();
  await expect(page.locator('pre').first()).toHaveText(body);
  await page.getByRole('link', { name: 'Back to conversation', exact: true }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Delete message$/u })
    .click();
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(page.getByText('Deleted message', { exact: true })).toBeVisible();
  await expect(page.locator('article pre')).toHaveCount(0);
  await expect(page.locator('summary')).toHaveCount(0);

  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__conversation/viewer`);
  const guestPage = await guest.newPage();
  await guestPage.goto(conversationUrl);
  await expect(guestPage.getByText('Deleted message', { exact: true })).toBeVisible();
  await expect(guestPage.getByRole('link', { name: 'View versions' })).toHaveCount(0);
  const cookie = (await guest.cookies()).find((item) => item.name === 'openbot_session')?.value;
  expect(
    (await guestPage.goto(`${conversationUrl}/messages/${messageId}/versions`))?.status(),
  ).toBe(403);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  await guestPage.goto(conversationUrl);
  await guestPage.getByLabel('Message', { exact: true }).fill('Message from Grace');
  await guestPage.getByRole('button', { name: 'Send message' }).click();
  await expect(guestPage.getByRole('article')).toHaveCount(2);
  await page.reload();
  const graceMessage = page.getByRole('article', { name: 'Message by Grace' });
  await expect(graceMessage.getByText('Edit message', { exact: true })).toHaveCount(0);
  await graceMessage
    .locator('summary')
    .filter({ hasText: /^Delete message$/u })
    .click();
  const reason = graceMessage.getByLabel('Reason for deletion (required)');
  await expect(reason).toHaveAttribute('required', '');
  await reason.fill('Group moderation reason');
  await graceMessage.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(graceMessage).toContainText('Group moderation reason');
  await page
    .getByRole('article', { name: 'Message by Ada' })
    .getByRole('link', { name: 'View versions' })
    .click();
  await expect(page.getByRole('heading', { name: 'Version 3', exact: true })).toBeVisible();
  await expect(page.locator('pre').first()).toHaveText(body);
  expect(errors).toEqual([]);
  await guest.close();
});

test('opaque pagination keeps its creation horizon while showing current edits and tombstones', async ({
  page,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__conversation/setup`);
  await page.goto(entry);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  const conversationUrl = page.url();
  const conversationId = conversationUrl.split('/').at(-1);
  await request.post(`${api}/__conversation/state`, {
    data: { conversationId, seed: ['One', 'Two', 'Three'] },
  });
  await page.goto(`${conversationUrl}?limit=1`);
  await expect(page.locator('article pre')).toHaveText('One');
  const state = await (await request.get(`${api}/__conversation/state`)).json();
  const [, second, third] = state.threads[0].messages;
  await request.post(`${api}/__conversation/state`, {
    data: {
      conversationId,
      seed: ['Created after horizon'],
      messageId: second.id,
      edit: 'Two edited after horizon',
    },
  });
  await request.post(`${api}/__conversation/state`, {
    data: { conversationId, messageId: third.id, tombstone: true },
  });
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.locator('article pre')).toHaveText('Two edited after horizon');
  await page.reload();
  await expect(page.locator('article pre')).toHaveText('Two edited after horizon');
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByText('Deleted message', { exact: true })).toBeVisible();
  await expect(page.locator('article pre')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Refresh messages' }).click();
  await expect(page.locator('article pre')).toHaveText('One');
  await page.goto(`${conversationUrl}?limit=100`);
  await expect(page.getByRole('article')).toHaveCount(4);
  await expect(page.locator('article pre').last()).toHaveText('Created after horizon');
});

test('direct Bot histories stay creator-private without model availability gates, and revocation preserves identity', async ({
  page,
  browser,
  request,
}) => {
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__conversation/setup`);
  await page.goto(entry);
  await expect(page.getByRole('button', { name: 'Open Researcher', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Open Researcher', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private Bot conversation' })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Creator-only history');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('article pre')).toHaveText('Creator-only history');
  const privateUrl = page.url().split('#')[0]!;
  const guest = await browser.newContext({ baseURL: origin });
  await guest.request.post(`${api}/__conversation/viewer`);
  const guestPage = await guest.newPage();
  const cookie = (await guest.cookies()).find((item) => item.name === 'openbot_session')?.value;
  expect((await guestPage.goto(privateUrl))?.status()).toBe(403);
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  await guestPage.goto(entry);
  await guestPage.getByRole('button', { name: 'Open Researcher', exact: true }).click();
  await expect(guestPage.getByRole('heading', { name: 'Private Bot conversation' })).toBeVisible();
  expect(guestPage.url()).not.toBe(privateUrl);
  await expect(guestPage.getByRole('article')).toHaveCount(0);
  await guestPage.goto(entry);
  await guestPage.getByRole('button', { name: 'Open Research group', exact: true }).click();
  await guestPage.getByLabel('Message', { exact: true }).fill('Draft after revoked membership');
  await request.post(`${api}/__conversation/state`, { data: { revoke: graceId } });
  await guestPage.getByRole('button', { name: 'Send message' }).click();
  await expect(guestPage.getByRole('alert')).toContainText('no longer have permission');
  await expect(guestPage.getByLabel('Message', { exact: true })).toHaveValue(
    'Draft after revoked membership',
  );
  expect((await guest.cookies()).find((item) => item.name === 'openbot_session')?.value).toBe(
    cookie,
  );
  expect((await guestPage.reload())?.status()).toBe(403);
  await request.post(`${api}/__conversation/state`, { data: { removeWorkspace: adaId } });
  const ownerCookie = (await page.context().cookies()).find(
    (item) => item.name === 'openbot_session',
  )?.value;
  expect((await page.reload())?.status()).toBe(403);
  expect(
    (await page.context().cookies()).find((item) => item.name === 'openbot_session')?.value,
  ).toBe(ownerCookie);
  const identity = await page.request.get(`${api}/api/v1/me`);
  expect(identity.status()).toBe(200);
  expect((await identity.json()).workspace).toBeNull();
  await guest.close();
});
