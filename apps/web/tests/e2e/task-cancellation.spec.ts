import { expect, test, type Page } from '@playwright/test';
const api = 'http://127.0.0.1:4399';
async function setup(page: Page, mode: 'direct' | 'group' | 'silent' = 'direct') {
  expect(
    (await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } })).status(),
  ).toBe(204);
  const response = await page.request.post(
    `${api}/__cancel/setup${mode === 'direct' ? '' : mode === 'group' ? '-group' : '-silent'}`,
  );
  expect(response.status()).toBe(201);
  const fixture = await response.json();
  const conversation = `/app/workspaces/${fixture.workspaceId}/conversations/${fixture.conversationId}`;
  return { ...fixture, conversation, detail: `${conversation}/tasks/${fixture.taskId}` };
}
async function control(page: Page, action: string) {
  const response = await page.request.post(`${api}/__cancel/${action}`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function state(page: Page) {
  return (await page.request.get(`${api}/__cancel/state`)).json();
}
function cancelForm(page: Page) {
  return page.getByRole('region', { name: 'Cancel task' });
}
async function privateOutput(page: Page) {
  expect(await page.content()).not.toMatch(
    /cancel-provider-secret-sentinel|Private cancellation instructions sentinel|sealedCredentials|baseUrl/u,
  );
  await expect(page.getByRole('button', { name: 'Save edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm deletion', exact: true })).toHaveCount(0);
}

test('queued cancellation survives reload and never constructs a provider request', async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(f.detail);
  await expect(page.getByRole('heading', { name: 'Cancellation helper · Queued' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cancellation helper · Cancelled' }),
  ).toBeVisible();
  await expect(page.getByText('No output was saved before cancellation.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toHaveCount(0);
  await control(page, 'consume-queued');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Cancellation helper · Cancelled' }),
  ).toBeVisible();
  const result = await state(page);
  expect(result).toMatchObject({
    providerCalls: 0,
    taskCount: 1,
    prompts: 1,
    outputs: [],
    partials: [],
  });
  expect(result.runs).toEqual([
    expect.objectContaining({ status: 'cancelled', started_at: null, output_event_id: null }),
  ]);
  expect(result.commands).toHaveLength(1);
  await privateOutput(page);
});

test('a real running HTTP request aborts and its escaped interrupted prefix survives reload and stream expiry', async ({
  page,
}) => {
  const f = await setup(page),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(f.conversation);
  await expect(
    page.getByRole('status').filter({ hasText: 'Live updates connected' }),
  ).toBeVisible();
  await control(page, 'start');
  await expect(page.getByLabel('Draft answer')).toContainText('<b>Interrupted 🌱</b>');
  expect((await state(page)).outputs).toEqual([]);
  await page.goto(f.detail);
  await expect(page.getByRole('heading', { name: 'Cancellation helper · Running' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cancellation helper · Cancelled' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Interrupted output', exact: true }),
  ).toBeVisible();
  await expect(page.locator('pre')).toHaveText('<b>Interrupted 🌱</b>');
  await expect(page.locator('b')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).providerClosed).toBe(true);
  await control(page, 'late');
  await page.getByRole('link', { name: 'Open conversation', exact: true }).click();
  await expect(page.getByLabel('Interrupted output')).toContainText('<b>Interrupted 🌱</b>');
  await expect(page.getByLabel('Interrupted output')).toContainText('Cancelled before completion');
  await control(page, 'expire');
  await page.reload();
  await expect(page.getByLabel('Interrupted output')).toContainText('<b>Interrupted 🌱</b>');
  await expect(page.getByRole('article', { name: 'Message by Cancellation helper' })).toHaveCount(
    0,
  );
  const result = await state(page);
  expect(result).toMatchObject({
    providerCalls: 1,
    providerClosed: true,
    taskCount: 1,
    prompts: 1,
    outputs: [],
  });
  expect(result.partials).toEqual([
    { body: '<b>Interrupted 🌱</b>', end_byte: Buffer.byteLength('<b>Interrupted 🌱</b>') },
  ]);
  expect(errors).toEqual([]);
  // Human prompt controls remain on the human article; interrupted Bot output
  // itself is escaped text with a Task link, never a human-editable message.
  await expect(page.getByLabel('Interrupted output').getByRole('button')).toHaveCount(0);
  expect(await page.content()).not.toMatch(
    /cancel-provider-secret-sentinel|Private cancellation instructions sentinel/u,
  );
  const cookie = (await page.context().cookies()).find(
    (entry) => entry.name === 'openbot_session',
  )!.value;
  await control(page, 'revoke');
  await expect(page.getByRole('alert')).toHaveText(
    'You no longer have permission to read this conversation.',
  );
  await expect(page.getByLabel('Interrupted output')).toHaveCount(0);
  const denied = await page.request.get(`${f.detail}/runs/${f.runId}/partial-output`);
  expect(denied.status()).toBe(403);
  expect(await denied.text()).not.toContain('Interrupted 🌱');
  expect(
    (await page.context().cookies()).find((entry) => entry.name === 'openbot_session')?.value,
  ).toBe(cookie);
});

test('a current group admin can stop the original human work after provider and grant admission close', async ({
  page,
}) => {
  const f = await setup(page, 'group');
  await control(page, 'actor/viewer');
  await page.goto(f.detail);
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toHaveCount(0);
  const denied = await page.request.post(
    `${api}/api/v1/workspaces/${f.workspaceId}/conversations/${f.conversationId}/tasks/${f.taskId}/cancellations`,
    {
      headers: { origin: 'http://127.0.0.1:4173' },
      data: { idempotencyKey: 'ordinary-member-cancel', expectedRunId: f.runId },
    },
  );
  expect(denied.status()).toBe(403);
  expect((await state(page)).commands).toEqual([]);
  await control(page, 'actor/admin');
  await page.goto(f.detail);
  await expect(
    page.getByText('Configuration version 1 · Submitted by Original executor'),
  ).toBeVisible();
  await control(page, 'start');
  await expect.poll(async () => (await state(page)).partials.length).toBe(1);
  await control(page, 'close-admission');
  await page.getByRole('link', { name: 'Refresh task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cancellation helper · Cancelled' }),
  ).toBeVisible();
  await expect(page.locator('pre')).toHaveText('<b>Interrupted 🌱</b>');
  await expect.poll(async () => (await state(page)).providerClosed).toBe(true);
  expect((await state(page)).commands).toHaveLength(1);
  await privateOutput(page);
});

test('group cancellation rechecks current access and keeps the valid session cookie after revocation', async ({
  page,
}) => {
  const f = await setup(page, 'group');
  await page.goto(f.detail);
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toBeVisible();
  const before = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'openbot_session',
  )!.value;
  await control(page, 'revoke');
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Your current access does not allow cancellation. The saved task is preserved.',
  );
  expect(
    (await page.context().cookies()).find((cookie) => cookie.name === 'openbot_session')?.value,
  ).toBe(before);
  expect(await state(page)).toMatchObject({
    task: { status: 'queued' },
    commands: [],
    outputs: [],
    providerCalls: 0,
  });
  await privateOutput(page);
});

