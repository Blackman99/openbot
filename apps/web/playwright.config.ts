import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';
import chromium, { inflate } from '@sparticuz/chromium';

chromium.setGraphicsMode = false;
const chromiumEntry = import.meta.resolve('@sparticuz/chromium');
const chromiumArchive = fileURLToPath(new URL('../bin/chromium.br', chromiumEntry));
const swiftShaderArchive = fileURLToPath(new URL('../bin/swiftshader.tar.br', chromiumEntry));
const [executablePath] = await Promise.all([inflate(chromiumArchive), inflate(swiftShaderArchive)]);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // The live fixture represents one instance; scenarios reset its shared state.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: {
      args: chromium.args.filter(
        (argument) => argument !== '--single-process' && argument !== '--in-process-gpu',
      ),
      executablePath,
    },
  },
  webServer: [
    {
      command: 'node tests/e2e/fixture-api.mjs',
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
