import type { FastifyInstance } from 'fastify';
import { readApiRequestToken } from '../api-tokens/routes.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  type ApiTokenService,
} from '../api-tokens/service.js';
import {
  GroupAccessError,
  GroupArchivedError,
  GroupInputError,
  GroupMemberConflictError,
  GroupMemberNotFoundError,
  LastGroupOwnerError,
  type GroupService,
  type PublicGroup,
} from './service.js';
import {
  GroupBotAccessError,
  GroupBotConflictError,
  GroupBotInputError,
  type GroupBotService,
} from '../group-bots/service.js';
import {
  GroupRoutingService,
  RoutingSettingConflictError,
  RoutingSettingInputError,
} from '../routing/service.js';
import { BotInputError } from '../bots/service.js';
import { versionId, versionObject } from '../bots/version-data.js';

function emptyQuery(query: unknown) {
  if (!versionObject(query) || Object.keys(query).length) throw new GroupInputError();
}
function groupPageQuery(query: unknown) {
  if (!versionObject(query) || Object.keys(query).some((key) => !['after', 'limit'].includes(key)))
    throw new GroupInputError();
  const after = query.after === undefined ? undefined : versionId(query.after);
  if (
    query.limit !== undefined &&
    (typeof query.limit !== 'string' ||
      !/^[1-9][0-9]*$/u.test(query.limit) ||
      Number(query.limit) > 100)
  )
    throw new GroupInputError();
  return { after, limit: query.limit === undefined ? 50 : Number(query.limit) };
}

async function publicGroup(
  groups: GroupService,
  routing: GroupRoutingService,
  actorId: string,
  workspaceId: string,
  groupId: string,
  admit: (connection: import('../auth/postgres-auth-repository.js').SqlConnection) => Promise<void>,
): Promise<{ group: PublicGroup & { defaultLead: unknown } }> {
  const group = await groups.inspect(actorId, workspaceId, groupId, admit);
  const setting = await routing.get(actorId, workspaceId, groupId, admit);
  return { group: { ...group, defaultLead: setting.defaultLead } };
}

