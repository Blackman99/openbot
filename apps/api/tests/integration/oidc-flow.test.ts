import { oidcFixture } from '../helpers/oidc-fixture.js';
import { afterEach, describe, expect, it } from 'vitest';
import { InvitationService } from '../../src/invitations/service.js';
import { PostgresInvitationRepository } from '../../src/invitations/postgres-invitation-repository.js';
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
describe('OIDC identity lifecycle', () => {
  it('explicitly links an authenticated user, then signs into that issuer/subject and consumes the browser transaction once', async () => {
    const { auth, owner, idp, oidc, pool } = await oidcFixture(close);
    const link = await oidc.start('link', owner.sessionToken);
    const callback = idp.issue(link.authorizationUrl);
    expect(await oidc.finish(callback, link.browserToken, owner.sessionToken)).toEqual({
      destination: '/app/security',
    });
    expect((await pool.query('SELECT issuer, subject, user_id FROM oidc_identities')).rows).toEqual(
      [{ issuer: idp.issuer, subject: 'ada-subject', user_id: owner.user.id }],
    );
    await expect(
      oidc.finish(callback, link.browserToken, owner.sessionToken),
    ).rejects.toMatchObject({ code: 'invalid_flow' });
    const signin = await oidc.start('signin');
    const result = await oidc.finish(idp.issue(signin.authorizationUrl), signin.browserToken);
    expect(result.destination).toBe('/app');
    expect(await auth.getSession(result.sessionToken!)).toEqual({
      user: owner.user,
      workspace: owner.workspace,
    });
  });
});

