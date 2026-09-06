import { expect, it } from 'vitest';
import { ProviderSecretBox, redactProviderText } from '../../src/providers/secrets.js';

it('authenticates encrypted credentials with fresh nonces and connection-bound associated data', () => {
  const box = new ProviderSecretBox(Buffer.alloc(32, 7).toString('base64'));
  const secrets = {
    apiKey: 'secret-key',
    headers: { authorization: 'Bearer secret', 'x-api-key': 'header-secret' },
  };
  const first = box.seal(secrets, 'owner/connection');
  const second = box.seal(secrets, 'owner/connection');
  expect(first).not.toEqual(second);
  expect(JSON.stringify(first)).not.toContain('secret');
  expect(box.open(first, 'owner/connection')).toEqual(secrets);
  expect(() => box.open(first, 'other/connection')).toThrow('provider_credentials_unavailable');
  expect(() => box.open(first.slice(0, -6) + 'AAAAAA', 'owner/connection')).toThrow(
    'provider_credentials_unavailable',
  );
});

it('keeps repeated redaction bounded and stable for duplicate short credentials', () => {
  const credentials = {
    apiKey: '',
    headers: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x-key-${i}`, 'E'])),
  };
  const once = redactProviderText('E', credentials);
  expect(once).toBe('[REDACTED]');
  expect(redactProviderText(once, credentials)).toBe('[REDACTED]');
  expect(
    Buffer.byteLength(redactProviderText('E'.repeat(65_536), credentials)),
  ).toBeLessThanOrEqual(65_536);
});

it('caps UTF-8 evidence without producing a partial code point', () => {
  const raw = 'x' + '😀'.repeat(20_000);
  const result = redactProviderText(raw, { apiKey: '', headers: {} });
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(65_536);
  expect(result.includes('�')).toBe(false);
});