export function registerPublicGroupRoutes(
  app: FastifyInstance,
  tokens: ApiTokenService,
  groups: GroupService,
  groupBots: GroupBotService,
  routing: GroupRoutingService,
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
      if (error instanceof LastGroupOwnerError)
        return reply.code(409).send({ error: { code: 'last_group_owner_required' } });
      if (error instanceof GroupMemberNotFoundError)
        return reply.code(404).send({ error: { code: 'group_member_not_found' } });
      if (error instanceof GroupMemberConflictError)
        return reply.code(409).send({ error: { code: 'group_member_conflict' } });
      if (error instanceof GroupArchivedError)
        return reply.code(409).send({ error: { code: 'group_archived' } });
      if (error instanceof GroupAccessError)
        return reply.code(403).send({ error: { code: 'group_forbidden' } });
      if (error instanceof GroupInputError || error instanceof BotInputError)
        return reply.code(400).send({ error: { code: 'invalid_group_request' } });
      if (error instanceof GroupBotAccessError)
        return reply.code(403).send({ error: { code: 'group_forbidden' } });
      if (error instanceof GroupBotConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof GroupBotInputError)
        return reply.code(400).send({ error: { code: 'invalid_group_request' } });
      if (error instanceof RoutingSettingConflictError)
        return reply.code(409).send({ error: { code: 'routing_revision_conflict' } });
      if (error instanceof RoutingSettingInputError)
        return reply.code(400).send({ error: { code: 'invalid_group_request' } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        [400, 413, 415].includes(error.statusCode)
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_group_request' } });
      return reply.code(503).send({ error: { code: 'group_unavailable' } });
    });
    routes.get('/v1/groups', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'groups:read',
      );
      const { after, limit } = groupPageQuery(request.query);
      const visible = await groups.list(
        identity.user.id,
        identity.workspace.id,
        { includeArchived: true },
        admit,
      );
      const page = visible
        .filter((group) => after === undefined || group.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const selected = page.slice(0, limit);
      const details = [];
      for (const group of selected)
        details.push(
          (
            await publicGroup(
              groups,
              routing,
              identity.user.id,
              identity.workspace.id,
              group.id,
              admit,
            )
          ).group,
        );
      return { groups: details, nextAfter: page.length > limit ? selected.at(-1)!.id : null };
    });
    routes.post('/v1/groups', { bodyLimit: 16384 }, async (request, reply) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'groups:write',
      );
      emptyQuery(request.query);
      const created = await groups.create(
        identity.user.id,
        identity.workspace.id,
        request.body,
        admit,
      );
      return reply
        .code(201)
        .send(
          await publicGroup(
            groups,
            routing,
            identity.user.id,
            identity.workspace.id,
            created.id,
            admit,
          ),
        );
    });
    routes.get<{ Params: { groupId: string } }>('/v1/groups/:groupId', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'groups:read',
      );
      emptyQuery(request.query);
      return publicGroup(
        groups,
        routing,
        identity.user.id,
        identity.workspace.id,
        request.params.groupId,
        admit,
      );
    });
    routes.patch<{ Params: { groupId: string } }>(
      '/v1/groups/:groupId',
      { bodyLimit: 16384 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        await groups.update(
          identity.user.id,
          identity.workspace.id,
          request.params.groupId,
          request.body,
          admit,
        );
        return publicGroup(
          groups,
          routing,
          identity.user.id,
          identity.workspace.id,
          request.params.groupId,
          admit,
        );
      },
    );
    routes.post<{ Params: { groupId: string } }>(
      '/v1/groups/:groupId/archive',
      { bodyLimit: 1024 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        if (request.body !== undefined) throw new GroupInputError();
        const group = await groups.archive(
          identity.user.id,
          identity.workspace.id,
          request.params.groupId,
          admit,
        );
        const setting = await routing.get(
          identity.user.id,
          identity.workspace.id,
          request.params.groupId,
          admit,
        );
        return { group: { ...group, defaultLead: setting.defaultLead } };
      },
    );
    routes.get<{ Params: { groupId: string } }>('/v1/groups/:groupId/members', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'groups:read',
      );
      emptyQuery(request.query);
      return {
        members: await groups.members(
          identity.user.id,
          identity.workspace.id,
          request.params.groupId,
          admit,
        ),
      };
    });
    routes.post<{ Params: { groupId: string } }>(
      '/v1/groups/:groupId/members',
      { bodyLimit: 4096 },
      async (request, reply) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        return reply.code(201).send({
          member: await groups.addMember(
            identity.user.id,
            identity.workspace.id,
            request.params.groupId,
            request.body,
            admit,
          ),
        });
      },
    );
    routes.delete<{ Params: { groupId: string; userId: string } }>(
      '/v1/groups/:groupId/members/:userId',
      async (request, reply) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        await groups.removeMember(
          identity.user.id,
          identity.workspace.id,
          request.params.groupId,
          request.params.userId,
          admit,
        );
        return reply.code(204).send();
      },
    );
    routes.get<{ Params: { groupId: string } }>('/v1/groups/:groupId/bots', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'groups:read',
      );
      emptyQuery(request.query);
      return groupBots.list(identity.user.id, identity.workspace.id, request.params.groupId, admit);
    });
    routes.post<{ Params: { groupId: string } }>(
      '/v1/groups/:groupId/bots',
      { bodyLimit: 8192 },
      async (request, reply) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        return reply.code(201).send({
          grant: await groupBots.invite(
            identity.user.id,
            identity.workspace.id,
            request.params.groupId,
            request.body,
            admit,
          ),
        });
      },
    );
    routes.post<{ Params: { groupId: string; grantId: string } }>(
      '/v1/groups/:groupId/bots/:grantId/remove',
      { bodyLimit: 4096 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        return {
          grant: await groupBots.remove(
            identity.user.id,
            identity.workspace.id,
            request.params.groupId,
            request.params.grantId,
            request.body,
            admit,
          ),
        };
      },
    );
    routes.patch<{ Params: { groupId: string } }>(
      '/v1/groups/:groupId/routing',
      { bodyLimit: 4096 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'groups:write',
        );
        emptyQuery(request.query);
        return {
          routing: await routing.update(
            identity.user.id,
            identity.workspace.id,
            request.params.groupId,
            request.body,
            admit,
          ),
        };
      },
    );
  });
}
