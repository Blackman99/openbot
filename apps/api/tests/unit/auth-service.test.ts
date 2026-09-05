import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationBusyError,
  InvalidCredentialsError,
  LocalAuthService,
} from '../../src/auth/service.js';
import { verifyPassword as verifyArgon2Password } from '../../src/auth/passwords.js';
import type { AuthRepository } from '../../src/auth/repository.js';

function repository(overrides: Partial<AuthRepository>): AuthRepository {
  return {
    claimInstance: async () => undefined,
    createSession: async () => undefined,
    findLocalCredential: async () => undefined,
    findSession: async () => undefined,
    isClaimed: async () => false,
    revokeSession: async () => false,
    ...overrides,
  };
}

describe('authentication resource limits', () => {
  it('ships a valid Argon2id dummy credential for the default unknown-email path', async () => {
    let dummyHashIsValid = false;
    const verifyPassword = vi.fn(async (encoded: string) => {
      dummyHashIsValid = await verifyArgon2Password(
        encoded,
        'OpenBot dummy credential, never valid.',
      );
      return false;
    });
    const service = new LocalAuthService(repository({}), { verifyPassword });

    await expect(
      service.signIn({ email: 'unknown@example.com', password: 'invalid password' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(verifyPassword).toHaveBeenCalledOnce();
    expect(dummyHashIsValid).toBe(true);
  });

  it('verifies a preconfigured dummy hash exactly once for an unknown email without hashing first', async () => {
    const dummyPasswordHash =
      '$argon2id$v=19$m=8192,t=2,p=2$MDEyMzQ1Njc4OWFiY2RlZg$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
    const hashPassword = vi.fn(async () => {
      throw new Error('sign-in must not hash a dummy password');
    });
    const verifyPassword = vi.fn(async () => false);
    const service = new LocalAuthService(repository({}), {
      dummyPasswordHash,
      hashPassword,
      verifyPassword,
    });

    await expect(
      service.signIn({ email: 'unknown@example.com', password: 'invalid password' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(hashPassword).not.toHaveBeenCalled();
    expect(verifyPassword).toHaveBeenCalledOnce();
    expect(verifyPassword).toHaveBeenCalledWith(dummyPasswordHash, 'invalid password');
  });

  it('caps simultaneous password verification before unauthenticated requests fan out Argon2 memory', async () => {
    const pending: Array<(value: boolean) => void> = [];
    const verifyPassword = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          pending.push(resolve);
          if (pending.length > 2) {
            resolve(false);
          }
        }),
    );
    const service = new LocalAuthService(
      repository({
        findLocalCredential: async () => ({
          passwordHash: '$argon2id$test-only',
          userDisplayName: 'Ada',
          userEmail: 'ada@example.com',
          userId: 'user-id',
          workspaceId: 'workspace-id',
          workspaceName: 'My Workspace',
        }),
      }),
      { verifyPassword },
    );

    const first = service.signIn({ email: 'ada@example.com', password: 'first invalid value' });
    const second = service.signIn({ email: 'ada@example.com', password: 'second invalid value' });
    await vi.waitFor(() => expect(verifyPassword).toHaveBeenCalledTimes(2));
    const thirdError = await service
      .signIn({ email: 'ada@example.com', password: 'third invalid value' })
      .catch((error: unknown) => error);

    pending.slice(0, 2).forEach((resolve) => resolve(false));
    await expect(first).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(second).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(thirdError).toBeInstanceOf(AuthenticationBusyError);
    expect(verifyPassword).toHaveBeenCalledTimes(2);
  });
});
