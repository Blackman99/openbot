import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { BotAccessError } from '../bots/service.js';
import { GroupAccessError } from './service.js';
import { TeamTemplateError } from './team-template.js';
import { TeamTemplateInputError, type TeamTemplateService } from './team-template-service.js';

export function registerTeamTemplateRoutes(
  app: FastifyInstance,
  auth: AuthService,
  templates: TeamTemplateService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.addHook('onRequest', async (request, reply) => {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      if (!token || !(await auth.getSession(token)))
        return reply.code(401).send({ error: { code: 'authentication_required' } });
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof GroupAccessError || error instanceof BotAccessError)
        return reply.code(403).send({ error: { code: 'team_template_forbidden' } });
      if (error instanceof TeamTemplateInputError)
        return reply.code(400).send({ error: { code: 'invalid_team_template_request' } });
      if (error instanceof TeamTemplateError)
        return reply
          .code(400)
          .send({ error: { code: 'invalid_team_template', fields: error.fields } });
      return reply.code(503).send({ error: { code: 'team_template_unavailable' } });
    });
    const identityOf = async (cookie: string | undefined) => {
      const token = readSessionToken(cookie);
      return token ? auth.getSession(token) : undefined;
    };
    routes.get<{ Params: { workspaceId: string; groupId: string } }>(
      '/api/v1/workspaces/:workspaceId/groups/:groupId/template',
      async (request, reply) => {
        const identity = await identityOf(request.headers.cookie);
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const template = await templates.export(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
        );
        return reply
          .header('content-disposition', 'attachment; filename="team-template.json"')
          .send({ template });
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/team-templates/previews',
      { bodyLimit: 131072 },
      async (request, reply) => {
        const identity = await identityOf(request.headers.cookie);
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          preview: await templates.preview(
            identity.user.id,
            request.params.workspaceId,
            request.body,
          ),
        };
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      '/api/v1/workspaces/:workspaceId/team-templates',
      { bodyLimit: 131072 },
      async (request, reply) => {
        const identity = await identityOf(request.headers.cookie);
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return reply
          .code(201)
          .send(await templates.import(identity.user.id, request.params.workspaceId, request.body));
      },
    );
  });
}
