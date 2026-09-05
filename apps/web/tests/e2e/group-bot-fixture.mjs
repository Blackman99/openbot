// Browser-only UI contract. API and native suites prove persistence and authorization races.
import { randomUUID } from 'node:crypto';
import { recordFixtureMembership } from './member-fixture.mjs';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const groupId = 'ec661304-a1bc-4767-9a87-c47de763f749';
const conversationId = 'edcc0832-ce23-4d77-9c72-fb4e9d01766c';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const time = '2026-09-05T00:00:00.000Z';
const ada = {
  id: 'ab661304-a1bc-4767-9a87-c47de763f749',
  displayName: 'Ada',
  email: 'group-bot-ada@example.com',
};
const grace = {
  id: 'bb661304-a1bc-4767-9a87-c47de763f749',
  displayName: 'Grace',
  email: 'group-bot-grace@example.com',
};
let active = false;
let grants = [];
let receipts = new Map();
let attempts = [];
let sequence = 3;
let failAfterCommit = false;
let revoked = false;
let limit = false;
export function resetGroupBotFixture() {
  active = false;
  grants = [];
  receipts = new Map();
  attempts = [];
  sequence = 3;
  failAfterCommit = false;
  revoked = false;
  limit = false;
}
export function handleGroupBotFixture(request, response, context) {
  const { user, users, memberships, workspaces, createSession, readJson, sendJson, trustedOrigin } =
    context;
  const url = new URL(request.url ?? '/', 'http://fixture');
  const path = url.pathname;
  const login = (account) =>
    sendJson(
      response,
      200,
      { workspaceId, groupId },
      { 'set-cookie': `openbot_session=${createSession(account)}; Path=/; HttpOnly; SameSite=Lax` },
    );
  if (request.method === 'POST' && path === '/__group-bot/setup') {
    resetGroupBotFixture();
    active = true;
    for (const account of [ada, grace])
      users.set(account.email, { user: account, password: 'fixture-only-password' });
    workspaces.set(workspaceId, { id: workspaceId, name: 'Group Bot Lab', description: '' });
    memberships.set(
      workspaceId,
      new Map([
        [ada.id, 'owner'],
        [grace.id, 'member'],
      ]),
    );
    for (const account of [ada, grace]) recordFixtureMembership(workspaceId, account.id);
    login(ada);
    return true;
  }
  if (!active) return false;
  if (request.method === 'POST' && path === '/__group-bot/viewer') {
    login(grace);
    return true;
  }
  if (request.method === 'GET' && path === '/__group-bot/state') {
    sendJson(response, 200, { grants, attempts });
    return true;
  }
  if (request.method === 'POST' && path === '/__group-bot/state') {
    readJson(request, (input) => {
      failAfterCommit = input.failAfterCommit ?? failAfterCommit;
      revoked = input.revoked ?? revoked;
      limit = input.limit ?? limit;
      sendJson(response, 200, { ok: true });
    });
    return true;
  }
  if (!path.startsWith(`/api/v1/workspaces/${workspaceId}/`)) return false;
  const fail = (status, code) => sendJson(response, status, { error: { code } });
  if (!user) {
    fail(401, 'authentication_required');
    return true;
  }
  if (!memberships.get(workspaceId)?.has(user.id) || revoked) {
    fail(403, 'group_bot_forbidden');
    return true;
  }
  const manager = user.id === ada.id;
  const bot = {
    id: botId,
    name: 'Researcher',
    roleDescription: 'Research assistant',
    description: 'Find useful evidence',
    canInspect: manager,
  };
  const safe = (grant) => ({ ...grant, bot: { ...grant.bot, canInspect: manager } });
  const group = {
    id: groupId,
    workspaceId,
    name: 'Research group',
    description: '',
    visibility: 'private',
    role: manager ? 'owner' : 'member',
    createdAt: time,
    updatedAt: time,
  };
  if (path === `/api/v1/workspaces/${workspaceId}/groups`) {
    sendJson(response, 200, { groups: [group] });
    return true;
  }
  if (path === `/api/v1/workspaces/${workspaceId}/groups/${groupId}`) {
    sendJson(response, 200, { group });
    return true;
  }
  if (path === `/api/v1/workspaces/${workspaceId}/groups/${groupId}/members`) {
    sendJson(response, 200, {
      members: [ada, grace].map((person) => ({
        user: person,
        role: person.id === ada.id ? 'owner' : 'member',
        joinedAt: time,
        hasWorkspaceAccess: true,
      })),
    });
    return true;
  }
  if (path === `/api/v1/workspaces/${workspaceId}/bots`) {
    const { canInspect: _inspect, ...metadata } = bot;
    sendJson(response, 200, {
      bots: manager
        ? [
            {
              ...metadata,
              workspaceId,
              visibility: 'private',
              accessRole: 'owner',
              bindingStatus: { state: 'ready', chatOnly: true },
            },
            {
              ...metadata,
              id: workspaceId,
              name: 'Discovery only',
              workspaceId,
              visibility: 'workspace',
              accessRole: null,
              bindingStatus: { state: 'unavailable', reason: 'not-accessible' },
            },
          ]
        : [],
    });
    return true;
  }
  const match = new RegExp(
    `^/api/v1/workspaces/${workspaceId}/groups/${groupId}/bots(?:/([^/]+)/(remove|context))?$`,
    'u',
  ).exec(path);
  if (!match) return false;
  const [, grantId, operation] = match;
  if (request.method === 'GET' && !operation) {
    sendJson(response, 200, {
      groupId,
      grants: grants.map(safe),
      activeCount: grants.filter((grant) => !grant.closed).length,
      maxActive: 8,
      canManage: manager,
    });
    return true;
  }
  if (operation === 'context' && request.method === 'GET') {
    const grant = grants.find((item) => item.id === grantId);
    if (!grant) fail(403, 'group_bot_forbidden');
    else if (grant.closed) fail(409, 'group_bot_inactive');
    else {
      const message = (creationSequence, body) => ({
        id:
          creationSequence === 1
            ? '1dcc0832-ce23-4d77-9c72-fb4e9d01766c'
            : '2dcc0832-ce23-4d77-9c72-fb4e9d01766c',
        creationSequence,
        versionEventId: randomUUID(),
        sequence: creationSequence,
        version: 1,
        author: { id: ada.id, displayName: 'Ada' },
        body,
        reason: null,
        deleted: false,
        createdAt: time,
        updatedAt: time,
        canEdit: false,
        canDelete: false,
        canAudit: false,
      });
      sendJson(response, 200, {
        grantId,
        conversationId,
        messages: [
          message(1, 'Earlier private discussion'),
          message(grant.joined.sequence + 1, 'Message after invitation'),
        ].filter((item) => item.creationSequence >= grant.history.lowerBound),
        nextCursor: null,
      });
    }
    return true;
  }
  if (request.method !== 'POST') {
    fail(404, 'not_found');
    return true;
  }
  if (request.headers.origin !== trustedOrigin) {
    fail(403, 'invalid_origin');
    return true;
  }
  if (!manager) {
    fail(403, 'group_bot_forbidden');
    return true;
  }
  readJson(request, (input) => {
    const identity = `${user.id}:${input.idempotencyKey}`;
    const fingerprint = JSON.stringify({
      operation: operation ?? 'invite',
      grantId: grantId ?? null,
      input,
    });
    attempts.push({ operation: operation ?? 'invite', grantId: grantId ?? null, input });
    const retained = receipts.get(identity);
    if (retained) {
      if (retained.fingerprint !== fingerprint) fail(409, 'idempotency_conflict');
      else sendJson(response, 200, { grant: safe(retained.grant) });
      return;
    }
    let grant;
    if (operation === 'remove') {
      grant = grants.find((item) => item.id === grantId);
      if (!grant) {
        fail(403, 'group_bot_forbidden');
        return;
      }
      if (grant.closed) {
        fail(409, 'group_bot_inactive');
        return;
      }
      grant.closed = { eventId: randomUUID(), sequence: ++sequence, at: time, reason: 'removed' };
    } else {
      if (grants.some((item) => item.bot.id === input.botId && !item.closed)) {
        fail(409, 'group_bot_already_active');
        return;
      }
      if (limit || grants.filter((item) => !item.closed).length >= 8) {
        fail(409, 'group_bot_limit');
        return;
      }
      if (input.botId !== botId) {
        fail(403, 'group_bot_forbidden');
        return;
      }
      const history = input.history ?? { mode: 'future-only' };
      const joined = { eventId: randomUUID(), sequence: ++sequence, at: time };
      if (history.mode === 'since-event' && history.eventId !== groupId) {
        fail(400, 'invalid_group_bot_request');
        return;
      }
      if (
        history.mode === 'since-time' &&
        (!Number.isFinite(Date.parse(history.time)) || Date.parse(history.time) > Date.now())
      ) {
        fail(400, 'invalid_group_bot_request');
        return;
      }
      grant = {
        id: randomUUID(),
        groupId,
        conversationId,
        bot,
        grantedBy: { id: user.id, displayName: user.displayName },
        history: { ...history, lowerBound: history.mode === 'future-only' ? joined.sequence : 1 },
        joined,
        closed: null,
      };
      grants.push(grant);
    }
    receipts.set(identity, { fingerprint, grant: structuredClone(grant) });
    if (failAfterCommit) {
      failAfterCommit = false;
      fail(503, 'group_bot_unavailable');
    } else sendJson(response, 200, { grant: safe(grant) });
  });
  return true;
}
