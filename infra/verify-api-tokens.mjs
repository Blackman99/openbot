import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool();
const baseUrl = 'http://127.0.0.1:3001';
const origin = process.env.WEB_ORIGIN;
let stage = 'sign-in';
async function request(path, { cookie, secret, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const value = response.status === 204 ? undefined : await response.json();
  return { response, value };
}
try {
  const signIn = await request('/api/v1/session', {
    method: 'POST',
    body: { email: 'owner@example.com', password: 'ci-only-owner-password' },
  });
  assert.equal(signIn.response.status, 200);
  const cookie = signIn.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const workspaceId = signIn.value.workspace.id;
  const path = `/api/v1/workspaces/${workspaceId}/api-tokens`;
  const input = {
    name: 'CI token',
    scopes: ['me:read'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  stage = 'creation and restricted storage';
  const created = await request(path, { cookie, method: 'POST', body: input });
  assert.equal(created.response.status, 201);
  const { token, secret } = created.value;
  const row = (await pool.query('SELECT * FROM api_tokens WHERE id = $1', [token.id])).rows[0];
  assert.equal(row.token_digest, createHash('sha256').update(secret).digest('hex'));
  assert.equal(JSON.stringify(row).includes(secret), false);
  await assert.rejects(
    pool.query('UPDATE api_tokens SET scopes = $2 WHERE id = $1', [token.id, ['bots:write']]),
    /permission denied/u,
  );
  await assert.rejects(
    pool.query('UPDATE api_tokens SET expires_at = NOW() WHERE id = $1', [token.id]),
    /permission denied/u,
  );
  await assert.rejects(
    pool.query('DELETE FROM api_tokens WHERE id = $1', [token.id]),
    /permission denied/u,
  );
  stage = 'public identity and redacted listing';
  const identity = await request('/v1/me', { secret });
  assert.equal(identity.response.status, 200);
  assert.equal(identity.value.user.id, signIn.value.user.id);
  assert.equal(identity.value.workspace.id, workspaceId);
  assert.equal((await request('/api/v1/me', { secret })).response.status, 401);
  assert.equal((await request(`/v1/me?access_token=${secret}`)).response.status, 401);
  const listed = await request(path, { cookie });
  assert.equal(listed.response.status, 200);
  assert.equal(JSON.stringify(listed.value).includes(secret), false);
  assert.equal(JSON.stringify(listed.value).includes('digest'), false);
  assert.ok(listed.value.tokens.find((value) => value.id === token.id).lastUsedAt);
  stage = 'scope rejection and revocation';
  const narrow = await request(path, {
    cookie,
    method: 'POST',
    body: { ...input, scopes: ['bots:read'] },
  });
  assert.equal(narrow.response.status, 201);
  assert.equal((await request('/v1/me', { secret: narrow.value.secret })).response.status, 403);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal(
      (await request(`${path}/${token.id}`, { cookie, method: 'DELETE' })).response.status,
      204,
    );
  assert.equal((await request('/v1/me', { secret })).response.status, 401);
  stage = 'member removal revokes tokens';
  const email = `api-ci-${randomUUID()}@example.com`;
  const invitation = await request(`/api/v1/workspaces/${workspaceId}/invitations`, {
    cookie,
    method: 'POST',
    body: { email, role: 'member', expiresInDays: 1 },
  });
  assert.equal(invitation.response.status, 201);
  const accepted = await request('/api/v1/invitations/accept', {
    method: 'POST',
    body: {
      token: invitation.value.token,
      email,
      displayName: 'API CI Member',
      password: 'ci-only-api-member-password',
    },
  });
  assert.equal(accepted.response.status, 201);
  const memberCookie = accepted.response.headers.get('set-cookie')?.split(';')[0];
  const memberToken = await request(path, { cookie: memberCookie, method: 'POST', body: input });
  assert.equal(memberToken.response.status, 201);
  assert.equal(
    (await request('/v1/me', { secret: memberToken.value.secret })).response.status,
    200,
  );
  assert.equal(
    (
      await request(`/api/v1/workspaces/${workspaceId}/members/${accepted.value.user.id}`, {
        cookie,
        method: 'DELETE',
      })
    ).response.status,
    204,
  );
  assert.equal(
    (await request('/v1/me', { secret: memberToken.value.secret })).response.status,
    401,
  );
  assert.equal((await request('/api/v1/me', { cookie: memberCookie })).response.status, 200);
  assert.ok(
    (
      await pool.query('SELECT revoked_at FROM api_tokens WHERE id = $1', [
        memberToken.value.token.id,
      ])
    ).rows[0].revoked_at,
  );
  process.stdout.write('Scoped API token runtime checks passed\n');
} catch {
  process.stderr.write(`Scoped API token runtime checks failed during ${stage}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
