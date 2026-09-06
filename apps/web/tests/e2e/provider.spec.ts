import { expect, test } from '@playwright/test';

for (const protocol of ['openai-responses', 'anthropic-messages'] as const) {
  test(`manages a personal ${protocol} model through settings with masked credentials and probe evidence`, async ({
    page,
    request,
  }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await request.post('http://127.0.0.1:4399/__scenario', { data: { scenario: 'unclaimed' } });
    await page.goto('/setup');
    await page.getByLabel('Display name').fill('Ada');
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
    await page.getByLabel('Setup token').fill('local-only-openbot-setup-token-change-me');
    await page.getByRole('button', { name: 'Create owner' }).click();
    await expect(page).toHaveURL('/app/workspaces/workspace-id');
    await page.getByRole('link', { name: 'Personal models' }).click();
    await expect(page).toHaveURL('/app/settings/models');
    const add = page.getByRole('region', { name: 'Add a model' });
    await add.getByLabel('Name', { exact: true }).fill('Personal model');
    if (protocol === 'openai-responses') {
      await add.getByLabel('Protocol').selectOption('anthropic-messages');
      await add.getByLabel('Anthropic version').fill('latest');
    }
    await add.getByLabel('Protocol').selectOption(protocol);
    if (protocol === 'anthropic-messages')
      await add.getByLabel('Anthropic version').fill('2023-01-01');
    await add.getByLabel('Base URL').fill('https://models.example/v1');
    await add.getByLabel('Model ID').fill('chat-model');
    await add.getByLabel('API key', { exact: true }).fill('private-api-key');
    await add.getByLabel('Custom headers (JSON)').fill('{"x-secret":"private-header"}');
    await add.getByRole('button', { name: 'Test and save' }).click();
    const model = page.getByRole('article', { name: 'Personal model' });
    await expect(model).toBeVisible();
    await expect(model).toContainText('API key: configured');
    await expect(model).toContainText('Text stream: passed');
    await expect(model).toContainText(
      protocol === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Responses',
    );
    await expect(page.locator('body')).not.toContainText('private-api-key');
    await expect(page.locator('body')).not.toContainText('private-header');
    await page.reload();
    await model.getByText('Edit connection', { exact: true }).click();
    await expect(model.getByLabel('Protocol')).toHaveValue(protocol);
    if (protocol === 'anthropic-messages') {
      await expect(model.getByLabel('Anthropic version')).toHaveValue('2023-01-01');
      await model.getByLabel('Anthropic version').fill('2023-06-01');
    } else {
      await model.getByLabel('Protocol').selectOption('anthropic-messages');
      await model.getByLabel('Anthropic version').fill('latest');
      await model.getByLabel('Protocol').selectOption('openai-chat');
    }
    await model.getByLabel('Name', { exact: true }).fill('Renamed model');
    await model.getByRole('button', { name: 'Test and save' }).click();
    const renamed = page.getByRole('article', { name: 'Renamed model' });
    await expect(renamed).toContainText(
      protocol === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions',
    );
    if (protocol === 'anthropic-messages') {
      await page.reload();
      await renamed.getByText('Edit connection', { exact: true }).click();
      await expect(renamed.getByLabel('Anthropic version')).toHaveValue('2023-06-01');
    }
    await renamed.getByRole('button', { name: 'Test again' }).click();
    await expect(renamed).toContainText('Structured actions: passed');
    await renamed.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(renamed).toContainText('Disabled');
    await renamed.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(0);
    expect(browserErrors).toEqual([]);
  });
}
