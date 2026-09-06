export class InstanceAlreadyClaimedError extends Error {
  constructor() {
    super('This OpenBot instance has already been claimed');
    this.name = 'InstanceAlreadyClaimedError';
  }
}

export interface ClaimInstanceRecord {
  claimedAt: Date;
  credentialUpdatedAt: Date;
  email: string;
  instanceClaimAuditId: string;
  passwordHash: string;
  sessionCreatedAt: Date;
  sessionExpiresAt: Date;
  sessionSignInAuditId: string;
  sessionTokenDigest: string;
  userDisplayName: string;
  userId: string;
  workspaceId: string;
  workspaceName: string;
}

export interface AuthRepository {
  claimInstance(record: ClaimInstanceRecord): Promise<void>;
  createSession(record: CreateSessionRecord): Promise<void>;
  findLocalCredential(normalizedEmail: string): Promise<LocalCredentialRecord | undefined>;
  findSession(tokenDigest: string, now: Date): Promise<SessionIdentityRecord | undefined>;
  isClaimed(): Promise<boolean>;
  revokeSession(record: RevokeSessionRecord): Promise<boolean>;
}

export interface LocalCredentialRecord {
  passwordHash: string;
  userDisplayName: string;
  userEmail: string;
  userId: string;
  workspaceId: string | null;
  workspaceName: string | null;
}

export interface CreateSessionRecord {
  auditId: string;
  createdAt: Date;
  expiresAt: Date;
  tokenDigest: string;
  userId: string;
}

export interface SessionIdentityRecord {
  userDisplayName: string;
  userEmail: string;
  userId: string;
  workspaceId: string | null;
  workspaceName: string | null;
}

export interface RevokeSessionRecord {
  auditId: string;
  revokedAt: Date;
  tokenDigest: string;
}
