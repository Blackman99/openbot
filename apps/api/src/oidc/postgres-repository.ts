import { createHash } from 'node:crypto';
import { acceptInvitationWithinTransaction } from '../invitations/postgres-invitation-repository.js';
import { InvitationUnavailableError, readEmail } from '../invitations/service.js';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import {
  OidcError,
  type OidcRepository,
  type OidcTransaction,
  type OidcCompletion,
} from './service.js';
const columns =
  'state_digest AS "stateDigest", browser_digest AS "browserDigest", purpose, nonce, verifier, session_digest AS "sessionDigest", invitation_digest AS "invitationDigest", created_at AS "createdAt", expires_at AS "expiresAt"';
export class PostgresOidcRepository implements OidcRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async save(transaction: OidcTransaction): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('DELETE FROM oidc_transactions WHERE expires_at <= $1', [
        transaction.createdAt,
      ]);
      await connection.query(
        'INSERT INTO oidc_transactions(state_digest,browser_digest,purpose,nonce,verifier,session_digest,invitation_digest,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          transaction.stateDigest,
          transaction.browserDigest,
          transaction.purpose,
          transaction.nonce,
          transaction.verifier,
          transaction.sessionDigest,
          transaction.invitationDigest,
          transaction.createdAt,
          transaction.expiresAt,
        ],
      );
    } finally {
      connection.release();
    }
  }
  async consume(
    stateDigest: string,
    browserDigest: string,
    now: Date,
  ): Promise<OidcTransaction | undefined> {
    const connection = await this.pool.connect();
    try {
      return (
        await connection.query<OidcTransaction & Record<string, unknown>>(
          `UPDATE oidc_transactions SET consumed_at = $3 WHERE state_digest = $1 AND browser_digest = $2 AND consumed_at IS NULL AND expires_at > $3 RETURNING ${columns}`,
          [stateDigest, browserDigest, now],
        )
      ).rows[0];
    } finally {
      connection.release();
    }
  }
  async invitationAvailable(digest: string, now: Date): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      return (
        (
          await connection.query(
            'SELECT id FROM workspace_invitations WHERE token_digest = $1 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > $2',
            [digest, now],
          )
        ).rows.length === 1
      );
    } finally {
      connection.release();
    }
  }
  private async lockUser(connection: SqlConnection, userId: string): Promise<void> {
    // All OIDC credential changes serialize by user without granting UPDATE on users.
    const key = createHash('sha256').update(userId).digest().readInt32BE(0);
    await connection.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [739104, key]);
  }
  private async authenticate(
    connection: SqlConnection,
    sessionDigest: string,
    now: Date,
    lock = false,
  ): Promise<string> {
    const session = (
      await connection.query<{ user_id: string }>(
        'SELECT user_id FROM sessions WHERE token_digest = $1 AND revoked_at IS NULL AND expires_at > $2' +
          (lock ? ' FOR UPDATE' : ''),
        [sessionDigest, now],
      )
    ).rows[0];
    if (!session) throw new OidcError('authentication_required');
    if (lock) await this.lockUser(connection, session.user_id);
    if (
      lock &&
      !(
        await connection.query(
          'SELECT user_id FROM sessions WHERE token_digest = $1 AND revoked_at IS NULL AND expires_at > $2',
          [sessionDigest, new Date(Math.max(now.getTime(), this.clock().getTime()))],
        )
      ).rows[0]
    )
      throw new OidcError('authentication_required');
    return session.user_id;
  }
  private async audit(
    connection: SqlConnection,
    id: string,
    type: string,
    userId: string,
    now: Date,
    metadata: Record<string, unknown>,
  ) {
    await connection.query(
      'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [id, type, userId, now, JSON.stringify(metadata)],
    );
  }
  async complete(completion: OidcCompletion): Promise<void> {
    const connection = await this.pool.connect();
    const { transaction, claims } = completion;
    try {
      await connection.query('BEGIN');
      let userId: string;
      if (transaction.purpose === 'link') {
        userId = await this.authenticate(
          connection,
          transaction.sessionDigest!,
          completion.now,
          true,
        );
        const existing = await connection.query(
          'SELECT user_id FROM oidc_identities WHERE (issuer = $1 AND subject = $2) OR (issuer = $1 AND user_id = $3)',
          [claims.issuer, claims.subject, userId],
        );
        if (existing.rows[0]) throw new OidcError('identity_conflict');
        await connection.query(
          'INSERT INTO oidc_identities(issuer,subject,user_id,created_at) VALUES ($1,$2,$3,$4)',
          [claims.issuer, claims.subject, userId, completion.now],
        );
        await this.audit(
          connection,
          completion.identityAuditId,
          'auth.oidc_linked',
          userId,
          completion.now,
          { issuer: claims.issuer },
        );
      } else if (transaction.purpose === 'invite') {
        if (!claims.emailVerified || !claims.email) throw new OidcError('invitation_unavailable');
        let email: string;
        try {
          email = readEmail(claims.email);
        } catch {
          throw new OidcError('invitation_unavailable');
        }
        const existing = (
          await connection.query<{ user_id: string }>(
            'SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2',
            [claims.issuer, claims.subject],
          )
        ).rows[0];
        if (existing) {
          await this.lockUser(connection, existing.user_id);
          if (
            !(
              await connection.query(
                'SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2 AND user_id = $3',
                [claims.issuer, claims.subject, existing.user_id],
              )
            ).rows[0]
          )
            throw new OidcError('identity_not_linked');
        }
        const displayName = (claims.displayName?.trim() || email).slice(0, 100);
        const identity = await acceptInvitationWithinTransaction(
          connection,
          {
            tokenDigest: transaction.invitationDigest!,
            email,
            userId: existing?.user_id ?? completion.userId,
            ...(!existing
              ? {
                  newAccount: {
                    displayName,
                    oidc: {
                      issuer: claims.issuer,
                      subject: claims.subject,
                      auditId: completion.identityAuditId,
                    },
                  },
                  session: {
                    tokenDigest: completion.sessionDigest,
                    expiresAt: completion.expiresAt,
                    auditId: completion.auditId,
                  },
                }
              : {}),
            now: completion.now,
            auditId: completion.invitationAuditId,
          },
          this.clock,
        );
        userId = identity.user.id;
        if (existing) {
          await connection.query(
            'INSERT INTO sessions(token_digest,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
            [completion.sessionDigest, userId, completion.now, completion.expiresAt],
          );
          await this.audit(
            connection,
            completion.auditId,
            'auth.signed_in',
            userId,
            completion.now,
            { method: 'oidc', issuer: claims.issuer },
          );
        }
      } else {
        const existing = (
          await connection.query<{ user_id: string }>(
            'SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2',
            [claims.issuer, claims.subject],
          )
        ).rows[0];
        if (!existing) throw new OidcError('identity_not_linked');
        userId = existing.user_id;
        await this.lockUser(connection, userId);
        if (
          !(
            await connection.query(
              'SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2 AND user_id = $3',
              [claims.issuer, claims.subject, userId],
            )
          ).rows[0]
        )
          throw new OidcError('identity_not_linked');
        await connection.query(
          'INSERT INTO sessions(token_digest,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)',
          [completion.sessionDigest, userId, completion.now, completion.expiresAt],
        );
        await this.audit(connection, completion.auditId, 'auth.signed_in', userId, completion.now, {
          method: 'oidc',
          issuer: claims.issuer,
        });
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      if (error instanceof InvitationUnavailableError)
        throw new OidcError('invitation_unavailable');
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw new OidcError('identity_conflict');
      throw error;
    } finally {
      connection.release();
    }
  }
  async settings(
    sessionDigest: string,
    issuer: string,
    now: Date,
  ): Promise<{ linked: boolean; canUnlink: boolean }> {
    const connection = await this.pool.connect();
    try {
      const userId = await this.authenticate(connection, sessionDigest, now);
      const linked =
        (
          await connection.query(
            'SELECT subject FROM oidc_identities WHERE user_id = $1 AND issuer = $2',
            [userId, issuer],
          )
        ).rows.length === 1;
      const local =
        (
          await connection.query('SELECT user_id FROM local_credentials WHERE user_id = $1', [
            userId,
          ])
        ).rows.length === 1;
      return { linked, canUnlink: linked && local };
    } finally {
      connection.release();
    }
  }
  async unlink(sessionDigest: string, issuer: string, now: Date, auditId: string): Promise<void> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const userId = await this.authenticate(connection, sessionDigest, now, true);
      if (
        !(
          await connection.query('SELECT user_id FROM local_credentials WHERE user_id = $1', [
            userId,
          ])
        ).rows[0]
      )
        throw new OidcError('last_credential');
      const deleted = await connection.query(
        'DELETE FROM oidc_identities WHERE user_id = $1 AND issuer = $2 RETURNING subject',
        [userId, issuer],
      );
      if (!deleted.rows[0]) throw new OidcError('identity_not_linked');
      await this.audit(connection, auditId, 'auth.oidc_unlinked', userId, now, { issuer });
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