test('an unknown post-commit outcome confirms the identical cancellation key and creates no second prompt or receipt', async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(f.detail);
  const key = await cancelForm(page).locator('input[name="idempotencyKey"]').inputValue();
  const expectedRun = await cancelForm(page).locator('input[name="expectedRunId"]').inputValue();
  let intercepted = false;
  await page.route(
    (url) => url.pathname.endsWith(`/tasks/${f.taskId}`) && url.search === '?/cancel',
    async (route) => {
      if (intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      const saved = await route.fetch();
      expect(saved.ok()).toBe(true);
      await route.abort('failed');
    },
  );
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Confirm unchanged cancellation', exact: true }),
  ).toBeEnabled();
  expect((await state(page)).task.status).toBe('cancelled');
  await expect(cancelForm(page).locator('input[name="idempotencyKey"]')).toHaveValue(key);
  await expect(cancelForm(page).locator('input[name="expectedRunId"]')).toHaveValue(expectedRun);
  await page.getByRole('button', { name: 'Confirm unchanged cancellation', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cancellation helper · Cancelled' }),
  ).toBeVisible();
  const result = await state(page);
  expect(result).toMatchObject({ taskCount: 1, prompts: 1, outputs: [], providerCalls: 0 });
  expect(result.commands).toEqual([
    expect.objectContaining({
      idempotency_key: key,
      expected_run_id: expectedRun,
      affected_run_count: 1,
    }),
  ]);
});

test('a stale cancellation is blocked until Refresh task loads the current Run and a new command', async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(f.detail);
  const originalKey = await cancelForm(page).locator('input[name="idempotencyKey"]').inputValue();
  await control(page, 'advance');
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'A newer attempt exists. Refresh the task before cancelling it.',
  );
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Refresh task', exact: true }).click();
  await expect(page.getByText('Current attempt 2 of 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toBeEnabled();
  expect(await cancelForm(page).locator('input[name="idempotencyKey"]').inputValue()).not.toBe(
    originalKey,
  );
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cancellation helper · Cancelled' }),
  ).toBeVisible();
  const result = await state(page);
  expect(result.runs.map((run: { status: string }) => run.status)).toEqual(['failed', 'cancelled']);
  expect(result).toMatchObject({ taskCount: 1, prompts: 1, outputs: [], providerCalls: 0 });
  expect(result.commands).toHaveLength(1);
});

test('a silent HTTP request before its first byte stops with no invented partial', async ({
  page,
}) => {
  const f = await setup(page, 'silent');
  await control(page, 'start');
  await page.goto(f.detail);
  await expect(page.getByRole('heading', { name: 'Cancellation helper · Running' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await expect(page.getByText('No output was saved before cancellation.')).toBeVisible();
  await expect.poll(async () => (await state(page)).providerClosed).toBe(true);
  expect(await state(page)).toMatchObject({
    providerCalls: 1,
    task: { status: 'cancelled' },
    partials: [],
    outputs: [],
  });
});
