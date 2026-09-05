import { readApiConfig } from './config.js';
import { buildProductionApp } from './runtime.js';
import { readProviderConfig } from './providers/config.js';

try {
  const config = readApiConfig(process.env);
  const providers = readProviderConfig(process.env);
  const app = buildProductionApp({
    database: config.database,
    databaseConnectionTimeoutMs: config.databaseConnectionTimeoutMs,
    databaseQueryTimeoutMs: config.databaseQueryTimeoutMs,
    logger: true,
    setupTokenDigest: config.setupTokenDigest,
    webOrigin: config.webOrigin,
    ...(providers ? { providers } : {}),
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown startup failure';
  console.error(`API startup failed: ${message}`);
  process.exitCode = 1;
}
