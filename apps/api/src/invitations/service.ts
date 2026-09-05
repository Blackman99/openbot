import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { passwordOperations } from '../auth/password-operations.js';
import { hashPassword } from '../auth/passwords.js';
import {
  normalizeSetupInput,
  type AuthenticatedSession,
  type SessionIdentity,
} from '../auth/service.js';

export type InvitationRole = 'administrator' | 'member';
export type Invitation = {
  id: string;
  workspaceId: string;
  email: string;
  role: InvitationRole;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  consumedAt: Date | null;
};
export interface InvitationWrite extends Invitation {
  actorUserId: string;
  auditId: string;
  tokenDigest: string;
}
export interface InvitationAccept {
  tokenDigest: string;
  email: string;
  userId: string;
  newAccount?: { displayName: string; passwordHash: string };
  now: Date;
  auditId: string;
  session?: { tokenDigest: string; expiresAt: Date; auditId: string };
}
export interface InvitationRepository {
  revoke(
    actorUserId: string,
    workspaceId: string,
    invitationId: string,
    now: Date,
    auditId: string,
  ): Promise<void>;
  findAvailable(tokenDigest: string, now: Date): Promise<Invitation | undefined>;
  accept(record: InvitationAccept): Promise<SessionIdentity>;
  create(record: InvitationWrite): Promise<void>;
  list(actorUserId: string, workspaceId: string): Promise<Invitation[]>;
}
export class InvitationInputError extends Error {}
export class InvitationAccessError extends Error {}
export class InvitationWorkspaceError extends Error {}
export class InvitationUnavailableError extends Error {}

export const invitationDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export function validId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id);
}
export function readEmail(value: unknown): string {
  if (typeof value !== 'string') throw new InvitationInputError();
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
    throw new InvitationInputError();
  return email;
}
export class InvitationService {
  constructor(
    private readonly repository: InvitationRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly passwordHasher: (password: string) => Promise<string> = hashPassword,
  ) {}

  async create(actorUserId: string, workspaceId: string, input: unknown) {
    if (!validId(workspaceId)) throw new InvitationWorkspaceError();
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new InvitationInputError();
    const { email, role, expiresInDays } = input as Record<string, unknown>;
    if (
      (role !== 'member' && role !== 'administrator') ||
      typeof expiresInDays !== 'number' ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > 30
    )
      throw new InvitationInputError();
    const now = this.clock();
    const token = randomBytes(32).toString('base64url');
    const invitation: Invitation = {
      id: randomUUID(),
      workspaceId,
      email: readEmail(email),
      role,
      createdAt: now,
      expiresAt: new Date(now.getTime() + expiresInDays * 86_400_000),
      revokedAt: null,
      consumedAt: null,
    };
    await this.repository.create({
      ...invitation,
      tokenDigest: invitationDigest(token),
      actorUserId,
      auditId: randomUUID(),
    });
    return { invitation, token };
  }
  async accept(
    input: unknown,
    identity?: SessionIdentity,
  ): Promise<{ identity: SessionIdentity; session?: AuthenticatedSession }> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new InvitationInputError();
    const body = input as Record<string, unknown>;
    if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(body.token))
      throw new InvitationUnavailableError();
    const tokenDigest = invitationDigest(body.token);
    const invitation = await this.repository.findAvailable(tokenDigest, this.clock());
    if (!invitation) throw new InvitationUnavailableError();
    if (identity) {
      if (identity.user.email.toLowerCase() !== invitation.email)
        throw new InvitationUnavailableError();
      return {
        identity: await this.repository.accept({
          tokenDigest,
          email: identity.user.email.toLowerCase(),
          userId: identity.user.id,
          now: this.clock(),
          auditId: randomUUID(),
        }),
      };
    }
    if (
      typeof body.email !== 'string' ||
      typeof body.displayName !== 'string' ||
      typeof body.password !== 'string'
    )
      throw new InvitationInputError();
    const account = normalizeSetupInput({
      email: body.email,
      displayName: body.displayName,
      password: body.password,
    });
    if (account.email !== invitation.email) throw new InvitationUnavailableError();
    const passwordHash = await passwordOperations.run(() => this.passwordHasher(account.password));
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
    const sessionToken = randomBytes(32).toString('base64url');
    const accepted = await this.repository.accept({
      tokenDigest,
      email: account.email,
      userId: randomUUID(),
      newAccount: { displayName: account.displayName, passwordHash },
      now,
      auditId: randomUUID(),
      session: { tokenDigest: invitationDigest(sessionToken), expiresAt, auditId: randomUUID() },
    });
    return { identity: accepted, session: { ...accepted, expiresAt, sessionToken } };
  }
  revoke(actorUserId: string, workspaceId: string, invitationId: string): Promise<void> {
    if (!validId(workspaceId)) throw new InvitationWorkspaceError();
    if (!validId(invitationId)) throw new InvitationUnavailableError();
    return this.repository.revoke(
      actorUserId,
      workspaceId,
      invitationId,
      this.clock(),
      randomUUID(),
    );
  }
  list(actorUserId: string, workspaceId: string): Promise<Invitation[]> {
    if (!validId(workspaceId)) throw new InvitationWorkspaceError();
    return this.repository.list(actorUserId, workspaceId);
  }
}
