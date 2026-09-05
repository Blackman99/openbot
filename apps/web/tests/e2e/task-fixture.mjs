// Browser-only saved-state seam. Real API/worker/native suites prove atomic execution and locking.
import { randomUUID } from 'node:crypto';
import { appendTaskMessageFixture, readTaskConversationFixture } from './conversation-fixture.mjs';

const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const groupId = 'ec661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const grantId = 'adcc0832-ce23-4d77-9c72-fb4e9d01766c';
const versionId = '30000000-0000-4000-8000-000000000003';
const time = '2026-09-05T00:00:00.000Z';
const bot = { id: botId, name: 'Researcher', versionId, versionNumber: 3 };
let conversation;
let records = [];
let attempts = [];
let protectedReads = [];
let failAfterCommit = false;

export function resetTaskFixture() {
  conversation = undefined;
  records = [];
  attempts = [];
  protectedReads = [];
  failAfterCommit = false;
}

export function handleTaskFixture(request, response, context) {
  const { user, memberships, readJson, sendJson, trustedOrigin } = context;
  const url = new URL(request.url ?? '/', 'http://fixture');
  const path = url.pathname;
  const fail = (status, code) => sendJson(response, status, { error: { code } });
  if (request.method === 'POST' && path === '/__task/setup') {
    readJson(request, ({ conversationId }) => {
      resetTaskFixture();
      conversation = readTaskConversationFixture(conversationId, user?.id);
      if (!conversation) fail(400, 'invalid_fixture_conversation');
      else sendJson(response, 200, { conversationId: conversation.id, grantId, botId });
    });
    return true;
  }
  if (!conversation) return false;
  if (request.method === 'GET' && path === '/__task/state') {
    sendJson(response, 200, { tasks: records.map(({ task }) => task), attempts, protectedReads });
    return true;
  }
  if (request.method === 'POST' && path === '/__task/state') {
    readJson(request, (input) => {
      failAfterCommit = input.failAfterCommit ?? failAfterCommit;
      const record = records.find(({ task }) => task.id === input.taskId);
      if (record && ['running', 'completed', 'failed'].includes(input.status)) {
        const { task, executionUser } = record;
        const run = task.runs[0];
        task.status = input.status;
        run.status = input.status;
        run.startedAt = '2026-09-05T00:00:01.000Z';
        run.provider = {
          protocol: task.groupGrantId ? 'openai-chat' : 'openai-responses',
          modelId: task.groupGrantId ? 'actual-group-model' : 'actual-direct-model',
        };
        run.usage = input.usage ?? { inputTokens: 12, outputTokens: 0 };
        if (input.status !== 'running') run.finishedAt = '2026-09-05T00:00:02.000Z';
        if (input.status === 'failed') run.error = 'provider_failed';
        if (input.status === 'completed' && !run.output)
          run.output = appendTaskMessageFixture(
            conversation.id,
            executionUser,
            'The saved Bot response remains readable after reload.',
            {
              id: bot.id,
              displayName: bot.name,
              versionId: bot.versionId,
              versionNumber: bot.versionNumber,
            },
          );
      }
      sendJson(response, 200, { ok: true });
    });
    return true;
  }

  const base = `/api/v1/workspaces/${workspaceId}`;
  const taskBase = `${base}/conversations/${conversation.id}/tasks`;
  const grantsPath = `${base}/groups/${groupId}/bots`;
  const protectedPath = path === `${base}/bots` || path.startsWith(`${base}/bots/`);
  if (!path.startsWith(taskBase) && path !== grantsPath && !protectedPath) return false;
  if (!user) {
    fail(401, 'authentication_required');
    return true;
  }
  if (
    !memberships.get(workspaceId)?.has(user.id) ||
    !readTaskConversationFixture(conversation.id, user.id)
  ) {
    fail(403, path === grantsPath ? 'group_bot_forbidden' : 'task_forbidden');
    return true;
  }
  if (protectedPath) {
    protectedReads.push(path);
    if (path === `${base}/bots`) sendJson(response, 200, { bots: [] });
    else fail(403, 'bot_forbidden');
    return true;
  }
  if (path === grantsPath && request.method === 'GET') {
    const grant = {
      id: grantId,
      groupId,
      conversationId: conversation.id,
      bot: {
        id: botId,
        name: bot.name,
        roleDescription: 'Research assistant',
        description: 'Safe group Bot metadata',
        canInspect: false,
        lifecycleState: 'active',
      },
      grantedBy: { id: 'ab661304-a1bc-4767-9a87-c47de763f749', displayName: 'Ada' },
      history: { mode: 'future-only', lowerBound: 1 },
      joined: { eventId: 'fdcc0832-ce23-4d77-9c72-fb4e9d01766c', sequence: 1, at: time },
      closed: null,
    };
    sendJson(response, 200, {
      groupId,
      grants: [
        grant,
        {
          ...grant,
          id: '20000000-0000-4000-8000-000000000002',
          bot: { ...grant.bot, name: 'Closed helper' },
          closed: {
            eventId: '60000000-0000-4000-8000-000000000006',
            sequence: 2,
            at: time,
            reason: 'removed',
          },
        },
      ],
      activeCount: 1,
      maxActive: 8,
      canManage: false,
    });
    return true;
  }
  const taskId = path.slice(taskBase.length + 1);
  if (request.method === 'GET') {
    if (path === taskBase)
      sendJson(response, 200, {
        conversationId: conversation.id,
        tasks: records
          .map(({ task }) => task)
          .slice(0, Number(url.searchParams.get('limit') ?? 20)),
        nextCursor: null,
      });
    else {
      const record = records.find(({ task }) => task.id === taskId);
      if (!record) fail(403, 'task_forbidden');
      else sendJson(response, 200, { task: record.task });
    }
    return true;
  }
  if (request.method !== 'POST' || path !== taskBase) {
    fail(404, 'not_found');
    return true;
  }
  if (request.headers.origin !== trustedOrigin) {
    fail(403, 'invalid_origin');
    return true;
  }
  readJson(request, (command) => {
    attempts.push({ actorId: user.id, command });
    if (
      Object.keys(command).some(
        (key) => !['body', 'idempotencyKey', 'groupGrantId'].includes(key),
      ) ||
      typeof command.body !== 'string' ||
      !command.body.trim() ||
      command.body.length > 32000 ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(command.idempotencyKey ?? '') ||
      (conversation.subject.kind === 'group'
        ? command.groupGrantId !== grantId
        : command.groupGrantId !== undefined)
    ) {
      fail(400, 'invalid_task_request');
      return;
    }
    const saved = records.find(
      (record) =>
        record.executionUser.id === user.id &&
        record.command.idempotencyKey === command.idempotencyKey,
    );
    if (saved) {
      if (
        saved.command.body !== command.body ||
        saved.command.groupGrantId !== command.groupGrantId
      )
        fail(409, 'idempotency_conflict');
      else sendJson(response, 202, { task: saved.task });
      return;
    }
    const executionUser = { id: user.id, displayName: user.displayName };
    const task = {
      id: randomUUID(),
      conversationId: conversation.id,
      status: 'queued',
      createdAt: time,
      bot,
      executionUser,
      groupGrantId: command.groupGrantId ?? null,
      trigger: appendTaskMessageFixture(conversation.id, user, command.body),
      runs: [
        {
          id: randomUUID(),
          attempt: 1,
          status: 'queued',
          createdAt: time,
          startedAt: null,
          finishedAt: null,
          provider: null,
          usage: null,
          error: null,
          output: null,
        },
      ],
    };
    records.push({ task, command, executionUser });
    if (failAfterCommit) {
      failAfterCommit = false;
      fail(503, 'task_unavailable');
    } else sendJson(response, 202, { task });
  });
  return true;
}
