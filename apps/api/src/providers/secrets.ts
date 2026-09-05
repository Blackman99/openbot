import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProviderError } from './url-policy.js';

export interface ProviderCredentials {
  apiKey: string;
  headers: Record<string, string>;
}

export class ProviderSecretBox {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== base64Key) {
      throw new ProviderError(
        'OPENBOT_PROVIDER_ENCRYPTION_KEY must be a base64 encoded 32-byte key',
      );
    }
  }

  seal(value: ProviderCredentials, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  open(value: string, context: string): ProviderCredentials {
    try {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
      ) as ProviderCredentials;
    } catch {
      throw new ProviderError('provider_credentials_unavailable');
    }
  }
}

export function redactProviderText(text: string, credentials: ProviderCredentials): string {
  const values = [credentials.apiKey, ...Object.values(credentials.headers)]
    .flatMap((value) => [value, value.trim()])
    .filter(Boolean);
  const variants = [
    ...new Set(
      values.flatMap((value) => [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
      ]),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  // Match original text once. Never scan replacement markers again, including when
  // service-level defense in depth redacts an already-redacted probe report.
  const pattern = new RegExp(
    ['\\[REDACTED\\]', '[Bb][Ee][Aa][Rr][Ee][Rr]\\s+[^\\s"\'<>]+', ...variants].join('|'),
    'gu',
  );
  return new TextDecoder().decode(
    Buffer.from(text.replace(pattern, '[REDACTED]')).subarray(0, 65_536),
    { stream: true },
  );
}
