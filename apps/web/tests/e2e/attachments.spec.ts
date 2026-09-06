import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
const api = 'http://127.0.0.1:4399',
  workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
test('uploads above the avatar limit, retries one message, reloads, downloads and purges its private file', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(api + '/__scenario', { data: { scenario: 'unclaimed' } });
  await page.request.post(api + '/__conversation/setup');
  await page.goto(`/app/workspaces/${workspaceId}/conversations`);
  await page.getByRole('button', { name: 'Open Research group', exact: true }).click();
  const content = Buffer.alloc(3 * 1024 * 1024, 65);
  await page.getByLabel('Message', { exact: true }).fill('Private report');
  await page
    .getByLabel('Attachment (optional)')
    .setInputFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: content });
  const key = await page.locator('form[action*="/append"] [name="idempotencyKey"]').inputValue();
  await request.post(api + '/__conversation/state', { data: { failAfterCommit: true } });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('same command key');
  await expect(page.locator('form[action*="/append"] [name="idempotencyKey"]')).toHaveValue(key);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download report.txt' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(1);
  const downloadUrl = await page
    .getByRole('link', { name: 'Download report.txt' })
    .getAttribute('href');
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download report.txt' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('report.txt');
  const downloaded = await readFile((await download.path())!);
  expect(createHash('sha256').update(downloaded).digest('hex')).toBe(
    createHash('sha256').update(content).digest('hex'),
  );
  const state = await (await request.get(api + '/__conversation/state')).json();
  expect(state.threads[0].messages).toHaveLength(1);
  expect(state.attempts).toHaveLength(2);
  await page.locator('summary').filter({ hasText: 'Permanently purge message and files' }).click();
  await page.getByRole('button', { name: 'Permanently purge', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Message and files permanently purged.' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download report.txt' })).toHaveCount(0);
  expect((await page.request.get(downloadUrl!)).status()).toBe(403);
  expect(errors).toEqual([]);
});
