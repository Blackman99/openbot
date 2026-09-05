// Browser-only UI state. API/native suites own source admission, persistence and Run proofs.
import { randomUUID } from 'node:crypto';
import { readCurrentMessageFixture, readTaskConversationFixture } from './conversation-fixture.mjs';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const groupId = 'ec661304-a1bc-4767-9a87-c47de763f749';
const allGrantId = '10000000-0000-4000-8000-000000000001';
const futureGrantId = '10000000-0000-4000-8000-000000000002';
const time = '2026-09-05T00:00:00.000Z';
let conversation,
  records = [],
  attempts = [],
  failAfterCommit = false;
export function resetMemoryFixture() {
  conversation = undefined;
  records = [];
  attempts = [];
  failAfterCommit = false;
}
export function handleMemoryFixture(request, response, context) {
  const { user, memberships, readJson, sendJson, trustedOrigin } = context;
  const url = new URL(request.url ?? '/', 'http://fixture'),
    path = url.pathname;
  const fail = (status, code) => sendJson(response, status, { error: { code } });
  if (request.method === 'POST' && path === '/__memory/setup') {
    readJson(request, ({ conversationId }) => {
      resetMemoryFixture();
      const current = readTaskConversationFixture(conversationId, user?.id);
      if (!current || current.subject.kind !== 'group') fail(400, 'invalid_memory_fixture');
      else {
        conversation = current;
        sendJson(response, 200, { allGrantId, futureGrantId });
      }
    });
    return true;
  }
  if (!conversation) return false;
  if (path === '/__memory/state') {
    if (request.method === 'POST')
      readJson(request, (input) => {
        failAfterCommit = input.failAfterCommit ?? failAfterCommit;
        sendJson(response, 200, { ok: true });
      });
    else sendJson(response, 200, { records, attempts });
    return true;
  }
  const base = `/api/v1/workspaces/${workspaceId}/groups/${groupId}`;
  if (path !== base && !path.startsWith(base + '/')) return false;
  if (!user) {
    fail(401, 'authentication_required');
    return true;
  }
  if (
    !memberships.get(workspaceId)?.has(user.id) ||
    !readTaskConversationFixture(conversation.id, user.id)
  ) {
    fail(403, path.includes('/memories') ? 'memory_forbidden' : 'group_forbidden');
    return true;
  }
  if (path === base && request.method === 'GET') {
    sendJson(response, 200, {
      group: {
        id: groupId,
        workspaceId,
        name: 'Research group',
        description: '',
        visibility: 'private',
        role: 'member',
        createdAt: time,
        updatedAt: time,
      },
    });
    return true;
  }
  if (path === base + '/bots' && request.method === 'GET') {
    const grant = (id, mode, lowerBound, name) => ({
      id,
      groupId,
      conversationId: conversation.id,
      bot: {
        id,
        name,
        roleDescription: 'Helper',
        description: '',
        canInspect: false,
        lifecycleState: 'active',
      },
      grantedBy: { id: user.id, displayName: user.displayName },
      history: { mode, lowerBound },
      joined: { eventId: id, sequence: lowerBound, at: time },
      closed: null,
    });
    sendJson(response, 200, {
      groupId,
      grants: [
        grant(allGrantId, 'all', 1, 'Full history helper'),
        grant(futureGrantId, 'future-only', 2, 'Future helper'),
      ],
      activeCount: 2,
      maxActive: 8,
      canManage: false,
    });
    return true;
  }
  const match = /^(?:\/bots\/([^/]+))?\/memories(?:\/([^/]+))?$/u.exec(path.slice(base.length));
  if (!match) return false;
  const [, grantId, suffix] = match;
  if (grantId && ![allGrantId, futureGrantId].includes(grantId)) {
    fail(403, 'memory_forbidden');
    return true;
  }
  const visible = (record) => {
    const source = readCurrentMessageFixture(
      conversation.id,
      user.id,
      record.memory.source.messageId,
    );
    if (
      !source ||
      source.eventId !== record.memory.source.eventId ||
      (grantId === futureGrantId && source.creationSequence < 2)
    )
      return undefined;
    return { ...record.memory, text: source.text };
  };
  if (request.method === 'GET' && suffix) {
    const record = records.find(({ memory }) => memory.id === suffix),
      memory = record && visible(record);
    if (!memory) fail(403, 'memory_forbidden');
    else sendJson(response, 200, { memory });
    return true;
  }
  const list = (query = {}) => {
    const available = records
      .map(visible)
      .filter(Boolean)
      .filter(
        (memory) =>
          (!query.after || memory.id > query.after) &&
          (!query.query || memory.text.toLowerCase().includes(query.query.toLowerCase())),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const limit = Number(query.limit ?? 30),
      selected = available.slice(0, limit);
    sendJson(response, 200, {
      memories: selected,
      nextAfter: available.length > limit ? selected.at(-1).id : null,
    });
  };
  if (request.method === 'GET') {
    list(Object.fromEntries(url.searchParams));
    return true;
  }
  if (request.method !== 'POST' || request.headers.origin !== trustedOrigin) {
    fail(403, 'memory_forbidden');
    return true;
  }
  if (suffix === 'search') {
    readJson(request, list);
    return true;
  }
  if (suffix || grantId) {
    fail(404, 'not_found');
    return true;
  }
  readJson(request, (command) => {
    attempts.push({ actorId: user.id, command });
    const previous = records.find(
      (record) =>
        record.memory.creator.id === user.id &&
        record.command.idempotencyKey === command.idempotencyKey,
    );
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(command))
        fail(409, 'idempotency_conflict');
      else {
        const memory = visible(previous);
        if (memory) sendJson(response, 200, { memory });
        else fail(403, 'memory_forbidden');
      }
      return;
    }
    const source = readCurrentMessageFixture(conversation.id, user.id, command.messageId);
    if (!source) {
      fail(403, 'memory_forbidden');
      return;
    }
    if (source.eventId !== command.expectedSourceEventId) {
      fail(409, 'source_version_conflict');
      return;
    }
    if (!Number.isFinite(command.confidence) || command.confidence < 0 || command.confidence > 1) {
      fail(400, 'invalid_memory_request');
      return;
    }
    const { text, ...provenance } = source;
    const memory = {
      id: randomUUID(),
      versionId: randomUUID(),
      version: 1,
      scope: { kind: 'group', workspaceId, groupId },
      creator: { id: user.id, displayName: user.displayName },
      createdAt: time,
      confidence: command.confidence,
      confidenceSource: 'human',
      source: { conversationId: conversation.id, ...provenance },
    };
    records.push({ command, memory });
    if (failAfterCommit) {
      failAfterCommit = false;
      fail(503, 'memory_unavailable');
    } else sendJson(response, 201, { memory: { ...memory, text } });
  });
  return true;
}
