import { expect, it } from 'vitest';
import { readProviderConfig } from '../../src/providers/config.js';

it('enables encrypted providers only with a valid operator key and explicit local-network policy', () => {
  expect(readProviderConfig({})).toBeUndefined();
  expect(() =>
    readProviderConfig({ OPENBOT_PROVIDER_ENCRYPTION_KEY: 'secret-invalid-key' }),
  ).toThrow('OPENBOT_PROVIDER_ENCRYPTION_KEY must be a base64 encoded 32-byte key');
  const key = Buffer.alloc(32, 9).toString('base64');
  expect(readProviderConfig({ OPENBOT_PROVIDER_ENCRYPTION_KEY: key })).toEqual({
    encryptionKey: key,
    network: { hosts: ['api.openai.com'], schemes: ['https'], privateCidrs: [] },
  });
  expect(
    readProviderConfig({
      OPENBOT_PROVIDER_ENCRYPTION_KEY: key,
      OPENBOT_PROVIDER_ALLOWED_HOSTS: 'api.openai.com,localhost',
      OPENBOT_PROVIDER_ALLOWED_SCHEMES: 'https,http',
      OPENBOT_PROVIDER_PRIVATE_CIDRS: '127.0.0.0/8,::1/128',
    }),
  ).toMatchObject({
    network: {
      hosts: ['api.openai.com', 'localhost'],
      schemes: ['https', 'http'],
      privateCidrs: ['127.0.0.0/8', '::1/128'],
    },
  });
  expect(() =>
    readProviderConfig({
      OPENBOT_PROVIDER_ENCRYPTION_KEY: key,
      OPENBOT_PROVIDER_PRIVATE_CIDRS: 'bad-cidr',
    }),
  ).toThrow('invalid_provider_network_policy');
});
