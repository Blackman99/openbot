import { expect, test, type Page } from '@playwright/test';

const api = 'http://127.0.0.1:4399';
const prompt = 'TypeScript database';
type Fixture = {
  workspaceId: string;
  groupId: string;
  conversationId: string;
  memberId: string;
  bots: { researcher: string; coder: string };
  grants: { researcher: string; coder: string };
};
type Decision = {
  algorithm: string;
  reason: string;
  lead: { botId: string; grantId: string; name: string };
  candidates: Array<{ name: string; score: number; matchedTerms: string[] }>;
};
type State = {
  probeCalls: number;
  routingReads: string[];
  counts: { messages: number; tasks: number; runs: number; decisions: number };
  tasks: Array<{
    id: string;
    groupGrantId: string;
    bot: { id: string; name: string };
    executionUser: { id: string };
    runs: Array<{ status: string; startedAt: string | null; provider: unknown }>;
  }>;
  decisions: Array<{ taskId: string; routing: Decision }>;
};

function paths(fixture: Fixture) {
  const conversation = `/app/workspaces/${fixture.workspaceId}/conversations/${fixture.conversationId}`;
  return {
    conversation,
    tasks: `${conversation}/tasks`,
    settings: `/app/workspaces/${fixture.workspaceId}/groups/${fixture.groupId}/routing`,
  };
}
async function setup(page: Page): Promise<Fixture> {
  expect(
    (await page.request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } })).status(),
  ).toBe(204);
  const response = await page.request.post(`${api}/__routing/setup`);
  expect(response.status()).toBe(201);
  return response.json();
}
async function state(page: Page): Promise<State> {
  const response = await page.request.get(`${api}/__routing/state`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function setDefault(page: Page, fixture: Fixture) {
  await page.goto(paths(fixture).settings);
  await expect(page.getByRole('heading', { name: 'Group routing', exact: true })).toBeVisible();
  await page.getByLabel('Default Bot', { exact: true }).selectOption(fixture.grants.researcher);
  await page.getByRole('button', { name: 'Save default', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Researcher', exact: true })).toBeVisible();
  await expect(page.locator('input[name="expectedRevision"]').first()).toHaveValue('1');
}
async function submit(page: Page, fixture: Fixture, grantId = '') {
  await page.goto(paths(fixture).tasks);
  const mention = page.getByLabel('Mention a Bot (optional)', { exact: true });
  await expect(mention).not.toHaveAttribute('required');
  await expect(mention).toHaveValue('');
  await expect(
    mention.getByRole('option', { name: 'Automatic · default or local match', exact: true }),
  ).toHaveAttribute('value', '');
  await expect(mention.getByRole('option', { name: '@ Coder', exact: true })).toHaveAttribute(
    'value',
    fixture.grants.coder,
  );
  if (grantId) await mention.selectOption(grantId);
  await page.getByLabel('Prompt', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved task', exact: true })).toBeVisible();
  const taskId = new URL(page.url()).pathname.split('/').at(-1)!;
  const snapshot = await state(page);
  const receipt = snapshot.decisions.find((entry) => entry.taskId === taskId);
  expect(receipt).toBeDefined();
  return { taskId, routing: receipt!.routing };
}
async function visibleDecision(page: Page, lead: string, reason: string) {
  const decision = page.getByRole('region', { name: 'Routing decision', exact: true });
  await expect(decision).toHaveCount(1);
  await expect(decision.getByRole('heading', { name: `Lead: ${lead}`, exact: true })).toBeVisible();
  await expect(decision.getByText(reason, { exact: true })).toBeVisible();
  await decision.getByText('Candidate evidence (2)', { exact: true }).click();
  await expect(decision.getByText('Lexical score: 10', { exact: true })).toBeVisible();
  await expect(
    decision.getByText('Matched terms: database, typescript', { exact: true }),
  ).toBeVisible();
  await expect(decision.getByText('Lexical score: 0', { exact: true })).toBeVisible();
  expect(await page.content()).not.toMatch(
    /routing-(?:instructions|provider-key|provider-header|raw-probe)-sentinel|sealedCredentials|modelBinding|connectionId/iu,
  );
}
function noProviderInvocation(snapshot: State, tasks: number) {
  // The only probe seam was used to establish the two models during setup.
  // Real queued Runs remain unclaimed; this fixture never starts a worker.
  expect(snapshot.probeCalls).toBe(2);
  expect(snapshot.counts).toEqual({ messages: tasks, tasks, runs: tasks, decisions: tasks });
  for (const task of snapshot.tasks)
    expect(task.runs).toEqual([
      expect.objectContaining({ status: 'queued', startedAt: null, provider: null }),
    ]);
}

test('an automatic group task prefers its default and reloads one saved decision in the conversation', async ({
  page,
}) => {
  const fixture = await setup(page);
  await setDefault(page, fixture);
  const saved = await submit(page, fixture);
  expect(saved.routing).toMatchObject({
    reason: 'default',
    lead: { grantId: fixture.grants.researcher },
  });
  expect(saved.routing.candidates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'Researcher', score: 0, matchedTerms: [] }),
      expect.objectContaining({
        name: 'Coder',
        score: 10,
        matchedTerms: ['database', 'typescript'],
      }),
    ]),
  );
  await visibleDecision(page, 'Researcher', 'Group default');
  await page.reload();
  await visibleDecision(page, 'Researcher', 'Group default');
  const beforeList = await state(page);
  await page.getByRole('link', { name: 'Back to tasks', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Routing decision', exact: true })).toHaveCount(0);
  expect((await state(page)).routingReads).toEqual(beforeList.routingReads);
  const href = `${paths(fixture).conversation}?routingTaskId=${saved.taskId}#routing-${saved.taskId}`;
  await page.locator(`#task-${saved.taskId}`).locator(`a[href="${href}"]`).click();
  await expect(page).toHaveURL(
    new RegExp(`\\?routingTaskId=${saved.taskId}#routing-${saved.taskId}$`),
  );
  await expect(page.locator(`#routing-${saved.taskId}`)).toBeVisible();
  await visibleDecision(page, 'Researcher', 'Group default');
  expect((await state(page)).routingReads).toEqual([...beforeList.routingReads, saved.taskId]);
  await page.reload();
  await visibleDecision(page, 'Researcher', 'Group default');
  const current = await state(page);
  expect(current.decisions).toEqual([{ taskId: saved.taskId, routing: saved.routing }]);
  noProviderInvocation(current, 1);
});

test('a current group member can explicitly mention a Bot without gaining configuration or settings permission', async ({
  page,
}) => {
  const fixture = await setup(page);
  await setDefault(page, fixture);
  expect(
    (await page.request.post(`${api}/__routing/viewer`, { data: { viewer: 'member' } })).status(),
  ).toBe(200);
  await page.goto(paths(fixture).settings);
  await expect(page.getByRole('heading', { name: 'Researcher', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear default', exact: true })).toHaveCount(0);
  const denied = await page.request.get(
    `${api}/api/v1/workspaces/${fixture.workspaceId}/bots/${fixture.bots.coder}`,
  );
  expect(denied.status()).toBe(403);
  const saved = await submit(page, fixture, fixture.grants.coder);
  expect(saved.routing).toMatchObject({
    reason: 'mention',
    lead: { grantId: fixture.grants.coder },
  });
  await visibleDecision(page, 'Coder', 'Explicit @ mention');
  await page.goto(
    `${paths(fixture).conversation}?routingTaskId=${saved.taskId}#routing-${saved.taskId}`,
  );
  await visibleDecision(page, 'Coder', 'Explicit @ mention');
  await page.reload();
  await visibleDecision(page, 'Coder', 'Explicit @ mention');
  const current = await state(page);
  expect(current.tasks[0]?.executionUser.id).toBe(fixture.memberId);
  noProviderInvocation(current, 1);
});

test('clearing the default repeats the local winner while older routing evidence stays immutable', async ({
  page,
}) => {
  const fixture = await setup(page);
  await setDefault(page, fixture);
  const original = await submit(page, fixture);
  await page.goto(paths(fixture).settings);
  await page.getByRole('button', { name: 'Clear default', exact: true }).click();
  await expect(
    page.getByText('No default Lead. Automatic routing uses local persona matching.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('input[name="expectedRevision"]')).toHaveValue('2');
  const first = await submit(page, fixture);
  const second = await submit(page, fixture);
  expect(first.taskId).not.toBe(second.taskId);
  expect(first.routing).toEqual(second.routing);
  expect(first.routing).toMatchObject({
    reason: 'local-match',
    lead: { grantId: fixture.grants.coder },
  });
  await visibleDecision(page, 'Coder', 'Local term match');
  await page.goto(
    `${paths(fixture).conversation}?routingTaskId=${first.taskId}#routing-${first.taskId}`,
  );
  await visibleDecision(page, 'Coder', 'Local term match');
  await page.goto(
    `${paths(fixture).conversation}?routingTaskId=${original.taskId}#routing-${original.taskId}`,
  );
  await visibleDecision(page, 'Researcher', 'Group default');
  await page.reload();
  await visibleDecision(page, 'Researcher', 'Group default');
  const current = await state(page);
  expect(current.decisions.find((entry) => entry.taskId === original.taskId)?.routing).toEqual(
    original.routing,
  );
  noProviderInvocation(current, 3);
});

test('an unavailable exact mention keeps the draft and does not fall back or commit a task', async ({
  page,
}) => {
  const fixture = await setup(page);
  await setDefault(page, fixture);
  await page.goto(paths(fixture).tasks);
  const mention = page.getByLabel('Mention a Bot (optional)', { exact: true });
  await mention.selectOption(fixture.grants.coder);
  await page.getByLabel('Prompt', { exact: true }).fill(prompt);
  const key = await page.locator('input[name="idempotencyKey"]').inputValue();
  expect((await page.request.post(`${api}/__routing/disable-coder`)).status()).toBe(200);
  const before = await state(page);
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The selected Bot model is currently unavailable to you. Your draft is preserved.',
  );
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(prompt);
  await expect(mention).toHaveValue(fixture.grants.coder);
  await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(key);
  await expect(page.getByRole('heading', { name: 'Saved task', exact: true })).toHaveCount(0);
  const rejected = await state(page);
  expect(rejected.counts).toEqual(before.counts);
  noProviderInvocation(rejected, 0);
  // The default remains usable, but only a separately submitted automatic turn may use it.
  const automatic = await submit(page, fixture);
  expect(automatic.routing).toMatchObject({
    reason: 'default',
    lead: { grantId: fixture.grants.researcher },
  });
  expect(automatic.routing.candidates).toHaveLength(1);
  noProviderInvocation(await state(page), 1);
});
