import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import type { MemoryService } from './service.js';
import {
  MemoryAccessError,
  MemoryConflictError,
  MemoryInputError,
  type MemoryAccess,
} from './types.js';
type Params = { workspaceId: string; groupId: string; grantId?: string; memoryId?: string };
export function registerMemoryRoutes(
  app: FastifyInstance,
  auth: AuthService,
  memories: MemoryService,
  webOrigin: string,
) {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof MemoryAccessError)
        return reply.code(403).send({ error: { code: 'memory_forbidden' } });
      if (error instanceof MemoryInputError)
        return reply.code(400).send({ error: { code: 'invalid_memory_request' } });
      if (error instanceof MemoryConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_memory_request' } });
      return reply.code(503).send({ error: { code: 'memory_unavailable' } });
    });
    async function access(
      request: FastifyRequest<{ Params: Params }>,
      operation: 'create' | 'read' | 'list' | 'search',
    ): Promise<MemoryAccess | undefined> {
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return undefined;
      const value = {
        actorUserId: identity.user.id,
        workspaceId: request.params.workspaceId,
        groupId: request.params.groupId,
        ...(request.params.grantId ? { grantId: request.params.grantId } : {}),
      };
      if (request.method === 'POST' && request.headers.origin !== webOrigin)
        await memories.deny(value, operation);
      return value;
    }
    const base = '/api/v1/workspaces/:workspaceId/groups/:groupId';
    routes.post<{ Params: Params }>(
      `${base}/memories`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'create');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const result = await memories.create(admitted, request.body);
        return reply.code(result.replayed ? 200 : 201).send({ memory: result.memory });
      },
    );
    for (const path of [`${base}/memories`, `${base}/bots/:grantId/memories`]) {
      routes.get<{ Params: Params }>(path, async (request, reply) => {
        const admitted = await access(request, 'list');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return memories.list(admitted, request.query);
      });
      routes.post<{ Params: Params }>(
        `${path}/search`,
        { bodyLimit: 4096 },
        async (request, reply) => {
          const admitted = await access(request, 'search');
          if (!admitted)
            return reply.code(401).send({ error: { code: 'authentication_required' } });
          return memories.list(admitted, request.body, true);
        },
      );
      routes.get<{ Params: Params & { memoryId: string } }>(
        `${path}/:memoryId`,
        async (request, reply) => {
          const admitted = await access(request, 'read');
          if (!admitted)
            return reply.code(401).send({ error: { code: 'authentication_required' } });
          return { memory: await memories.get(admitted, request.params.memoryId) };
        },
      );
    }
  });
}
