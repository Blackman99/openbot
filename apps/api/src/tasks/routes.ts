import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import { InvalidConversationInputError } from '../conversations/service.js';
import { ProviderError } from '../providers/url-policy.js';
import { BotModelError } from '../bots/service.js';
import { RoutingSelectionError } from '../routing/matcher.js';
import { TaskService, TaskAccessError, TaskInputError, TaskConflictError } from './service.js';

export function registerTaskRoutes(
  app: FastifyInstance,
  auth: AuthService,
  tasks: TaskService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof TaskAccessError)
        return reply.code(403).send({ error: { code: 'task_forbidden' } });
      if (error instanceof TaskConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof TaskInputError || error instanceof InvalidConversationInputError)
        return reply.code(400).send({ error: { code: 'invalid_task_request' } });
      if (error instanceof ProviderError || error instanceof BotModelError)
        return reply.code(409).send({ error: { code: 'task_model_unavailable' } });
      if (error instanceof RoutingSelectionError)
        return reply.code(409).send({ error: { code: error.code } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_task_request' } });
      return reply.code(503).send({ error: { code: 'task_unavailable' } });
    });
    routes.post<{ Params: { workspaceId: string; conversationId: string } }>(
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks',
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const task = await tasks.submit(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
          request.body,
        );
        return reply.code(202).send({ task });
      },
    );
    const base = '/api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks';
    routes.get<{
      Params: { workspaceId: string; conversationId: string; taskId: string; runId: string };
    }>(`${base}/:taskId/runs/:runId/partial-output`, async (request, reply) => {
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      if (Object.keys(request.query as object).length) throw new TaskInputError();
      return tasks.partialOutput(
        identity.user.id,
        request.params.workspaceId,
        request.params.conversationId,
        request.params.taskId,
        request.params.runId,
      );
    });
    routes.post<{ Params: { workspaceId: string; conversationId: string; taskId: string } }>(
      `${base}/:taskId/cancellations`,
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return tasks.cancel(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
          request.params.taskId,
          request.body,
        );
      },
    );
    routes.post<{ Params: { workspaceId: string; conversationId: string; taskId: string } }>(
      `${base}/:taskId/pauses`,
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return tasks.pause(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
          request.params.taskId,
          request.body,
        );
      },
    );
    routes.post<{ Params: { workspaceId: string; conversationId: string; taskId: string } }>(
      `${base}/:taskId/retries`,
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return reply
          .code(202)
          .send(
            await tasks.retry(
              identity.user.id,
              request.params.workspaceId,
              request.params.conversationId,
              request.params.taskId,
              request.body,
            ),
          );
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string; taskId: string } }>(
      `${base}/:taskId/routing`,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        if (Object.keys(request.query as object).length) throw new TaskInputError();
        return {
          routing: await tasks.routing(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
            request.params.taskId,
          ),
        };
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string } }>(
      base,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return tasks.list(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
          request.query,
        );
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string; taskId: string } }>(
      `${base}/:taskId/runs`,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return tasks.runs(
          identity.user.id,
          request.params.workspaceId,
          request.params.conversationId,
          request.params.taskId,
          request.query,
        );
      },
    );
    routes.get<{ Params: { workspaceId: string; conversationId: string; taskId: string } }>(
      `${base}/:taskId`,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          task: await tasks.get(
            identity.user.id,
            request.params.workspaceId,
            request.params.conversationId,
            request.params.taskId,
          ),
        };
      },
    );
  });
}
