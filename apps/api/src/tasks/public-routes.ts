import type { FastifyInstance } from 'fastify';
import { readApiRequestToken } from '../api-tokens/routes.js';
import {
  ApiTokenAuthenticationError,
  ApiTokenScopeError,
  type ApiTokenService,
} from '../api-tokens/service.js';
import {
  ConversationAccessError,
  InvalidConversationInputError,
  type ConversationService,
} from '../conversations/service.js';
import { ProviderError } from '../providers/url-policy.js';
import { RoutingSelectionError } from '../routing/matcher.js';
import {
  TaskAccessError,
  TaskConflictError,
  TaskInputError,
  type TaskConfirmedResult,
  type TaskDelegationNode,
  type TaskService,
  type TaskView,
} from './service.js';

function emptyQuery(query: unknown) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length)
    throw new TaskInputError();
}

function idempotencyKey(headers: Record<string, unknown>): string {
  const raw = headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^[!-~]{1,128}$/u.test(value)) throw new TaskInputError();
  return value;
}

function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new TaskInputError();
  return value.toLowerCase();
}

function publicSubmitBody(input: unknown): {
  groupId: string;
  prompt: string;
  leadGrantId?: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskInputError();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['groupId', 'prompt', 'leadGrantId'].includes(key)))
    throw new TaskInputError();
  if (
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    value.prompt.length > 32000 ||
    (value.leadGrantId !== undefined && typeof value.leadGrantId !== 'string')
  )
    throw new TaskInputError();
  return {
    groupId: uuid(value.groupId),
    prompt: value.prompt,
    ...(value.leadGrantId === undefined ? {} : { leadGrantId: uuid(value.leadGrantId) }),
  };
}

export function publicTaskView(task: TaskView, groupId: string) {
  return {
    id: task.id,
    groupId,
    conversationId: task.conversationId,
    status: task.status,
    createdAt: task.createdAt,
    leadGrantId: task.groupGrantId,
    bot: task.bot,
    executionUser: {
      id: task.executionUser.id,
      displayName: task.executionUser.displayName,
    },
    runCount: task.runCount,
    tokenBudgets: task.tokenBudgets,
    ...(task.costBudgets ? { costBudgets: task.costBudgets } : {}),
    ...(task.routing ? { routing: task.routing } : {}),
    runs: task.runs.map((run) => ({
      id: run.id,
      attempt: run.attempt,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      provider: run.provider,
      usage: run.usage,
      error: run.error,
      output: run.output,
    })),
  };
}

export function publicTaskDetailView(
  task: TaskView,
  groupId: string,
  delegationTree: { rootTaskId: string; nodes: TaskDelegationNode[] },
  confirmedResults: TaskConfirmedResult[],
) {
  return {
    ...publicTaskView(task, groupId),
    delegationTree,
    confirmedResults,
  };
}

export function registerPublicTaskRoutes(
  app: FastifyInstance,
  tokens: ApiTokenService,
  tasks: TaskService,
  conversations: ConversationService,
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
      if (error instanceof TaskAccessError || error instanceof ConversationAccessError)
        return reply.code(403).send({ error: { code: 'task_forbidden' } });
      if (error instanceof TaskConflictError)
        return reply.code(409).send({ error: { code: error.code } });
      if (error instanceof TaskInputError || error instanceof InvalidConversationInputError)
        return reply.code(400).send({ error: { code: 'invalid_task_request' } });
      if (error instanceof ProviderError)
        return reply.code(409).send({ error: { code: 'task_model_unavailable' } });
      if (error instanceof RoutingSelectionError)
        return reply.code(409).send({ error: { code: error.code } });
      if (
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        [400, 413, 415].includes(error.statusCode)
      )
        return reply.code(error.statusCode).send({ error: { code: 'invalid_task_request' } });
      return reply.code(503).send({ error: { code: 'task_unavailable' } });
    });
    routes.post('/v1/tasks', { bodyLimit: 65536 }, async (request, reply) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'tasks:write',
      );
      emptyQuery(request.query);
      const body = publicSubmitBody(request.body);
      const key = idempotencyKey(request.headers as Record<string, unknown>);
      const conversation = await conversations.open(identity.user.id, identity.workspace.id, {
        subject: { kind: 'group', id: body.groupId },
      });
      const task = await tasks.submit(
        identity.user.id,
        identity.workspace.id,
        conversation.id,
        {
          idempotencyKey: key,
          body: body.prompt,
          ...(body.leadGrantId ? { groupGrantId: body.leadGrantId } : {}),
        },
        admit,
      );
      return reply.code(202).send({ task: publicTaskView(task, body.groupId) });
    });
    routes.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request) => {
      const { identity, admit } = await tokens.authorizeResource(
        readApiRequestToken(request),
        'tasks:read',
      );
      emptyQuery(request.query);
      const detail = await tasks.getPublic(
        identity.user.id,
        identity.workspace.id,
        request.params.taskId,
        admit,
      );
      return {
        task: publicTaskDetailView(
          detail.task,
          detail.groupId,
          detail.delegationTree,
          detail.confirmedResults,
        ),
      };
    });
    routes.post<{ Params: { taskId: string } }>(
      '/v1/tasks/:taskId/cancellations',
      { bodyLimit: 16384 },
      async (request) => {
        const { identity, admit } = await tokens.authorizeResource(
          readApiRequestToken(request),
          'tasks:write',
        );
        emptyQuery(request.query);
        const cancelled = await tasks.cancelPublic(
          identity.user.id,
          identity.workspace.id,
          request.params.taskId,
          request.body,
          admit,
        );
        return {
          task: publicTaskView(cancelled.task, cancelled.groupId),
          receipt: cancelled.receipt,
        };
      },
    );
  });
}
