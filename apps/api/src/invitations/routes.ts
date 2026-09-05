import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationAttemptLimiter } from '../auth/attempt-limiter.js';
import { readSessionToken, serializeSessionCookie } from '../auth/session-cookie.js';
import {
  AuthenticationBusyError,
  InvalidAuthInputError,
  type AuthService,
} from '../auth/service.js';
import {
  InvitationAccessError,
  InvitationInputError,
  InvitationWorkspaceError,
  InvitationUnavailableError,
  type InvitationService,
} from './service.js';

export function registerInvitationRoutes(
  app: FastifyInstance,
  auth: AuthService,
  invitations: InvitationService,
  webOrigin: string,
): void {
  const attempts = new AuthenticationAttemptLimiter();
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthenticationBusyError)
        return reply
          .header('retry-after', '1')
          .code(429)
          .send({ error: { code: 'authentication_busy' } });
      if (error instanceof InvitationInputError || error instanceof InvalidAuthInputError)
        return reply.code(400).send({ error: { code: 'invalid_invitation' } });
      if (error instanceof InvitationAccessError)
        return reply.code(403).send({ error: { code: 'invitation_forbidden' } });
      if (error instanceof InvitationWorkspaceError)
        return reply.code(404).send({ error: { code: 'workspace_not_found' } });
      if (error instanceof InvitationUnavailableError)
        return reply.code(409).send({ error: { code: 'invitation_unavailable' } });
      return reply.send(error);
    });
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.headers.origin !== webOrigin
      ) {
        reply.code(403).send({ error: { code: 'invalid_origin' } });
        return;
      }
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) reply.code(401).send({ error: { code: 'authentication_required' } });
      return identity;
    }
    routes.post('/api/v1/invitations/accept', async (request, reply) => {
      if (request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (/(?:^|;\s*)openbot_session=/u.test(request.headers.cookie ?? '') && !identity)
        return reply.code(401).send({ error: { code: 'authentication_required' } });
      const email =
        typeof request.body === 'object' &&
        request.body !== null &&
        'email' in request.body &&
        typeof request.body.email === 'string'
          ? request.body.email
          : (identity?.user.email ?? request.ip);
      const attempt = { clientIp: request.ip, email };
      const retryAfter = attempts.retryAfterSeconds(attempt);
      if (retryAfter !== undefined)
        return reply
          .header('retry-after', String(retryAfter))
          .code(429)
          .send({ error: { code: 'invitation_rate_limited' } });
      let accepted;
      try {
        accepted = await invitations.accept(request.body, identity);
      } catch (error) {
        if (
          error instanceof InvitationUnavailableError ||
          error instanceof InvitationInputError ||
          error instanceof InvalidAuthInputError
        )
          attempts.recordFailure(attempt);
        throw error;
      }
      if (accepted.session)
        reply.header(
          'set-cookie',
          serializeSessionCookie(
            accepted.session.sessionToken,
            accepted.session.expiresAt,
            new URL(webOrigin).protocol === 'https:',
          ),
        );
      return reply.code(accepted.session ? 201 : 200).send(accepted.identity);
    });
    routes.delete<{ Params: { workspaceId: string; invitationId: string } }>(
      '/api/v1/workspaces/:workspaceId/invitations/:invitationId',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        await invitations.revoke(
          identity.user.id,
          request.params.workspaceId,
          request.params.invitationId,
        );
        return reply.code(204).send();
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/invitations',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        return reply
          .code(201)
          .send(
            await invitations.create(identity.user.id, request.params.workspaceId, request.body),
          );
      },
    );
    routes.get<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/invitations',
      async (request, reply) => {
        const identity = await authenticate(request, reply);
        if (!identity) return reply;
        return {
          invitations: await invitations.list(identity.user.id, request.params.workspaceId),
        };
      },
    );
  });
}
