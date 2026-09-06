import type { FastifyInstance } from 'fastify';
import { readApiRequestToken } from '../api-tokens/routes.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  type ApiTokenService,
} from '../api-tokens/service.js';
import {
  RoutineAccessError,
  RoutineConflictError,
  RoutineInputError,
  type RoutineService,
  type RoutineView,
} from './service.js';

function emptyQuery(query: unknown) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length)
    throw new RoutineInputError();
}

function publicRoutineView(routine: RoutineView) {
  return {
    id: routine.id,
    groupId: routine.groupId,
    ownerUserId: routine.ownerUserId,
    prompt: routine.prompt,
    routingPolicy: routine.routingPolicy,
    leadGrantId: routine.leadGrantId,
    timeZone: routine.timeZone,
    executeAt: routine.executeAt,
    expiresAt: routine.expiresAt,
    maxCostMicros: routine.maxCostMicros,
    kind: routine.kind,
    status: routine.status,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  };
}

export function registerPublicRoutineRoutes(
  app: FastifyInstance,
  tokens: ApiTokenService,
  routines: RoutineService,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiTokenAuthenticationError)
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer')
          .send({ error: { code: 'invalid_api_token' } });
      if (error instanceof ApiTokenScopeError)
        return reply.code(403).send({ error: { code: 'insufficient_scope' } });
      if (error instanceof RoutineAccessError)
        return reply.code(403).send({ error: { code: 'routine_forbidden' } });
      if (error instanceof RoutineConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof RoutineInputError)
        return reply.code(400).send({ error: { code: 'invalid_routine_request' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        [400, 413, 415].includes(error.statusCode)
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_routine_request' } });
      return reply.code(503).send({ error: { code: 'routine_unavailable' } });
    });
    routes.post('/v1/routines', { bodyLimit: 65536 }, async (request, reply) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'groups:write',
      );
      emptyQuery(request.query);
      const routine = await routines.create(
        identity.user.id,
        identity.workspace.id,
        request.body,
        admit,
      );
      return reply.code(201).send({ routine: publicRoutineView(routine) });
    });
    routes.patch<{ Params: { routineId: string } }>(
      '/v1/routines/:routineId',
      { bodyLimit: 65536 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        const routine = await routines.edit(
          identity.user.id,
          identity.workspace.id,
          request.params.routineId,
          request.body,
          admit,
        );
        return { routine: publicRoutineView(routine) };
      },
    );
    routes.post<{ Params: { routineId: string } }>(
      '/v1/routines/:routineId/pause',
      { bodyLimit: 1024 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        if (request.body !== undefined) throw new RoutineInputError();
        const routine = await routines.pause(
          identity.user.id,
          identity.workspace.id,
          request.params.routineId,
          admit,
        );
        return { routine: publicRoutineView(routine) };
      },
    );
    routes.post<{ Params: { routineId: string } }>(
      '/v1/routines/:routineId/resume',
      { bodyLimit: 1024 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        if (request.body !== undefined) throw new RoutineInputError();
        const routine = await routines.resume(
          identity.user.id,
          identity.workspace.id,
          request.params.routineId,
          admit,
        );
        return { routine: publicRoutineView(routine) };
      },
    );
    routes.post<{ Params: { routineId: string } }>(
      '/v1/routines/:routineId/cancel',
      { bodyLimit: 1024 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        if (request.body !== undefined) throw new RoutineInputError();
        const routine = await routines.cancel(
          identity.user.id,
          identity.workspace.id,
          request.params.routineId,
          admit,
        );
        return { routine: publicRoutineView(routine) };
      },
    );
  });
}
