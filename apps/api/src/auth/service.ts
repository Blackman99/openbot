import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { passwordOperations } from './password-operations.js';
export { AuthenticationBusyError } from './password-operations.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { InstanceAlreadyClaimedError, type AuthRepository } from './repository.js';

export interface SetupInput {
  displayName: string;
  email: string;
  password: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface AuthenticatedUser {
  displayName: string;
  email: string;
  id: string;
}

export interface AuthenticatedWorkspace {
  id: string;
  name: string;
}

export interface AuthenticatedSession {
  expiresAt: Date;
  sessionToken: string;
  user: AuthenticatedUser;
  workspace: AuthenticatedWorkspace | null;
}

export interface AuthenticatedOwnerSession extends AuthenticatedSession {
  workspace: AuthenticatedWorkspace;
}

export interface SessionIdentity {
  user: AuthenticatedUser;
  workspace: AuthenticatedWorkspace | null;
}

export interface AuthService {
  getSession(sessionToken: string): Promise<SessionIdentity | undefined>;
  isClaimed(): Promise<boolean>;
  signIn(input: SignInInput): Promise<AuthenticatedSession>;
  signOut(sessionToken: string): Promise<boolean>;
  setup(input: SetupInput): Promise<AuthenticatedOwnerSession>;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Email or password is incorrect');
    this.name = 'InvalidCredentialsError';
  }
}

export class InvalidAuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuthInputError';
  }
}

export interface LocalAuthDependencies {
  clock: () => Date;
  dummyPasswordHash: string;
  generateId: () => string;
  generateSessionToken: () => string;
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (encoded: string, password: string) => Promise<boolean>;
}

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_WORKSPACE_NAME = 'My Workspace';
const DEFAULT_DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$b3BlbmJvdC1kdW1teS1zYWx0LXYx$QGaw1b6sjOkg47oMglLM8HrPbHoq+oRYiEnm0e+w8x4';

export function normalizeSetupInput(input: SetupInput): SetupInput {
  const displayName = input.displayName.trim();
  const email = input.email.trim().toLowerCase();
  if (displayName.length < 1 || displayName.length > 100) {
    throw new InvalidAuthInputError('Display name must be between 1 and 100 characters');
  }
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new InvalidAuthInputError('Email address is invalid');
  }
  if (input.password.length < 12 || Buffer.byteLength(input.password, 'utf8') > 1_024) {
    throw new InvalidAuthInputError('Password must be between 12 and 1024 bytes');
  }

  return { displayName, email, password: input.password };
}

function digestSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class LocalAuthService implements AuthService {
  private readonly dependencies: LocalAuthDependencies;

  constructor(
    private readonly repository: AuthRepository,
    dependencies: Partial<LocalAuthDependencies> = {},
  ) {
    this.dependencies = {
      clock: () => new Date(),
      dummyPasswordHash: DEFAULT_DUMMY_PASSWORD_HASH,
      generateId: randomUUID,
      generateSessionToken: () => randomBytes(32).toString('base64url'),
      hashPassword,
      verifyPassword,
      ...dependencies,
    };
  }

  async setup(rawInput: SetupInput): Promise<AuthenticatedOwnerSession> {
    const input = normalizeSetupInput(rawInput);
    if (await this.repository.isClaimed()) {
      throw new InstanceAlreadyClaimedError();
    }

    const passwordHash = await passwordOperations.run(() =>
      this.dependencies.hashPassword(input.password),
    );
    const now = this.dependencies.clock();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
    const userId = this.dependencies.generateId();
    const workspaceId = this.dependencies.generateId();
    const sessionToken = this.dependencies.generateSessionToken();

    await this.repository.claimInstance({
      claimedAt: now,
      credentialUpdatedAt: now,
      email: input.email,
      instanceClaimAuditId: this.dependencies.generateId(),
      passwordHash,
      sessionCreatedAt: now,
      sessionExpiresAt: expiresAt,
      sessionSignInAuditId: this.dependencies.generateId(),
      sessionTokenDigest: digestSessionToken(sessionToken),
      userDisplayName: input.displayName,
      userId,
      workspaceId,
      workspaceName: DEFAULT_WORKSPACE_NAME,
    });

    return {
      expiresAt,
      sessionToken,
      user: { displayName: input.displayName, email: input.email, id: userId },
      workspace: { id: workspaceId, name: DEFAULT_WORKSPACE_NAME },
    };
  }

  async isClaimed(): Promise<boolean> {
    return this.repository.isClaimed();
  }

  async signIn(input: SignInInput): Promise<AuthenticatedSession> {
    const email = input.email.trim().toLowerCase();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new InvalidCredentialsError();
    }
    if (input.password.length === 0 || Buffer.byteLength(input.password, 'utf8') > 1_024) {
      throw new InvalidCredentialsError();
    }

    const credential = await this.repository.findLocalCredential(email);
    const passwordHash = credential?.passwordHash ?? this.dependencies.dummyPasswordHash;
    const valid = await passwordOperations.run(() =>
      this.dependencies.verifyPassword(passwordHash, input.password),
    );
    if (!credential || !valid) {
      throw new InvalidCredentialsError();
    }

    const now = this.dependencies.clock();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
    const sessionToken = this.dependencies.generateSessionToken();
    await this.repository.createSession({
      auditId: this.dependencies.generateId(),
      createdAt: now,
      expiresAt,
      tokenDigest: digestSessionToken(sessionToken),
      userId: credential.userId,
    });

    return {
      expiresAt,
      sessionToken,
      user: {
        displayName: credential.userDisplayName,
        email: credential.userEmail,
        id: credential.userId,
      },
      workspace:
        credential.workspaceId !== null && credential.workspaceName !== null
          ? { id: credential.workspaceId, name: credential.workspaceName }
          : null,
    };
  }

  async getSession(sessionToken: string): Promise<SessionIdentity | undefined> {
    const session = await this.repository.findSession(
      digestSessionToken(sessionToken),
      this.dependencies.clock(),
    );
    if (!session) {
      return undefined;
    }

    return {
      user: {
        displayName: session.userDisplayName,
        email: session.userEmail,
        id: session.userId,
      },
      workspace:
        session.workspaceId !== null && session.workspaceName !== null
          ? { id: session.workspaceId, name: session.workspaceName }
          : null,
    };
  }

  async signOut(sessionToken: string): Promise<boolean> {
    return this.repository.revokeSession({
      auditId: this.dependencies.generateId(),
      revokedAt: this.dependencies.clock(),
      tokenDigest: digestSessionToken(sessionToken),
    });
  }
}
