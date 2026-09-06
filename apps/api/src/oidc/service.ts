import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/service.js';
import type { OidcClaims, OidcProof, OidcProvider } from './provider.js';
export class OidcError extends Error {
  constructor(
    public readonly code:
      | 'invalid_flow'
      | 'authentication_required'
      | 'identity_not_linked'
      | 'identity_conflict'
      | 'last_credential'
      | 'invitation_unavailable'
      | 'provider_unavailable' = 'invalid_flow',
  ) {
    super(code);
  }
}
export type OidcPurpose = 'signin' | 'link' | 'invite';
export interface OidcTransaction {
  stateDigest: string;
  browserDigest: string;
  purpose: OidcPurpose;
  nonce: string;
  verifier: string;
  sessionDigest: string | null;
  invitationDigest: string | null;
  createdAt: Date;
  expiresAt: Date;
}
export interface OidcCompletion {
  transaction: OidcTransaction;
  claims: OidcClaims;
  now: Date;
  sessionDigest: string;
  expiresAt: Date;
  userId: string;
  auditId: string;
  identityAuditId: string;
  invitationAuditId: string;
}
export interface OidcRepository {
  save(transaction: OidcTransaction): Promise<void>;
  consume(
    stateDigest: string,
    browserDigest: string,
    now: Date,
  ): Promise<OidcTransaction | undefined>;
  invitationAvailable(digest: string, now: Date): Promise<boolean>;
  complete(completion: OidcCompletion): Promise<void>;
  settings(
    sessionDigest: string,
    issuer: string,
    now: Date,
  ): Promise<{ linked: boolean; canUnlink: boolean }>;
  unlink(sessionDigest: string, issuer: string, now: Date, auditId: string): Promise<void>;
}
export const oidcDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const validOidcToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
export class OidcService {
  constructor(
    private readonly auth: AuthService,
    private readonly repository: OidcRepository,
    private readonly provider: OidcProvider,
    readonly issuer: string,
    private readonly callbackUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async start(
    purpose: OidcPurpose,
    sessionToken?: string,
    invitationToken?: string,
  ): Promise<{ authorizationUrl: string; browserToken: string; expiresAt: Date }> {
    if (!['signin', 'link', 'invite'].includes(purpose) || !(await this.auth.isClaimed()))
      throw new OidcError();
    if (purpose === 'link' && (!sessionToken || !(await this.auth.getSession(sessionToken))))
      throw new OidcError('authentication_required');
    const now = this.clock();
    if (
      purpose === 'invite' &&
      (!validOidcToken(invitationToken) ||
        !(await this.repository.invitationAvailable(oidcDigest(invitationToken), now)))
    )
      throw new OidcError('invitation_unavailable');
    const random = () => randomBytes(32).toString('base64url');
    const proof: OidcProof = { state: random(), nonce: random(), verifier: random() };
    const browserToken = random();
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    let authorizationUrl: string;
    try {
      authorizationUrl = await this.provider.authorize(proof);
    } catch {
      throw new OidcError('provider_unavailable');
    }
    await this.repository.save({
      stateDigest: oidcDigest(proof.state),
      browserDigest: oidcDigest(browserToken),
      purpose,
      nonce: proof.nonce,
      verifier: proof.verifier,
      sessionDigest: purpose === 'link' && sessionToken ? oidcDigest(sessionToken) : null,
      invitationDigest:
        purpose === 'invite' && invitationToken ? oidcDigest(invitationToken) : null,
      createdAt: now,
      expiresAt,
    });
    return { authorizationUrl, browserToken, expiresAt };
  }
  async finish(
    callbackUrl: string,
    browserToken: string,
    sessionToken?: string,
  ): Promise<{ destination: string; sessionToken?: string; expiresAt?: Date }> {
    let callback: URL;
    try {
      callback = new URL(callbackUrl);
    } catch {
      throw new OidcError();
    }
    const state = callback.searchParams.get('state');
    if (
      callback.origin + callback.pathname !== this.callbackUrl ||
      callback.hash ||
      callback.username ||
      callback.password ||
      callback.searchParams.getAll('state').length !== 1 ||
      callback.searchParams.getAll('code').length !== 1 ||
      !validOidcToken(state) ||
      !validOidcToken(browserToken)
    )
      throw new OidcError();
    const transaction = await this.repository.consume(
      oidcDigest(state),
      oidcDigest(browserToken),
      this.clock(),
    );
    if (!transaction) throw new OidcError();
    if (
      transaction.purpose === 'link' &&
      (!sessionToken ||
        oidcDigest(sessionToken) !== transaction.sessionDigest ||
        !(await this.auth.getSession(sessionToken)))
    )
      throw new OidcError('authentication_required');
    let claims: OidcClaims;
    try {
      claims = await this.provider.redeem(callback.href, {
        state,
        nonce: transaction.nonce,
        verifier: transaction.verifier,
      });
    } catch {
      throw new OidcError();
    }
    const now = this.clock();
    if (transaction.expiresAt <= now) throw new OidcError();
    const newSessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
    await this.repository.complete({
      transaction,
      claims,
      now,
      sessionDigest: oidcDigest(newSessionToken),
      expiresAt,
      userId: randomUUID(),
      auditId: randomUUID(),
      identityAuditId: randomUUID(),
      invitationAuditId: randomUUID(),
    });
    return transaction.purpose === 'link'
      ? { destination: '/app/security' }
      : { destination: '/app', sessionToken: newSessionToken, expiresAt };
  }
  async settings(sessionToken: string | undefined) {
    if (!sessionToken) throw new OidcError('authentication_required');
    return this.repository.settings(oidcDigest(sessionToken), this.issuer, this.clock());
  }
  async unlink(sessionToken?: string) {
    if (!sessionToken) throw new OidcError('authentication_required');
    await this.repository.unlink(oidcDigest(sessionToken), this.issuer, this.clock(), randomUUID());
  }
}
