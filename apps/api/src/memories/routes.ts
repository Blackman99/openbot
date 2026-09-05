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
type Params = {
  workspaceId: string;
  groupId?: string;
  grantId?: string;
  memoryId?: string;
  botId?: string;
  conversationId?: string;
  candidateId?: string;
};
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
      operation:
        | 'create'
        | 'read'
        | 'list'
        | 'search'
        | 'preview'
        | 'promote'
        | 'edit-memory'
        | 'forget-memory'
        | 'retain-memory'
        | 'revoke-memory',
    ): Promise<MemoryAccess | undefined> {
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return undefined;
      const value = {
        actorUserId: identity.user.id,
        workspaceId: request.params.workspaceId,
        groupId: request.params.groupId ?? request.params.botId ?? '',
        ...(request.params.grantId ? { grantId: request.params.grantId } : {}),
      };
      if (request.method === 'POST' && request.headers.origin !== webOrigin)
        await memories.deny(value, operation);
      return value;
    }
    const base = '/api/v1/workspaces/:workspaceId/groups/:groupId';
    routes.get<{ Params: Params }>(`${base}/pending-memory-revocations`, async (request, reply) => {
      const admitted = await access(request, 'list');
      if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return memories.listPending(admitted);
    });
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
    routes.post<{ Params: Params & { memoryId: string } }>(
      `${base}/memories/:memoryId/edits`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'edit-memory');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return { memory: await memories.edit(admitted, request.params.memoryId, request.body) };
      },
    );
    routes.post<{ Params: Params & { memoryId: string } }>(
      `${base}/memories/:memoryId/tombstones`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'forget-memory');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return memories.forget(admitted, request.params.memoryId, request.body);
      },
    );
    routes.post<{ Params: Params & { memoryId: string } }>(
      `${base}/memories/:memoryId/retentions`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'retain-memory');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return { memory: await memories.retain(admitted, request.params.memoryId, request.body) };
      },
    );
    routes.post<{ Params: Params & { memoryId: string } }>(
      `${base}/memories/:memoryId/revocations`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'revoke-memory');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return memories.revoke(admitted, request.params.memoryId, request.body);
      },
    );
    routes.post<{ Params: Params & { memoryId: string } }>(
      `${base}/memories/:memoryId/promotion-previews`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'preview');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return memories.preview(admitted, request.params.memoryId, request.body);
      },
    );
    routes.post<{ Params: Params & { memoryId: string } }>(
      `${base}/memories/:memoryId/promotions`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await access(request, 'promote');
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const result = await memories.confirm(admitted, request.params.memoryId, request.body);
        return reply.code(result.replayed ? 200 : 201).send({ memory: result.memory });
      },
    );
    const candidateBase =
      '/api/v1/workspaces/:workspaceId/conversations/:conversationId/memory-candidates';
    async function candidateActor(request: FastifyRequest<{ Params: Params }>) {
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return undefined;
      if (request.method !== 'GET' && request.headers.origin !== webOrigin)
        await memories.deny(
          {
            actorUserId: identity.user.id,
            workspaceId: request.params.workspaceId,
            groupId: request.params.conversationId ?? '',
          },
          'list-candidates',
        );
      return {
        actorUserId: identity.user.id,
        workspaceId: request.params.workspaceId,
        conversationId: request.params.conversationId!,
      };
    }
    routes.get<{ Params: Params }>(candidateBase, async (request, reply) => {
      const admitted = await candidateActor(request);
      if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
      return memories.listCandidates(admitted, request.query);
    });
    routes.patch<{ Params: Params & { candidateId: string } }>(
      `${candidateBase}/:candidateId`,
      { bodyLimit: 16384 },
      async (request, reply) => {
        const admitted = await candidateActor(request);
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          candidate: await memories.editCandidate(
            admitted,
            request.params.candidateId,
            request.body,
          ),
        };
      },
    );
    routes.post<{ Params: Params & { candidateId: string } }>(
      `${candidateBase}/:candidateId/rejections`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await candidateActor(request);
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const result = await memories.rejectCandidate(
          admitted,
          request.params.candidateId,
          request.body,
        );
        return reply.code(result.replayed ? 200 : 201).send({ candidate: result.candidate });
      },
    );
    routes.post<{ Params: Params & { candidateId: string } }>(
      `${candidateBase}/:candidateId/approvals`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await candidateActor(request);
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const result = await memories.approveCandidate(
          admitted,
          request.params.candidateId,
          request.body,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );
    routes.post<{ Params: Params & { candidateId: string } }>(
      `${candidateBase}/:candidateId/approval-previews`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await candidateActor(request);
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return memories.previewCandidate(admitted, request.params.candidateId, request.body);
      },
    );
    routes.post<{ Params: Params & { candidateId: string } }>(
      `${candidateBase}/:candidateId/approval-confirmations`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const admitted = await candidateActor(request);
        if (!admitted) return reply.code(401).send({ error: { code: 'authentication_required' } });
        const result = await memories.confirmCandidate(
          admitted,
          request.params.candidateId,
          request.body,
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );
    const privateBase = '/api/v1/workspaces/:workspaceId/bots/:botId/private-memories';
    routes.get<{ Params: Params }>(privateBase, async (request, reply) => {
      const token = readSessionToken(request.headers.cookie),
        identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      if (request.headers.origin !== webOrigin)
        await memories.deny(
          {
            actorUserId: identity.user.id,
            workspaceId: request.params.workspaceId,
            groupId: request.params.botId ?? '',
          },
          'list-private',
        );
      return memories.listPrivate(
        {
          actorUserId: identity.user.id,
          workspaceId: request.params.workspaceId,
          botId: request.params.botId!,
        },
        request.query,
      );
    });
    routes.post<{ Params: Params }>(
      `${privateBase}/search`,
      { bodyLimit: 4096 },
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        if (request.headers.origin !== webOrigin)
          await memories.deny(
            {
              actorUserId: identity.user.id,
              workspaceId: request.params.workspaceId,
              groupId: request.params.botId ?? '',
            },
            'search-private',
          );
        return memories.listPrivate(
          {
            actorUserId: identity.user.id,
            workspaceId: request.params.workspaceId,
            botId: request.params.botId!,
          },
          request.body,
          true,
        );
      },
    );
    routes.get<{ Params: Params & { memoryId: string } }>(
      `${privateBase}/:memoryId`,
      async (request, reply) => {
        const token = readSessionToken(request.headers.cookie),
          identity = token ? await auth.getSession(token) : undefined;
        if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
        return {
          memory: await memories.getPrivate(
            {
              actorUserId: identity.user.id,
              workspaceId: request.params.workspaceId,
              botId: request.params.botId!,
            },
            request.params.memoryId,
          ),
        };
      },
    );
  });
}