it('registers only an invited verified email and creates an OIDC-only account atomically with membership and session', async () => {
  const { auth, owner, idp, oidc, pool } = await oidcFixture(close);
  const invitations = new InvitationService(new PostgresInvitationRepository(pool));
  const invite = await invitations.create(owner.user.id, owner.workspace.id, {
    email: 'grace@example.com',
    role: 'member',
    expiresInDays: 1,
  });
  const flow = await oidc.start('invite', undefined, invite.token);
  const result = await oidc.finish(
    idp.issue(flow.authorizationUrl, {
      sub: 'grace-subject',
      email: 'grace@example.com',
      name: 'Grace',
    }),
    flow.browserToken,
  );
  const identity = await auth.getSession(result.sessionToken!);
  expect(identity).toMatchObject({
    user: { displayName: 'Grace', email: 'grace@example.com' },
    workspace: owner.workspace,
  });
  expect((await pool.query('SELECT user_id FROM local_credentials')).rows).toEqual([
    { user_id: owner.user.id },
  ]);
  expect(
    (
      await pool.query('SELECT invitation_id, role FROM workspace_memberships WHERE user_id = $1', [
        identity!.user.id,
      ])
    ).rows,
  ).toEqual([{ invitation_id: invite.invitation.id, role: 'member' }]);
  expect((await pool.query('SELECT consumed_by_user_id FROM workspace_invitations')).rows).toEqual([
    { consumed_by_user_id: identity!.user.id },
  ]);
  expect(
    (await pool.query('SELECT user_id FROM oidc_identities WHERE subject = $1', ['grace-subject']))
      .rows,
  ).toEqual([{ user_id: identity!.user.id }]);
  expect(await oidc.settings(result.sessionToken!)).toEqual({ linked: true, canUnlink: false });
  await expect(oidc.unlink(result.sessionToken!)).rejects.toMatchObject({
    code: 'last_credential',
  });
});
it('never merges email matches and requires an invitation for new identities', async () => {
  const { idp, oidc, pool } = await oidcFixture(close);
  const signin = await oidc.start('signin');
  await expect(
    oidc.finish(idp.issue(signin.authorizationUrl), signin.browserToken),
  ).rejects.toMatchObject({ code: 'identity_not_linked' });
  expect((await pool.query('SELECT id FROM users')).rows).toHaveLength(1);
  expect((await pool.query('SELECT * FROM oidc_identities')).rows).toHaveLength(0);
  await expect(oidc.start('invite', undefined, 'x'.repeat(43))).rejects.toMatchObject({
    code: 'invitation_unavailable',
  });
});
it('rejects cross-browser state, expired or revoked linking sessions, and requires authenticated unlink', async () => {
  const { auth, owner, idp, oidc, pool } = await oidcFixture(close);
  await expect(oidc.start('link')).rejects.toMatchObject({ code: 'authentication_required' });
  const link = await oidc.start('link', owner.sessionToken);
  const callback = idp.issue(link.authorizationUrl);
  await expect(oidc.finish(callback, 'x'.repeat(43), owner.sessionToken)).rejects.toMatchObject({
    code: 'invalid_flow',
  });
  expect(idp.redemptionCount).toBe(0);
  await auth.signOut(owner.sessionToken);
  await expect(oidc.finish(callback, link.browserToken, owner.sessionToken)).rejects.toMatchObject({
    code: 'authentication_required',
  });
  expect(idp.redemptionCount).toBe(0);
  await expect(oidc.unlink()).rejects.toMatchObject({ code: 'authentication_required' });
  expect((await pool.query('SELECT * FROM oidc_identities')).rows).toEqual([]);
});
it('unlinks from authenticated security settings while keeping local access and rejecting future OIDC sign-in', async () => {
  const { auth, owner, idp, oidc } = await oidcFixture(close);
  const link = await oidc.start('link', owner.sessionToken);
  await oidc.finish(idp.issue(link.authorizationUrl), link.browserToken, owner.sessionToken);
  expect(await oidc.settings(owner.sessionToken)).toEqual({ linked: true, canUnlink: true });
  await oidc.unlink(owner.sessionToken);
  expect(await oidc.settings(owner.sessionToken)).toEqual({ linked: false, canUnlink: false });
  expect(await auth.getSession(owner.sessionToken)).toBeDefined();
  const signin = await oidc.start('signin');
  await expect(
    oidc.finish(idp.issue(signin.authorizationUrl), signin.browserToken),
  ).rejects.toMatchObject({ code: 'identity_not_linked' });
});
it.each([{ email: 'wrong@example.com' }, { email_verified: false }, { email: 'ada@example.com' }])(
  'rejects invitation email mismatch, unverified email and local email conflicts without merging: %j',
  async (claims) => {
    const { owner, idp, oidc, pool } = await oidcFixture(close);
    const invitations = new InvitationService(new PostgresInvitationRepository(pool));
    const email = claims.email === 'ada@example.com' ? 'ada@example.com' : 'grace@example.com';
    const invite = await invitations.create(owner.user.id, owner.workspace.id, {
      email,
      role: 'member',
      expiresInDays: 1,
    });
    const flow = await oidc.start('invite', undefined, invite.token);
    await expect(
      oidc.finish(
        idp.issue(flow.authorizationUrl, {
          sub: 'new-subject',
          email: 'grace@example.com',
          ...claims,
        }),
        flow.browserToken,
      ),
    ).rejects.toMatchObject({ code: 'invitation_unavailable' });
    expect((await pool.query('SELECT id FROM users')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM oidc_identities')).rows).toHaveLength(0);
    expect((await pool.query('SELECT consumed_at FROM workspace_invitations')).rows).toEqual([
      { consumed_at: null },
    ]);
  },
);
it('expires transactions and keeps issuer/subject authentication independent of current membership and email claims', async () => {
  const { auth, owner, idp, oidc, pool } = await oidcFixture(close);
  const expired = await oidc.start('link', owner.sessionToken);
  await pool.query('UPDATE oidc_transactions SET created_at = $1, expires_at = $2', [
    new Date('2020-01-01'),
    new Date('2020-01-02'),
  ]);
  await expect(
    oidc.finish(idp.issue(expired.authorizationUrl), expired.browserToken, owner.sessionToken),
  ).rejects.toMatchObject({ code: 'invalid_flow' });
  const link = await oidc.start('link', owner.sessionToken);
  await oidc.finish(idp.issue(link.authorizationUrl), link.browserToken, owner.sessionToken);
  await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [owner.user.id]);
  const signin = await oidc.start('signin');
  const result = await oidc.finish(
    idp.issue(signin.authorizationUrl, { email: 'changed@example.com' }),
    signin.browserToken,
  );
  expect(await auth.getSession(result.sessionToken!)).toEqual({
    user: owner.user,
    workspace: null,
  });
  expect(await oidc.settings(result.sessionToken!)).toEqual({ linked: true, canUnlink: true });
  const differentSubject = await oidc.start('signin');
  await expect(
    oidc.finish(
      idp.issue(differentSubject.authorizationUrl, { sub: 'different-subject' }),
      differentSubject.browserToken,
    ),
  ).rejects.toMatchObject({ code: 'identity_not_linked' });
});
it('rejects repeated or concurrently submitted callbacks before issuing duplicate sessions', async () => {
  const { owner, idp, oidc, pool } = await oidcFixture(close);
  const link = await oidc.start('link', owner.sessionToken);
  await oidc.finish(idp.issue(link.authorizationUrl), link.browserToken, owner.sessionToken);
  const signin = await oidc.start('signin');
  const callback = idp.issue(signin.authorizationUrl);
  const outcomes = await Promise.allSettled([
    oidc.finish(callback, signin.browserToken),
    oidc.finish(callback, signin.browserToken),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await pool.query('SELECT * FROM sessions')).rows).toHaveLength(2);
});
it('does not treat the same subject under a different issuer as the linked identity', async () => {
  const { owner, idp, oidc, pool } = await oidcFixture(close);
  const link = await oidc.start('link', owner.sessionToken);
  await oidc.finish(idp.issue(link.authorizationUrl), link.browserToken, owner.sessionToken);
  await pool.query("UPDATE oidc_identities SET issuer='https://other.example'");
  const signin = await oidc.start('signin');
  await expect(
    oidc.finish(idp.issue(signin.authorizationUrl), signin.browserToken),
  ).rejects.toMatchObject({ code: 'identity_not_linked' });
});
it('refuses linking an identity already owned by another user and rechecks invitation revocation after start', async () => {
  const { owner, idp, oidc, pool } = await oidcFixture(close);
  const invitations = new InvitationService(new PostgresInvitationRepository(pool));
  const invite = await invitations.create(owner.user.id, owner.workspace.id, {
    email: 'grace@example.com',
    role: 'member',
    expiresInDays: 1,
  });
  const flow = await oidc.start('invite', undefined, invite.token);
  await oidc.finish(
    idp.issue(flow.authorizationUrl, { sub: 'grace', email: 'grace@example.com' }),
    flow.browserToken,
  );
  const link = await oidc.start('link', owner.sessionToken);
  await expect(
    oidc.finish(
      idp.issue(link.authorizationUrl, { sub: 'grace', email: 'grace@example.com' }),
      link.browserToken,
      owner.sessionToken,
    ),
  ).rejects.toMatchObject({ code: 'identity_conflict' });
  const revoked = await invitations.create(owner.user.id, owner.workspace.id, {
    email: 'revoked@example.com',
    role: 'member',
    expiresInDays: 1,
  });
  const pending = await oidc.start('invite', undefined, revoked.token);
  await invitations.revoke(owner.user.id, owner.workspace.id, revoked.invitation.id);
  await expect(
    oidc.finish(
      idp.issue(pending.authorizationUrl, { sub: 'revoked', email: 'revoked@example.com' }),
      pending.browserToken,
    ),
  ).rejects.toMatchObject({ code: 'invitation_unavailable' });
  expect((await pool.query('SELECT id FROM users')).rows).toHaveLength(2);
  expect((await pool.query('SELECT user_id FROM oidc_identities')).rows).toHaveLength(1);
});
