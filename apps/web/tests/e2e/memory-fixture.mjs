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
  candidates = [],
  intents = [],
  failAfterCommit = false;
export function resetMemoryFixture() {
  conversation = undefined;
  records = [];
  attempts = [];
  candidates = [];
  intents = [];
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
  if (request.method === 'POST' && path === '/__memory/setup-inbox') {
    readJson(request, ({ conversationId }) => {
      resetMemoryFixture();
      const current = readTaskConversationFixture(conversationId, user?.id);
      if (!current || current.subject.kind !== 'group') fail(400, 'invalid_memory_fixture');
      else {
        conversation = current;
        candidates.push({
          id: randomUUID(),
          runId: randomUUID(),
          status: 'pending',
          revision: 1,
          body: 'keep the edited evidence.',
          proposedScope: { kind: 'group', id: groupId },
          confidence: 0.5,
          confidenceSource: 'local_rule',
          sourceCount: 2,
          createdAt: time,
        });
        sendJson(response, 200, { candidateId: candidates[0].id });
      }
    });
    return true;
  }
  if (!conversation) return false;
  const inboxBase = `/api/v1/workspaces/${workspaceId}/conversations/${conversation.id}/memory-candidates`;
  if (path === inboxBase || path.startsWith(`${inboxBase}/`)) {
    if (!user || !memberships.get(workspaceId)?.has(user.id)) {
      fail(403, 'memory_forbidden');
      return true;
    }
    if (request.method === 'GET' && path === inboxBase) {
      sendJson(response, 200, { candidates, nextAfter: null });
      return true;
    }
    if (request.method !== 'GET' && request.headers.origin !== trustedOrigin) {
      fail(403, 'memory_forbidden');
      return true;
    }
    const rest = path.slice(inboxBase.length + 1).split('/');
    const candidate = candidates.find((row) => row.id === rest[0]);
    if (!candidate) {
      fail(403, 'memory_forbidden');
      return true;
    }
    if (request.method === 'PATCH' && rest.length === 1) {
      readJson(request, (command) => {
        if (candidate.status !== 'pending' || candidate.revision !== command.expectedRevision)
          fail(409, 'source_version_conflict');
        else {
          candidate.body = command.body;
          candidate.revision += 1;
          sendJson(response, 200, { candidate });
        }
      });
      return true;
    }
    if (request.method === 'POST' && rest[1] === 'rejections') {
      readJson(request, (command) => {
        if (candidate.status !== 'pending' || candidate.revision !== command.expectedRevision)
          fail(409, 'source_version_conflict');
        else {
          candidate.status = 'rejected';
          sendJson(response, 201, { candidate });
        }
      });
      return true;
    }
    if (request.method === 'POST' && rest[1] === 'approvals') {
      readJson(request, (command) => {
        if (
          command.destination?.kind !== 'group' ||
          command.destination.id !== groupId ||
          candidate.status !== 'pending' ||
          candidate.revision !== command.expectedRevision
        )
          fail(403, 'memory_forbidden');
        else {
          candidate.status = 'approved';
          sendJson(response, 201, {
            candidate,
            fact: {
              kind: 'approved_fact',
              id: randomUUID(),
              versionId: randomUUID(),
              version: 1,
              candidateId: candidate.id,
              scope: { kind: 'group', workspaceId, id: groupId },
              creator: { id: user.id, displayName: user.displayName },
              createdAt: time,
              confidence: command.confidence,
              confidenceSource: 'human',
              text: candidate.body,
            },
            replayed: false,
          });
        }
      });
      return true;
    }
    if (request.method === 'POST' && rest[1] === 'approval-previews') {
      readJson(request, (command) => {
        if (candidate.status !== 'pending' || candidate.revision !== command.expectedRevision)
          fail(409, 'source_version_conflict');
        else {
          const preview = {
            id: randomUUID(),
            expiresAt: time,
            content: candidate.body,
            destination: command.destination,
            visibility: {
              kind: command.destination.kind,
              id: command.destination.id,
              summary:
                command.destination.kind === 'workspace'
                  ? 'Workspace facts are available throughout this workspace.'
                  : command.destination.kind === 'bot'
                    ? 'This Bot can use this reviewed fact across its conversations and groups. Participants in those conversations may see it. Other Bots cannot list, search, or receive it.'
                    : 'Group members with content access can use this reviewed fact in this group.',
            },
            disclosureVersion: 'mem-03-audience-v1',
          };
          intents.push({ ...preview, candidateId: candidate.id });
          sendJson(response, 200, { preview });
        }
      });
      return true;
    }
    if (request.method === 'POST' && rest[1] === 'approval-confirmations') {
      readJson(request, (command) => {
        const intent = intents.find(
          (row) => row.id === command.intentId && row.candidateId === candidate.id,
        );
        if (!intent || !command.acknowledged) fail(403, 'memory_forbidden');
        else {
          candidate.status = 'approved';
          sendJson(response, 201, {
            candidate,
            fact: {
              kind: 'approved_fact',
              id: randomUUID(),
              versionId: randomUUID(),
              version: 1,
              candidateId: candidate.id,
              scope: {
                kind: intent.destination.kind,
                workspaceId,
                id: intent.destination.id,
              },
              creator: { id: user.id, displayName: user.displayName },
              createdAt: time,
              confidence: 0.7,
              confidenceSource: 'human',
              text: candidate.body,
            },
            replayed: false,
          });
        }
      });
      return true;
    }
    fail(404, 'not_found');
    return true;
  }
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
