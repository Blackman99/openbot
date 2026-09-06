import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/service.js';
import { readSessionToken } from '../auth/session-cookie.js';
import type { ProviderConnections } from './connections.js';
import { publicProbe } from './scope.js';
import { ProviderError } from './url-policy.js';

export function registerProviderRoutes(
  app: FastifyInstance,
  auth: AuthService,
  providers: ProviderConnections | undefined,
  webOrigin: string,
): void {
  void app.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'private, no-store');
      return payload;
    });
    routes.setErrorHandler((error, _request, reply) => {
      const invalid =
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500;
      return reply
        .code(invalid ? 400 : 503)
        .send({ error: { code: invalid ? 'invalid_connection' : 'provider_operation_failed' } });
    });
    const base = '/api/v1/model-connections';
    const run = async (
      request: FastifyRequest,
      reply: FastifyReply,
      action: (
        ownerId: string,
        service: ProviderConnections,
        signal: AbortSignal,
      ) => Promise<unknown>,
      status = 200,
    ) => {
      reply.header('cache-control', 'private, no-store');
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== webOrigin)
        return reply.code(403).send({ error: { code: 'invalid_origin' } });
      const token = readSessionToken(request.headers.cookie);
      const identity = token ? await auth.getSession(token) : undefined;
      if (!identity) return reply.code(401).send({ error: { code: 'authentication_required' } });
      if (!providers) return reply.code(503).send({ error: { code: 'providers_not_configured' } });
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.on('aborted', abort);
      reply.raw.on('close', abort);
      try {
        return reply
          .code(status)
          .send(
            await action(
              identity.user.id,
              'workspaceId' in (request.params as object)
                ? providers.inWorkspace((request.params as { workspaceId: string }).workspaceId)
                : providers,
              controller.signal,
            ),
          );
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'provider_operation_failed';
        return reply
          .code(
            code === 'workspace_forbidden'
              ? 403
              : code === 'connection_not_found'
                ? 404
                : code === 'connection_disabled' || code === 'connection_conflict'
                  ? 409
                  : code === 'provider_operation_failed' ||
                      code === 'provider_credentials_unavailable'
                    ? 503
                    : 400,
          )
          .send({ error: { code } });
      } finally {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
      }
    };
    const id = (request: FastifyRequest) => (request.params as { id: string }).id;
    for (const policyBase of [base, '/api/v1/workspaces/:workspaceId/model-connections']) {
      routes.get(`${policyBase}/:id/policy`, (request, reply) =>
        run(request, reply, (actor, service) => service.capabilities(actor, id(request))),
      );
      routes.post(`${policyBase}/:id/overrides`, (request, reply) =>
        run(request, reply, (actor, service) => service.override(actor, id(request), request.body)),
      );
      routes.post(`${policyBase}/:id/reprobe`, (request, reply) =>
        run(request, reply, (actor, service, signal) =>
          service.reprobe(actor, id(request), request.body, signal),
        ),
      );
      routes.put(`${policyBase}/:id/fallbacks`, (request, reply) =>
        run(request, reply, (actor, service) =>
          service.setFallbacks(actor, id(request), request.body),
        ),
      );
      routes.get(`${policyBase}/:id/resolution-preview`, (request, reply) =>
        run(request, reply, (actor, service) =>
          service.preview(
            actor,
            id(request),
            (request.query as { capability?: unknown }).capability,
          ),
        ),
      );
    }
    routes.get(base, (request, reply) =>
      run(request, reply, (owner, service) => service.list(owner)),
    );
    routes.get(`${base}/:id`, (request, reply) =>
      run(request, reply, (owner, service) => service.get(owner, id(request))),
    );
    routes.post(base, (request, reply) =>
      run(
        request,
        reply,
        (owner, service, signal) => service.save(owner, request.body, signal),
        201,
      ),
    );
    routes.put(`${base}/:id`, (request, reply) =>
      run(request, reply, (owner, service, signal) =>
        service.update(owner, id(request), request.body, signal),
      ),
    );
    routes.post(`${base}/:id/test`, (request, reply) =>
      run(request, reply, (owner, service, signal) => service.test(owner, id(request), signal)),
    );
    routes.patch(`${base}/:id`, (request, reply) =>
      run(request, reply, (owner, service) => {
        if (
          !request.body ||
          typeof request.body !== 'object' ||
          Object.keys(request.body).length !== 1 ||
          (request.body as { enabled: unknown }).enabled !== false
        )
          throw new ProviderError('invalid_connection');
        return service.disable(owner, id(request));
      }),
    );
    const workspaceBase = '/api/v1/workspaces/:workspaceId/model-connections';
    routes.get(workspaceBase, (request, reply) =>
      run(request, reply, (actor, service) => service.view(actor)),
    );
    routes.get(`${workspaceBase}/:id`, (request, reply) =>
      run(request, reply, (actor, service) => service.viewOne(actor, id(request))),
    );
    routes.post(workspaceBase, (request, reply) =>
      run(
        request,
        reply,
        async (actor, service, signal) => {
          const connection = await service.save(actor, request.body, signal);
          return service.viewOne(actor, connection.id);
        },
        201,
      ),
    );
    routes.put(`${workspaceBase}/:id`, (request, reply) =>
      run(request, reply, async (actor, service, signal) => {
        await service.update(actor, id(request), request.body, signal);
        return service.viewOne(actor, id(request));
      }),
    );
    routes.patch(`${workspaceBase}/:id`, (request, reply) =>
      run(request, reply, async (actor, service) => {
        if (
          !request.body ||
          typeof request.body !== 'object' ||
          Object.keys(request.body).length !== 1 ||
          (request.body as { enabled: unknown }).enabled !== false
        )
          throw new ProviderError('invalid_connection');
        await service.disable(actor, id(request));
        return service.viewOne(actor, id(request));
      }),
    );
    routes.post(`${workspaceBase}/:id/test`, (request, reply) =>
      run(request, reply, async (actor, service, signal) => {
        if (request.body !== undefined) throw new ProviderError('invalid_connection');
        return { report: publicProbe(await service.test(actor, id(request), signal)) };
      }),
    );
    routes.delete(`${base}/:id`, (request, reply) =>
      run(
        request,
        reply,
        async (owner, service) => {
          await service.delete(owner, id(request));
        },
        204,
      ),
    );
  });
}
