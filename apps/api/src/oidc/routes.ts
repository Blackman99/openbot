import type { FastifyInstance, FastifyReply } from 'fastify';
import { readSessionToken, serializeSessionCookie } from '../auth/session-cookie.js';
import { OidcError, type OidcService } from './service.js';
function failure(error: unknown, reply: FastifyReply) {
  if (!(error instanceof OidcError)) throw error;
  return reply
    .code(
      error.code === 'authentication_required'
        ? 401
        : error.code === 'provider_unavailable'
          ? 503
          : error.code === 'invalid_flow'
            ? 400
            : 409,
    )
    .send({ error: { code: error.code } });
}
function browserCookie(value: string, expires: Date, secure: boolean): string {
  return `openbot_oidc=${value}; Path=/auth/oidc; Expires=${expires.toUTCString()}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
function readBrowserCookie(cookie: string | undefined): string | undefined {
  const values = (cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('openbot_oidc='));
  return values.length === 1
    ? /^openbot_oidc=([A-Za-z0-9_-]{43})$/u.exec(values[0]!)?.[1]
    : undefined;
}
function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
export function registerOidcRoutes(
  app: FastifyInstance,
  oidc: OidcService | undefined,
  webOrigin: string,
) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/oidc')) {
      reply.header('cache-control', 'private, no-store');
      reply.header('referrer-policy', 'no-referrer');
    }
    return payload;
  });
  app.get('/api/v1/oidc', async () => ({ enabled: oidc !== undefined }));
  if (!oidc) return;
  const secure = new URL(webOrigin).protocol === 'https:';
  app.post('/api/v1/oidc/start', async (request, reply) => {
    if (request.headers.origin !== webOrigin)
      return reply.code(403).send({ error: { code: 'invalid_origin' } });
    const body = bodyRecord(request.body);
    if (
      !['signin', 'link', 'invite'].includes(String(body.purpose)) ||
      (body.invitationToken !== undefined && typeof body.invitationToken !== 'string')
    )
      return reply.code(400).send({ error: { code: 'invalid_flow' } });
    try {
      const result = await oidc.start(
        body.purpose as 'signin' | 'link' | 'invite',
        readSessionToken(request.headers.cookie),
        typeof body.invitationToken === 'string' ? body.invitationToken : undefined,
      );
      reply.header('set-cookie', browserCookie(result.browserToken, result.expiresAt, secure));
      return { authorizationUrl: result.authorizationUrl };
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.post('/api/v1/oidc/callback', async (request, reply) => {
    if (request.headers.origin !== webOrigin)
      return reply.code(403).send({ error: { code: 'invalid_origin' } });
    const body = bodyRecord(request.body);
    const browserToken = readBrowserCookie(request.headers.cookie);
    reply.header('set-cookie', browserCookie('', new Date(0), secure));
    if (typeof body.callbackUrl !== 'string' || !browserToken)
      return reply.code(400).send({ error: { code: 'invalid_flow' } });
    try {
      const result = await oidc.finish(
        body.callbackUrl,
        browserToken,
        readSessionToken(request.headers.cookie),
      );
      if (result.sessionToken && result.expiresAt)
        reply.header('set-cookie', [
          browserCookie('', new Date(0), secure),
          serializeSessionCookie(result.sessionToken, result.expiresAt, secure),
        ]);
      return { destination: result.destination };
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.get('/api/v1/oidc/identity', async (request, reply) => {
    try {
      return await oidc.settings(readSessionToken(request.headers.cookie));
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.delete('/api/v1/oidc/identity', async (request, reply) => {
    if (request.headers.origin !== webOrigin)
      return reply.code(403).send({ error: { code: 'invalid_origin' } });
    try {
      await oidc.unlink(readSessionToken(request.headers.cookie));
      return reply.code(204).send();
    } catch (error) {
      return failure(error, reply);
    }
  });
}
