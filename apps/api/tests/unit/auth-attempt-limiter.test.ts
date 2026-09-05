import { describe, expect, it } from 'vitest';

import {
  authenticationAttemptKey,
  AuthenticationAttemptLimiter,
} from '../../src/auth/attempt-limiter.js';

describe('AuthenticationAttemptLimiter', () => {
  const accountKeySecret = Buffer.alloc(32, 7);

  it('uses a keyed, irreversible identifier for normalized account names', () => {
    const canonical = authenticationAttemptKey('owner@example.com', accountKeySecret);

    expect(authenticationAttemptKey(' OWNER@Example.com ', accountKeySecret)).toBe(canonical);
    expect(authenticationAttemptKey('other@example.com', accountKeySecret)).not.toBe(canonical);
    expect(authenticationAttemptKey('owner@example.com', Buffer.alloc(32, 8))).not.toBe(canonical);
    expect(canonical).toMatch(/^[a-f0-9]{64}$/u);
    expect(canonical).not.toContain('owner@example.com');
  });

  it('blocks an account across clients for the remainder of a deterministic window', () => {
    let now = 1_000;
    const limiter = new AuthenticationAttemptLimiter({
      accountKeySecret,
      accountMaxFailures: 2,
      accountWindowMs: 10_000,
      clientMaxFailures: 20,
      now: () => now,
    });

    limiter.recordFailure({ clientIp: '192.0.2.1', email: 'owner@example.com' });
    limiter.recordFailure({ clientIp: '192.0.2.2', email: ' OWNER@example.com ' });

    expect(limiter.retryAfterSeconds({ clientIp: '192.0.2.3', email: 'owner@example.com' })).toBe(
      10,
    );
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.1', email: 'other@example.com' }),
    ).toBeUndefined();

    now += 9_001;
    expect(limiter.retryAfterSeconds({ clientIp: '192.0.2.3', email: 'owner@example.com' })).toBe(
      1,
    );
    now += 999;
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.3', email: 'owner@example.com' }),
    ).toBeUndefined();
  });

  it('blocks a client that rotates through account names without locking every account early', () => {
    const limiter = new AuthenticationAttemptLimiter({
      accountKeySecret,
      accountMaxFailures: 2,
      clientMaxFailures: 4,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure({
        clientIp: '192.0.2.1',
        email: `target-${attempt}@example.com`,
      });
    }

    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.1', email: 'fresh@example.com' }),
    ).toBeDefined();
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.2', email: 'target-0@example.com' }),
    ).toBeUndefined();
  });

  it('stops one source before that source alone can fill the default account bucket', () => {
    const limiter = new AuthenticationAttemptLimiter({ accountKeySecret });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.recordFailure({ clientIp: '192.0.2.1', email: 'owner@example.com' });
    }

    expect(limiter.retryAfterSeconds({ clientIp: '192.0.2.1', email: 'other@example.com' })).toBe(
      300,
    );
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.2', email: 'owner@example.com' }),
    ).toBeUndefined();
  });

  it('clears only account failures after a successful authentication', () => {
    const limiter = new AuthenticationAttemptLimiter({
      accountKeySecret,
      accountMaxFailures: 2,
      clientMaxFailures: 3,
    });

    limiter.recordFailure({ clientIp: '192.0.2.1', email: 'owner@example.com' });
    limiter.recordFailure({ clientIp: '192.0.2.2', email: 'owner@example.com' });
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.3', email: 'owner@example.com' }),
    ).toBeDefined();

    limiter.clearAccount(' OWNER@EXAMPLE.COM ');
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.3', email: 'owner@example.com' }),
    ).toBeUndefined();

    limiter.recordFailure({ clientIp: '192.0.2.1', email: 'second@example.com' });
    limiter.clearAccount('second@example.com');
    limiter.recordFailure({ clientIp: '192.0.2.1', email: 'third@example.com' });
    limiter.clearAccount('third@example.com');
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.1', email: 'fresh@example.com' }),
    ).toBeDefined();
  });

  it('bounds account and client state with deterministic oldest-entry eviction', () => {
    const limiter = new AuthenticationAttemptLimiter({
      accountKeySecret,
      accountMaxFailures: 1,
      clientMaxFailures: 1,
      maxTrackedAccounts: 2,
      maxTrackedClients: 2,
    });

    for (const [suffix, clientIp] of [
      ['one', '192.0.2.1'],
      ['two', '192.0.2.2'],
      ['three', '192.0.2.3'],
    ] as const) {
      limiter.recordFailure({ clientIp, email: `${suffix}@example.com` });
    }

    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.100', email: 'one@example.com' }),
    ).toBeUndefined();
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.100', email: 'two@example.com' }),
    ).toBeDefined();
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.1', email: 'fresh@example.com' }),
    ).toBeUndefined();
    expect(
      limiter.retryAfterSeconds({ clientIp: '192.0.2.2', email: 'fresh@example.com' }),
    ).toBeDefined();
  });
});
