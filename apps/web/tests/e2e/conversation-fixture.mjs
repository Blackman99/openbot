// Browser-only UI seam. API/native tests separately prove ledger persistence and locking.
import { createHash, randomUUID } from 'node:crypto';

const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const groupId = 'ec661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const discoveryId = 'cc661304-a1bc-4767-9a87-c47de763f749';
const ada = {
  id: 'ab661304-a1bc-4767-9a87-c47de763f749',
  displayName: 'Ada',
  email: 'conversation-ada@example.com',
};
const grace = {
  id: 'bb661304-a1bc-4767-9a87-c47de763f749',
  displayName: 'Grace',
  email: 'conversation-grace@example.com',
};
const time = '2026-09-05T00:00:00.000Z';
let active = false;
let failAfterCommit = false;
let revoked = new Set();
let threads = [];
let attempts = [];

export function resetConversationFixture() {
  active = false;
  failAfterCommit = false;
  revoked = new Set();
  threads = [];
  attempts = [];
}

function metadata(thread) {
  return {
    id: thread.id,
    workspaceId,
    subject: thread.subject,
    createdAt: time,
    ...(thread.subject.kind === 'direct-bot' ? { botLifecycleState: 'active' } : {}),
  };
}
function actor(user) {
  return { id: user.id, displayName: user.displayName };
}
function append(thread, user, type, body, reason, message) {
  const event = {
    id: randomUUID(),
    sequence: ++thread.sequence,
    type,
    version: message ? message.versions.length + 1 : 1,
    actor: actor(user),
    occurredAt: time,
    body,
    reason,
  };
  if (!message) {
    message = {
      id: randomUUID(),
      author: actor(user),
      creationSequence: event.sequence,
      versions: [],
    };
    thread.messages.push(message);
  }
  message.versions.push(event);
  return { messageId: message.id, eventId: event.id, sequence: event.sequence };
}

export function readTaskConversationFixture(conversationId, userId) {
  const thread = threads.find(({ id }) => id === conversationId);
  if (
    !active ||
    !thread ||
    (thread.subject.kind === 'direct-bot' ? thread.creatorId !== userId : revoked.has(userId))
  )
    return undefined;
  return metadata(thread);
}

export function appendTaskMessageFixture(conversationId, user, body, bot) {
  const thread = threads.find(({ id }) => id === conversationId);
  if (!thread) throw new Error('Task conversation fixture is missing');
  const receipt = append(thread, user, 'message.created', body, null);
  if (bot) thread.messages.at(-1).author = { kind: 'bot', ...bot };
  return receipt;
}

