import { argon2 } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';

describe('Argon2id passwords', () => {
  it('creates a self-describing Argon2id hash and verifies only the original password', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    await expect(verifyPassword(encoded, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(encoded, 'incorrect password')).resolves.toBe(false);
  });

  it('verifies bounded Argon2id cost profiles without accepting resource-exhausting parameters', async () => {
    const password = 'an older password profile';
    const salt = Buffer.alloc(16, 3);
    const digest = await new Promise<Buffer>((resolve, reject) => {
      argon2(
        'argon2id',
        {
          memory: 32_768,
          message: password,
          nonce: salt,
          parallelism: 2,
          passes: 2,
          tagLength: 32,
        },
        (error, value) => (error ? reject(error) : resolve(value)),
      );
    });
    const encoded = `$argon2id$v=19$m=32768,t=2,p=2$${salt.toString('base64').replace(/=+$/u, '')}$${digest.toString('base64').replace(/=+$/u, '')}`;

    await expect(verifyPassword(encoded, password)).resolves.toBe(true);
    await expect(verifyPassword(encoded.replace('m=32768', 'm=2097152'), password)).resolves.toBe(
      false,
    );
    await expect(verifyPassword('$argon2id$malformed', password)).resolves.toBe(false);
  });
});
