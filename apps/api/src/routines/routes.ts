import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
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

function sessionRoutineView(routine: RoutineView) {
  return {
    id: routine.id,
    workspaceId: routine.workspaceId,
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
    ...(routine.taskId !== undefined
      ? { taskId: routine.taskId, conversationId: routine.conversationId ?? null }
      : {}),
  };
}

function sameGroup(routine: RoutineView, groupId: string) {
  return routine.groupId === groupId.toLowerCase();
}

export function registerRoutineRoutes(
  app: FastifyInstance,
  auth: AuthService,
  routines: RoutineService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
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

    const base = '/api/v1/workspaces/:workspaceId/groups/:groupId/routines';

    routes.get<{ Params: { workspaceId: string; groupId: string } }>(
      base,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        emptyQuery(request.query);
        const list = await routines.list(
          identity.user.id,
          request.params.workspaceId,
          request.params.groupId,
        );
        return { routines: list.map(sessionRoutineView) };
      },
    );

    routes.get<{ Params: { workspaceId: string; groupId: string; routineId: string } }>(
      `${base}/:routineId`,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        emptyQuery(request.query);
        const routine = await routines.get(
          identity.user.id,
          request.params.workspaceId,
          request.params.routineId,
        );
        if (!sameGroup(routine, request.params.groupId)) throw new RoutineAccessError();
        return { routine: sessionRoutineView(routine) };
      },
    );

    routes.post<{ Params: { workspaceId: string; groupId: string } }>(
      base,
      { bodyLimit: 65536 },
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        emptyQuery(request.query);
        const body =
          request.body && typeof request.body === 'object' && !Array.isArray(request.body)
            ? { ...(request.body as Record<string, unknown>), groupId: request.params.groupId }
            : request.body;
        const routine = await routines.create(identity.user.id, request.params.workspaceId, body);
        return reply.code(201).send({ routine: sessionRoutineView(routine) });
      },
    );

    routes.patch<{ Params: { workspaceId: string; groupId: string; routineId: string } }>(
      `${base}/:routineId`,
      { bodyLimit: 65536 },
      async (request, reply) => {
        if (request.headers.origin !== webOrigin)
          return reply.code(403).send({ error: { code: 'invalid_origin' } });
        const token = readSessionToken(request.headers.cookie);
        const identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        emptyQuery(request.query);
        const current = await routines.get(
          identity.user.id,
          request.params.workspaceId,
          request.params.routineId,
        );
        if (!sameGroup(current, request.params.groupId)) throw new RoutineAccessError();
        const routine = await routines.edit(
          identity.user.id,
          request.params.workspaceId,
          request.params.routineId,
          request.body,
        );
        return { routine: sessionRoutineView(routine) };
      },
    );

    for (const action of ['pause', 'resume', 'cancel'] as const) {
      routes.post<{ Params: { workspaceId: string; groupId: string; routineId: string } }>(
        `${base}/:routineId/${action}`,
        { bodyLimit: 1024 },
        async (request, reply) => {
          if (request.headers.origin !== webOrigin)
            return reply.code(403).send({ error: { code: 'invalid_origin' } });
          const token = readSessionToken(request.headers.cookie);
          const identity = token ? await auth.getSession(token) : undefined;
          if (!identity)
            return reply.code(401).send({ error: { code: 'authentication_required' } });
          emptyQuery(request.query);
          if (request.body !== undefined) throw new RoutineInputError();
          const current = await routines.get(
            identity.user.id,
            request.params.workspaceId,
            request.params.routineId,
          );
          if (!sameGroup(current, request.params.groupId)) throw new RoutineAccessError();
          const routine = await routines[action](
            identity.user.id,
            request.params.workspaceId,
            request.params.routineId,
          );
          return { routine: sessionRoutineView(routine) };
        },
      );
    }
  });
}
