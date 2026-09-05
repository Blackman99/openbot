import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({
  ...base,
  testMatch: '**/oidc.spec.ts',
  testIgnore: [],
  webServer: [
    {
      command: 'pnpm --filter @openbot/api exec node --import tsx tests/e2e/oidc-api.ts',
      reuseExistingServer: false,
      url: 'http://127.0.0.1:4399/api/v1/status',
    },
    {
      command: 'pnpm build && node build',
      env: {
        API_BASE_URL: 'http://127.0.0.1:4399',
        HOST: '127.0.0.1',
        ORIGIN: 'http://127.0.0.1:4173',
        PORT: '4173',
        WEB_ORIGIN: 'http://127.0.0.1:4173',
      },
      reuseExistingServer: false,
      url: 'http://127.0.0.1:4173',
    },
  ],
});
