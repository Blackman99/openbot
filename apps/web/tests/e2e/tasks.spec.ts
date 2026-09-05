import { expect, test, type Page } from '@playwright/test';

const api = 'http://127.0.0.1:4399';
const origin = 'http://127.0.0.1:4173';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const graceId = 'bb661304-a1bc-4767-9a87-c47de763f749';
const grantId = 'adcc0832-ce23-4d77-9c72-fb4e9d01766c';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';

async function setup(page: Page, kind: 'direct-bot' | 'group' = 'direct-bot') {
  await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__conversation/setup`);
  await page.goto(`/app/workspaces/${workspaceId}/conversations`);
  await page
    .getByRole('button', {
      name: kind === 'group' ? 'Open Research group' : 'Open Researcher',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', {
      name: kind === 'group' ? 'Group conversation' : 'Private Bot conversation',
      exact: true,
    }),
  ).toBeVisible();
  const conversationUrl = page.url();
  const conversationId = conversationUrl.split('/').at(-1)!;
  if (kind === 'group') await page.request.post(`${api}/__conversation/viewer`);
  expect(
    (await page.request.post(`${api}/__task/setup`, { data: { conversationId } })).status(),
  ).toBe(200);
  await page.reload();
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  return { conversationUrl, conversationId, tasksUrl: page.url() };
}

async function taskState(page: Page) {
  return (await page.request.get(`${api}/__task/state`)).json();
}

async function conversationState(page: Page) {
  return (await page.request.get(`${api}/__conversation/state`)).json();
}

async function safePage(page: Page, canCancel = false) {
  expect(await page.content()).not.toMatch(
    /fixture-only-password|sealedCredential|authorization:|connectionId|apiKey|modelBinding|instructions/iu,
  );
  await expect(page.getByRole('button', { name: /cancel/iu })).toHaveCount(canCancel ? 1 : 0);
  if (canCancel)
    await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toBeEnabled();
}

for (const lostResponse of ['server', 'browser'] as const) {
  test(`failed task retry preserves one attempt after a lost ${lostResponse} response and retains earlier evidence`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { conversationId } = await setup(page);
    await page.request.post(`${api}/__conversation/state`, {
      data: {
        conversationId,
        seed: Array.from({ length: 30 }, (_, index) => `Earlier message ${index}`),
      },
    });
    const prompt = 'Retry this exact original task.';
    await page.getByLabel('Prompt', { exact: true }).fill(prompt);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved task', exact: true })).toBeVisible();
    const taskId = (await taskState(page)).tasks[0].id;
    await page.request.post(`${api}/__task/state`, {
      data: { taskId, status: 'failed', usage: { inputTokens: 5, outputTokens: 1 } },
    });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Retry failed task', exact: true }),
    ).toBeVisible();
    const oldRun = (await taskState(page)).tasks[0].runs[0];
    const key = await page.locator('input[name="idempotencyKey"]').inputValue();
    await expect(page.locator('input[name="expectedRunId"]')).toHaveValue(oldRun.id);
    const action = (url: URL) =>
      url.pathname.endsWith(`/tasks/${taskId}`) && url.search === '?/retry';
    if (lostResponse === 'server')
      await page.request.post(`${api}/__task/state`, { data: { failAfterCommit: true } });
    else
      await page.route(action, async (route) => {
        await route.fetch();
        await route.abort('failed');
      });
    await page.getByRole('button', { name: 'Retry failed task', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('could not be confirmed');
    if (lostResponse === 'browser') await page.unroute(action);
    await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(key);
    await expect(page.locator('input[name="expectedRunId"]')).toHaveValue(oldRun.id);
    expect((await taskState(page)).tasks[0].runCount).toBe(2);
    await page.request.post(`${api}/__task/state`, {
      data: { taskId, status: 'completed', usage: { inputTokens: 9, outputTokens: 7 } },
    });
    await page.getByRole('button', { name: 'Confirm unchanged retry', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Researcher · Completed', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Current attempt 2 of 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry failed task', exact: true })).toHaveCount(
      0,
    );
    const saved = await taskState(page);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0].runs).toHaveLength(1);
    expect(saved.retryAttempts.map((attempt: { command: unknown }) => attempt.command)).toEqual([
      { idempotencyKey: key, expectedRunId: oldRun.id },
      { idempotencyKey: key, expectedRunId: oldRun.id },
    ]);
    expect(saved.histories[0].runs).toHaveLength(2);
    expect(saved.histories[0].runs[0]).toEqual(oldRun);
    await page.getByRole('link', { name: 'View earlier attempts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Attempt history', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Attempt 1 · Failed', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Input tokens: 5 · Output tokens: 1', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('The model request failed.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Current attempt 2 of 2', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Open conversation response', exact: true }).click();
    await expect(
      page.getByRole('article', { name: 'Message by Researcher', exact: true }).locator('pre'),
    ).toHaveText('The saved Bot response remains readable after reload.');
    const conversation = await conversationState(page);
    expect(conversation.threads[0].messages).toHaveLength(32);
    expect(
      conversation.threads[0].messages.filter(
        (message: { versions: { body: string }[] }) => message.versions[0]?.body === prompt,
      ),
    ).toHaveLength(1);
    await safePage(page);
    expect(errors).toEqual([]);
  });
}

test('direct tasks reload queued, running and completed state with actual usage and retained Bot authorship', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { conversationUrl, conversationId } = await setup(page);
  await page.request.post(`${api}/__conversation/state`, {
    data: {
      conversationId,
      seed: Array.from({ length: 30 }, (_, index) => `Earlier message ${index}`),
    },
  });
  await expect(page.getByLabel('Mention a Bot (optional)', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  const body = 'Summarize the saved evidence.\n  Preserve this prompt.';
  await page.getByLabel('Prompt', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved task', exact: true })).toBeVisible();
  const taskUrl = page.url();
  const queued = await taskState(page);
  expect(queued.tasks).toHaveLength(1);
  expect(queued.tasks[0].groupGrantId).toBeNull();
  expect(queued.tasks[0].runs).toHaveLength(1);
  const taskId = queued.tasks[0].id;
  await expect(
    page.getByRole('heading', { name: 'Researcher · Queued', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Attempt 1 · Queued', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('A model has not been called.', { exact: true })).toBeVisible();
  await page.request.post(`${api}/__task/state`, { data: { taskId, status: 'running' } });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Researcher · Running', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Model: actual-direct-model · openai-responses', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Input tokens: 12 · Output tokens: 0', { exact: true }),
  ).toBeVisible();
  await page.request.post(`${api}/__task/state`, {
    data: { taskId, status: 'completed', usage: { inputTokens: 12, outputTokens: 7 } },
  });
  expect((await taskState(page)).tasks[0].status).toBe('completed');
  await page.getByRole('link', { name: 'Refresh task', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Researcher · Completed', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Input tokens: 12 · Output tokens: 7', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Configuration version 3 · Submitted by Ada', { exact: true }),
  ).toBeVisible();
  await safePage(page);
  await page.getByRole('link', { name: 'Open conversation response', exact: true }).click();
  const botMessage = page.getByRole('article', { name: 'Message by Researcher', exact: true });
  await expect(
    botMessage.getByText('Bot · configuration version 3', { exact: true }),
  ).toBeVisible();
  await expect(botMessage.locator('pre')).toHaveText(
    'The saved Bot response remains readable after reload.',
  );
  await expect(botMessage.locator('form, summary')).toHaveCount(0);
  await expect(botMessage.getByRole('link', { name: 'View versions' })).toHaveCount(0);
  const humanMessage = page
    .getByRole('article', { name: 'Message by Ada', exact: true })
    .filter({ hasText: body });
  await expect(humanMessage.locator('pre')).toHaveText(body);
  await expect(humanMessage.getByRole('link', { name: 'View versions' })).toBeVisible();
  await page.reload();
  await expect(botMessage.locator('pre')).toHaveText(
    'The saved Bot response remains readable after reload.',
  );
  await safePage(page);
  const history = await conversationState(page);
  expect(history.attempts).toEqual([]);
  expect(history.threads[0].messages).toHaveLength(32);
  await page.goto(taskUrl);
  await expect(
    page.getByRole('heading', { name: 'Researcher · Completed', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to tasks', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Task for Researcher' })).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: 'Researcher · Completed', exact: true }),
  ).toBeVisible();
  expect((await taskState(page)).protectedReads).toEqual([]);
  expect(page.url()).toContain(conversationUrl + '/tasks');
  expect(errors).toEqual([]);
});

test('group members replay one explicit grant without Bot ACL, reload a failed run and retain their session after revocation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { conversationUrl } = await setup(page, 'group');
  const choice = page.getByLabel('Mention a Bot (optional)', { exact: true });
  await expect(choice).toHaveValue('');
  await expect(page.getByRole('option', { name: 'Closed helper', exact: true })).toHaveCount(0);
  await choice.selectOption(grantId);
  const prompt = 'Explain only this explicit group request.\n  Preserve spacing and choice.';
  await page.getByLabel('Prompt', { exact: true }).fill(prompt);
  const key = await page.locator('input[name="idempotencyKey"]').inputValue();
  await page.request.post(`${api}/__task/state`, { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(prompt);
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(choice).toBeDisabled();
  await expect(page.locator('input[name="groupGrantId"]')).toHaveValue(grantId);
  await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(key);
  const committed = await taskState(page);
  expect(committed.tasks).toHaveLength(1);
  const taskId = committed.tasks[0].id;
  await page.getByRole('button', { name: 'Retry unchanged request', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Researcher · Queued', exact: true }),
  ).toBeVisible();
  expect(page.url()).toContain('/tasks/' + taskId);
  const replayed = await taskState(page);
  expect(replayed.tasks).toHaveLength(1);
  expect(replayed.tasks[0].runs).toHaveLength(1);
  expect(replayed.tasks[0].groupGrantId).toBe(grantId);
  expect(replayed.tasks[0].executionUser).toEqual({ id: graceId, displayName: 'Grace' });
  expect(replayed.attempts.map((attempt: { command: unknown }) => attempt.command)).toEqual([
    { idempotencyKey: key, body: prompt, groupGrantId: grantId },
    { idempotencyKey: key, body: prompt, groupGrantId: grantId },
  ]);
  expect(replayed.protectedReads).toEqual([]);
  const history = await conversationState(page);
  expect(history.attempts).toEqual([]);
  expect(history.threads[0].messages).toHaveLength(1);
  expect(history.threads[0].messages[0].versions[0].body).toBe(prompt);
  await page.request.post(`${api}/__task/state`, { data: { taskId, status: 'running' } });
  await page.reload();
  await expect(
    page.getByText('Model: actual-group-model · openai-chat', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Attempt 1 · Running', exact: true }),
  ).toBeVisible();
  await page.request.post(`${api}/__task/state`, { data: { taskId, status: 'failed' } });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Researcher · Failed', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('The model request failed.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open conversation response', exact: true }),
  ).toHaveCount(0);
  await safePage(page);
  expect(
    (await page.request.get(`${api}/api/v1/workspaces/${workspaceId}/bots/${botId}`)).status(),
  ).toBe(403);
  await page.getByRole('link', { name: 'Open conversation', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'Message by Grace', exact: true }).locator('pre'),
  ).toHaveText(prompt);
  await expect(
    page.getByRole('article', { name: 'Message by Researcher', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Researcher · Failed', exact: true }),
  ).toBeVisible();
  await choice.selectOption(grantId);
  const deniedDraft = 'Keep this draft after membership is revoked.';
  await page.getByLabel('Prompt', { exact: true }).fill(deniedDraft);
  const cookie = (await page.context().cookies()).find(
    ({ name }) => name === 'openbot_session',
  )?.value;
  await page.request.post(`${api}/__conversation/state`, { data: { revoke: graceId } });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('current access does not allow this task');
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(deniedDraft);
  expect((await taskState(page)).tasks).toHaveLength(1);
  expect((await page.reload())?.status()).toBe(403);
  expect(
    (await page.context().cookies()).find(({ name }) => name === 'openbot_session')?.value,
  ).toBe(cookie);
  expect((await page.request.get(`${api}/api/v1/me`)).status()).toBe(200);
  expect(page.url()).toContain(conversationUrl + '/tasks');
  expect(errors).toEqual([]);
});

test('conflicts require a ready refreshed form and a lost browser response replays the same new command once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { conversationId, tasksUrl } = await setup(page);
  await page.goto(tasksUrl + '?limit=20');
  const key = await page.locator('input[name="idempotencyKey"]').inputValue();
  const apiTasks = `${api}/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/tasks`;
  expect(
    (
      await page.request.post(apiTasks, {
        headers: { origin },
        data: { idempotencyKey: key, body: 'The previously committed command.' },
      })
    ).status(),
  ).toBe(202);
  const conflicting = 'This different draft must not reuse the committed key.';
  await page.getByLabel('Prompt', { exact: true }).fill(conflicting);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already used with different content');
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(conflicting);
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeDisabled();
  await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(key);
  await page.getByRole('link', { name: 'Refresh tasks', exact: true }).click();
  await expect(page.locator('input[name="idempotencyKey"]')).not.toHaveValue(key);
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
  const nextKey = await page.locator('input[name="idempotencyKey"]').inputValue();
  const prompt = 'A new deliberate request.\n  Replay these exact bytes.';
  await page.getByLabel('Prompt', { exact: true }).fill(prompt);
  const actionPath = '**/conversations/*/tasks';
  await page.route(actionPath, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await page.unroute(actionPath);
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(prompt);
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(nextKey);
  const saved = await taskState(page);
  expect(saved.tasks).toHaveLength(2);
  const taskId = saved.tasks[1].id;
  await page.getByRole('button', { name: 'Retry unchanged request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved task', exact: true })).toBeVisible();
  expect(page.url()).toContain('/tasks/' + taskId);
  const replayed = await taskState(page);
  expect(replayed.tasks).toHaveLength(2);
  expect(replayed.attempts).toHaveLength(4);
  expect(
    replayed.attempts.slice(2).map((attempt: { command: unknown }) => attempt.command),
  ).toEqual([
    { idempotencyKey: nextKey, body: prompt },
    { idempotencyKey: nextKey, body: prompt },
  ]);
  const history = await conversationState(page);
  expect(history.attempts).toEqual([]);
  expect(
    history.threads[0].messages.map(
      (message: { versions: Array<{ body: string }> }) => message.versions[0]!.body,
    ),
  ).toEqual(['The previously committed command.', prompt]);
  // This retained queued Task now offers its original human the cancellation action.
  await safePage(page, true);
  expect(errors).toEqual([]);
});
