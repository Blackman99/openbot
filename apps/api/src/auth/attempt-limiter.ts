import { createHmac, randomBytes } from 'node:crypto';

export interface AuthenticationAttempt {
  clientIp: string;
  email: string;
}

export interface AuthenticationAttemptLimiterOptions {
  accountKeySecret?: string | Uint8Array;
  accountMaxFailures?: number;
  accountWindowMs?: number;
  clientMaxFailures?: number;
  clientWindowMs?: number;
  maxTrackedAccounts?: number;
  maxTrackedClients?: number;
  now?: () => number;
}

interface FailureWindow {
  failures: number;
  resetAt: number;
}

class FixedWindowFailureBucket {
  private readonly failures = new Map<string, FailureWindow>();

  constructor(
    private readonly maxFailures: number,
    private readonly maxTrackedKeys: number,
    private readonly now: () => number,
    private readonly windowMs: number,
  ) {}

  retryAfterSeconds(key: string): number | undefined {
    const window = this.readActiveWindow(key);
    if (!window || window.failures < this.maxFailures) {
      return undefined;
    }

    return Math.max(1, Math.ceil((window.resetAt - this.now()) / 1_000));
  }

  recordFailure(key: string): void {
    const active = this.readActiveWindow(key);
    if (active) {
      active.failures += 1;
      return;
    }

    this.makeRoom();
    this.failures.set(key, {
      failures: 1,
      resetAt: this.now() + this.windowMs,
    });
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private makeRoom(): void {
    if (this.failures.size < this.maxTrackedKeys) {
      return;
    }

    const currentTime = this.now();
    for (const [key, window] of this.failures) {
      if (window.resetAt <= currentTime) {
        this.failures.delete(key);
      }
    }
    while (this.failures.size >= this.maxTrackedKeys) {
      const oldestKey = this.failures.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.failures.delete(oldestKey);
    }
  }

  private readActiveWindow(key: string): FailureWindow | undefined {
    const window = this.failures.get(key);
    if (window && window.resetAt <= this.now()) {
      this.failures.delete(key);
      return undefined;
    }
    return window;
  }
}

export function authenticationAttemptKey(
  email: string,
  accountKeySecret: string | Uint8Array,
): string {
  return createHmac('sha256', accountKeySecret).update(email.trim().toLowerCase()).digest('hex');
}

export class AuthenticationAttemptLimiter {
  private readonly accountFailures: FixedWindowFailureBucket;
  private readonly accountKeySecret: string | Uint8Array;
  private readonly clientFailures: FixedWindowFailureBucket;

  constructor({
    accountKeySecret = randomBytes(32),
    accountMaxFailures = 20,
    accountWindowMs = 5 * 60_000,
    clientMaxFailures = 10,
    clientWindowMs = 5 * 60_000,
    maxTrackedAccounts = 10_000,
    maxTrackedClients = 10_000,
    now = Date.now,
  }: AuthenticationAttemptLimiterOptions = {}) {
    this.accountKeySecret = accountKeySecret;
    this.accountFailures = new FixedWindowFailureBucket(
      accountMaxFailures,
      maxTrackedAccounts,
      now,
      accountWindowMs,
    );
    this.clientFailures = new FixedWindowFailureBucket(
      clientMaxFailures,
      maxTrackedClients,
      now,
      clientWindowMs,
    );
  }

  retryAfterSeconds(attempt: AuthenticationAttempt): number | undefined {
    const accountRetry = this.accountFailures.retryAfterSeconds(this.accountKey(attempt.email));
    const clientRetry = this.clientFailures.retryAfterSeconds(attempt.clientIp);
    if (accountRetry === undefined) {
      return clientRetry;
    }
    if (clientRetry === undefined) {
      return accountRetry;
    }
    return Math.max(accountRetry, clientRetry);
  }

  recordFailure(attempt: AuthenticationAttempt): void {
    this.accountFailures.recordFailure(this.accountKey(attempt.email));
    this.clientFailures.recordFailure(attempt.clientIp);
  }

  clearAccount(email: string): void {
    this.accountFailures.clear(this.accountKey(email));
  }

  private accountKey(email: string): string {
    return authenticationAttemptKey(email, this.accountKeySecret);
  }
}
