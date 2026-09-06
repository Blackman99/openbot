import { createHash, randomBytes, randomUUID } from 'node:crypto';
const tokens = new Map();
const scopes = [
  'me:read',
  'bots:read',
  'bots:write',
  'groups:read',
  'groups:write',
  'tasks:read',
  'tasks:write',
  'tasks:approve',
  'events:read',
];
export function resetApiTokenFixture() {
  tokens.clear();
}
export function handleApiTokenFixture(request, response, context) {
  const { user, memberships, readJson, sendJson, trustedOrigin } = context;
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/v1/me') {
    const secret = /^Bearer (ob_[A-Za-z0-9_-]{43})$/u.exec(
      request.headers.authorization ?? '',
    )?.[1];
    const record = secret
      ? [...tokens.values()].find(
          (value) => value.digest === createHash('sha256').update(secret).digest('hex'),
        )
      : undefined;
    if (!record || record.token.revokedAt || Date.parse(record.token.expiresAt) <= Date.now())
      sendJson(response, 401, { error: { code: 'invalid_api_token' } });
    else if (!record.token.scopes.includes('me:read'))
      sendJson(response, 403, { error: { code: 'insufficient_scope' } });
    else {
      record.token.lastUsedAt = new Date().toISOString();
      sendJson(response, 200, { token: { id: record.token.id, scopes: record.token.scopes } });
    }
    return true;
  }
  const match = /^\/api\/v1\/workspaces\/([^/]+)\/api-tokens(?:\/([^/]+))?$/u.exec(path);
  if (!match) return false;
  const workspaceId = decodeURIComponent(match[1]);
  if (!user) {
    sendJson(response, 401, { error: { code: 'authentication_required' } });
    return true;
  }
  if (!memberships.get(workspaceId)?.has(user.id)) {
    sendJson(response, 403, { error: { code: 'token_forbidden' } });
    return true;
  }
  if (request.method === 'GET') {
    sendJson(response, 200, {
      tokens: [...tokens.values()]
        .filter(
          (record) =>
            record.token.creatorUserId === user.id && record.token.workspaceId === workspaceId,
        )
        .map((record) => record.token),
      availableScopes: scopes,
    });
    return true;
  }
  if (request.headers.origin !== trustedOrigin) {
    sendJson(response, 403, { error: { code: 'invalid_origin' } });
    return true;
  }
  if (request.method === 'POST') {
    readJson(request, (input) => {
      if (
        !input.name?.trim() ||
        !input.scopes?.length ||
        input.scopes.some((scope) => !scopes.includes(scope))
      ) {
        sendJson(response, 400, { error: { code: 'invalid_request' } });
        return;
      }
      const secret = `ob_${randomBytes(32).toString('base64url')}`;
      const token = {
        id: randomUUID(),
        creatorUserId: user.id,
        workspaceId,
        name: input.name.trim(),
        scopes: input.scopes,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };
      tokens.set(token.id, { token, digest: createHash('sha256').update(secret).digest('hex') });
      sendJson(response, 201, { token, secret });
    });
    return true;
  }
  const record = tokens.get(match[2]);
  if (
    request.method === 'DELETE' &&
    record?.token.workspaceId === workspaceId &&
    record.token.creatorUserId === user.id
  ) {
    record.token.revokedAt ??= new Date().toISOString();
    response.writeHead(204).end();
    return true;
  }
  sendJson(response, 404, { error: { code: 'token_not_found' } });
  return true;
}
