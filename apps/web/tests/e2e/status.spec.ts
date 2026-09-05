import { expect, test } from '@playwright/test';

test.describe('status page', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:4399/__scenario', {
      data: { scenario: 'ready' },
    });
  });

  test('renders Ready from a live v1 API response', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('status')).toHaveText('Ready');
  });

  test('renders Unavailable from a live API 503 response', async ({ page, request }) => {
    await request.post('http://127.0.0.1:4399/__scenario', {
      data: { scenario: 'unavailable' },
    });

    await page.goto('/');

    await expect(page.getByRole('status')).toHaveText('Unavailable');
    await expect(page.locator('body')).not.toContainText('ECONNREFUSED');
  });
});