export function handleConversationFixture(request, response, context) {
  const { user, users, memberships, workspaces, createSession, readJson, sendJson, trustedOrigin } =
    context;
  const url = new URL(request.url ?? '/', 'http://fixture');
  const path = url.pathname;
  const login = (account) =>
    sendJson(
      response,
      200,
      { workspaceId },
      { 'set-cookie': `openbot_session=${createSession(account)}; Path=/; HttpOnly; SameSite=Lax` },
    );
  if (request.method === 'POST' && path === '/__conversation/setup') {
    resetConversationFixture();
    active = true;
    for (const account of [ada, grace])
      users.set(account.email, { user: account, password: 'fixture-only-password' });
    workspaces.set(workspaceId, { id: workspaceId, name: 'Conversation Lab', description: '' });
    memberships.set(
      workspaceId,
      new Map([
        [ada.id, 'owner'],
        [grace.id, 'member'],
      ]),
    );
    login(ada);
    return true;
  }
  if (!active) return false;
  if (request.method === 'POST' && path === '/__conversation/viewer') {
    login(grace);
    return true;
  }
  if (request.method === 'GET' && path === '/__conversation/state') {
    sendJson(response, 200, { threads, attempts });
    return true;
  }
  if (request.method === 'POST' && path === '/__conversation/state') {
    readJson(request, (input) => {
      if (input.failAfterCommit) failAfterCommit = true;
      if (input.revoke) revoked.add(input.revoke);
      if (input.removeWorkspace) memberships.get(workspaceId).delete(input.removeWorkspace);
      const thread = threads.find(({ id }) => id === input.conversationId);
      if (thread && input.seed)
        for (const body of input.seed) append(thread, ada, 'message.created', body, null);
      const message = thread?.messages.find(({ id }) => id === input.messageId);
      if (message && input.edit) append(thread, ada, 'message.edited', input.edit, null, message);
      if (message && input.tombstone)
        append(thread, ada, 'message.deleted', null, 'Removed by moderator', message);
      sendJson(response, 200, { ok: true });
    });
    return true;
  }
  const base = `/api/v1/workspaces/${workspaceId}`;
  if (
    !path.startsWith(`${base}/conversations`) &&
    path !== `${base}/groups` &&
    path !== `${base}/bots`
  )
    return false;
  const fail = (status, code) => sendJson(response, status, { error: { code } });
  if (!user) {
    fail(401, 'authentication_required');
    return true;
  }
  if (!memberships.get(workspaceId)?.has(user.id)) {
    fail(403, 'conversation_forbidden');
    return true;
  }
  if (request.method !== 'GET' && request.headers.origin !== trustedOrigin) {
    fail(403, 'invalid_origin');
    return true;
  }
  if (path === `${base}/groups`) {
    const group = {
      id: groupId,
      workspaceId,
      name: 'Research group',
      description: '',
      visibility: 'private',
      role: revoked.has(user.id) ? null : user.id === ada.id ? 'owner' : 'member',
      createdAt: time,
      updatedAt: time,
    };
    sendJson(response, 200, {
      groups: [
        ...(revoked.has(user.id) ? [] : [group]),
        { ...group, id: discoveryId, name: 'Discovery group', visibility: 'workspace', role: null },
      ],
    });
    return true;
  }
  if (path === `${base}/bots`) {
    const bot = {
      id: botId,
      workspaceId,
      visibility: 'private',
      accessRole: 'owner',
      name: 'Researcher',
      roleDescription: 'Research assistant',
      description: '',
      lifecycleState: 'active',
      bindingStatus: { state: 'unavailable', reason: 'disabled' },
    };
    sendJson(response, 200, {
      bots: [
        bot,
        {
          ...bot,
          id: discoveryId,
          visibility: 'workspace',
          accessRole: null,
          name: 'Discovery Bot',
        },
      ],
    });
    return true;
  }
  const attachmentPath =
    /^\/conversations\/([^/]+)\/(attachments|messages\/([^/]+)\/(attachment\/content|purge))$/u.exec(
      path.slice(base.length),
    );
  if (attachmentPath) {
    const [, conversationId, , messageId, action] = attachmentPath;
    const thread = threads.find((item) => item.id === conversationId);
    if (
      !thread ||
      (thread.subject.kind === 'direct-bot' ? thread.creatorId !== user.id : revoked.has(user.id))
    ) {
      fail(403, 'conversation_forbidden');
      return true;
    }
    if (action === 'attachment/content') {
      const message = thread.messages.find((item) => item.id === messageId);
      if (!message?.attachment || message.versions.at(-1).type === 'message.deleted') {
        fail(403, 'conversation_forbidden');
        return true;
      }
      response.writeHead(200, {
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-type': message.attachment.mediaType,
        'content-length': String(message.bytes.length),
        'content-disposition': `attachment; filename="${message.attachment.filename}"; filename*=UTF-8''${encodeURIComponent(message.attachment.filename)}`,
      });
      response.end(message.bytes);
      return true;
    }
    if (action === 'purge') {
      const message = thread.messages.find((item) => item.id === messageId);
      if (!message || (message.author.id !== user.id && user.id !== ada.id)) {
        fail(403, 'conversation_forbidden');
        return true;
      }
      if (!message.purged) append(thread, user, 'message.deleted', null, 'Message purged', message);
      message.purged = true;
      delete message.attachment;
      delete message.bytes;
      for (const version of message.versions) version.body = null;
      sendJson(response, 200, { purge: { state: 'complete' } });
      return true;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 11 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const body = Buffer.concat(chunks),
          length = body.readUInt32BE(0),
          command = JSON.parse(body.subarray(4, 4 + length).toString()),
          bytes = body.subarray(4 + length);
        if (
          command.bytes !== bytes.length ||
          command.sha256 !== createHash('sha256').update(bytes).digest('hex')
        ) {
          fail(400, 'invalid_attachment');
          return;
        }
        const fingerprint = JSON.stringify(command),
          saved = thread.receipts.find(
            (item) => item.actorId === user.id && item.key === command.idempotencyKey,
          );
        attempts.push({ actorId: user.id, conversationId, type: 'attachment', command });
        if (saved) {
          if (saved.fingerprint !== fingerprint) fail(409, 'idempotency_conflict');
          else sendJson(response, 200, { receipt: saved.receipt });
          return;
        }
        const receipt = append(thread, user, 'message.created', command.body, null),
          message = thread.messages.at(-1);
        message.attachment = {
          id: randomUUID(),
          filename: command.filename,
          mediaType: command.mediaType,
          bytes: command.bytes,
        };
        message.bytes = bytes;
        thread.receipts.push({
          actorId: user.id,
          key: command.idempotencyKey,
          fingerprint,
          receipt,
        });
        if (failAfterCommit) {
          failAfterCommit = false;
          fail(503, 'attachment_unavailable');
        } else sendJson(response, 200, { receipt });
      } catch {
        fail(400, 'invalid_attachment');
      }
    });
    return true;
  }
  const match =
    /^\/conversations(?:\/([^/]+)(?:\/messages(?:\/([^/]+)(?:\/(tombstone|versions))?)?)?)?$/u.exec(
      path.slice(base.length),
    );
  if (!match) {
    fail(404, 'not_found');
    return true;
  }
  const [, conversationId, messageId, suffix] = match;
  if (!conversationId && request.method === 'POST') {
    readJson(request, ({ subject }) => {
      if (
        (subject?.kind === 'group' && subject.id === groupId && !revoked.has(user.id)) ||
        (subject?.kind === 'direct-bot' && subject.id === botId)
      ) {
        let thread = threads.find(
          (value) =>
            value.subject.kind === subject.kind &&
            value.subject.id === subject.id &&
            (subject.kind === 'group' || value.creatorId === user.id),
        );
        if (!thread) {
          thread = {
            id: randomUUID(),
            subject,
            creatorId: user.id,
            sequence: 0,
            messages: [],
            receipts: [],
          };
          threads.push(thread);
        }
        sendJson(response, 200, { conversation: metadata(thread) });
      } else fail(403, 'conversation_forbidden');
    });
    return true;
  }
  const thread = threads.find(({ id }) => id === conversationId);
  if (
    !thread ||
    (thread.subject.kind === 'direct-bot' ? thread.creatorId !== user.id : revoked.has(user.id))
  ) {
    fail(403, 'conversation_forbidden');
    return true;
  }
  const message = thread.messages.find(({ id }) => id === messageId);
  const canAudit = (item) =>
    item.author.kind !== 'bot' &&
    (item.author.id === user.id || (thread.subject.kind === 'group' && user.id === ada.id));
  if (request.method === 'GET') {
    if (suffix === 'versions') {
      if (!message || message.purged || !canAudit(message)) fail(403, 'conversation_forbidden');
      else sendJson(response, 200, { versions: message.versions });
      return true;
    }
    const limit = Number(url.searchParams.get('limit') ?? 30);
    let cursor = { horizon: thread.sequence, after: 0 };
    if (url.searchParams.has('messageId')) {
      const target = thread.messages.find(({ id }) => id === url.searchParams.get('messageId'));
      if (!target) {
        fail(403, 'conversation_forbidden');
        return true;
      }
      cursor.after = Math.max(0, target.creationSequence - limit);
    }
    if (url.searchParams.has('cursor')) {
      try {
        cursor = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString());
      } catch {
        fail(400, 'invalid_conversation_request');
        return true;
      }
    }
    const remaining = thread.messages.filter(
      (item) => item.creationSequence > cursor.after && item.creationSequence <= cursor.horizon,
    );
    const selected = remaining.slice(0, limit);
    const messages = selected.map((item) => {
      const latest = item.versions.at(-1);
      const deleted = latest.type === 'message.deleted';
      return {
        ...(item.attachment && !deleted ? { attachment: item.attachment } : {}),
        id: item.id,
        creationSequence: item.creationSequence,
        versionEventId: latest.id,
        sequence: latest.sequence,
        version: latest.version,
        author: item.author,
        body: latest.body,
        reason: latest.reason,
        deleted,
        createdAt: time,
        updatedAt: time,
        canEdit: !deleted && item.author.kind !== 'bot' && item.author.id === user.id,
        canDelete: !deleted && canAudit(item),
        canAudit: !item.purged && canAudit(item),
      };
    });
    const nextCursor =
      remaining.length > limit
        ? Buffer.from(
            JSON.stringify({ horizon: cursor.horizon, after: selected.at(-1).creationSequence }),
          ).toString('base64url')
        : null;
    sendJson(response, 200, {
      conversation: metadata(thread),
      messages,
      nextCursor,
      canWrite: true,
    });
    return true;
  }
  readJson(request, (command) => {
    const type =
      suffix === 'tombstone'
        ? 'message.deleted'
        : request.method === 'PATCH'
          ? 'message.edited'
          : 'message.created';
    attempts.push({ actorId: user.id, conversationId, messageId, type, command });
    if (
      type !== 'message.created' &&
      (!message ||
        !canAudit(message) ||
        (type === 'message.edited' && message.author.id !== user.id))
    ) {
      fail(403, 'conversation_forbidden');
      return;
    }
    const fingerprint = JSON.stringify({ type, messageId, command });
    const saved = thread.receipts.find(
      (item) => item.actorId === user.id && item.key === command.idempotencyKey,
    );
    if (saved) {
      if (saved.fingerprint !== fingerprint) fail(409, 'idempotency_conflict');
      else sendJson(response, 200, { receipt: saved.receipt });
      return;
    }
    if (
      type !== 'message.created' &&
      (command.expectedVersion !== message.versions.length ||
        message.versions.at(-1).type === 'message.deleted')
    ) {
      fail(409, 'message_version_conflict');
      return;
    }
    if (type === 'message.deleted' && message.author.id !== user.id && !command.reason?.trim()) {
      fail(400, 'invalid_conversation_request');
      return;
    }
    const receipt = append(
      thread,
      user,
      type,
      type === 'message.deleted' ? null : command.body,
      type === 'message.deleted' ? command.reason?.trim() || 'Deleted by author' : null,
      message,
    );
    thread.receipts.push({ actorId: user.id, key: command.idempotencyKey, fingerprint, receipt });
    if (failAfterCommit) {
      failAfterCommit = false;
      fail(503, 'conversation_unavailable');
    } else sendJson(response, 200, { receipt });
  });
  return true;
}
