import { randomUUID } from 'node:crypto';
// Isolated UI seam. Production API tests prove persistence, audits and provider admission.
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const creator = {
  id: 'ab661304-a1bc-4767-9a87-c47de763f749',
  email: 'bot-owner@example.com',
  displayName: 'Ada',
};
const viewer = {
  id: 'bb661304-a1bc-4767-9a87-c47de763f749',
  email: 'bot-viewer@example.com',
  displayName: 'Grace',
};
const connectionId = 'ce661304-a1bc-4767-9a87-c47de763f749';
const disabledId = 'fe661304-a1bc-4767-9a87-c47de763f749';
const unknownId = 'de661304-a1bc-4767-9a87-c47de763f749';
const time = '2030-01-02T00:00:00.000Z';
let active = false;
let disabled = false;
let discoverable = false;
let bots = [];
let avatars = new Map();
export function resetBotFixture() {
  active = false;
  disabled = false;
  discoverable = false;
  bots = [];
  avatars = new Map();
}
function models() {
  return [
    {
      id: connectionId,
      name: 'Team Basic',
      modelId: 'basic-model',
      enabled: !disabled,
      basic: true,
    },
    {
      id: disabledId,
      name: 'Disabled model',
      modelId: 'disabled-model',
      enabled: false,
      basic: true,
    },
    {
      id: unknownId,
      name: 'Unverified model',
      modelId: 'unknown-model',
      enabled: true,
      basic: false,
    },
  ];
}
function catalog(model) {
  return {
    id: model.id,
    name: model.name,
    protocol: 'openai-chat',
    modelId: model.modelId,
    enabled: model.enabled,
    canManage: false,
    revision: 1,
    generation: 0,
    basic: model.basic,
    collaboration: false,
    enhanced: { visionInput: false },
    lastProbedAt: model.basic ? time : null,
    flags: Object.fromEntries(
      ['text', 'streaming', 'toolCalling', 'structuredOutput', 'visionInput'].map((flag) => {
        const known = model.basic;
        const supported = flag === 'text' || flag === 'streaming';
        return [
          flag,
          {
            status: known ? (supported ? 'supported' : 'unsupported') : 'unknown',
            source: known ? 'probe' : 'unknown',
            evidence: known ? 'passed' : 'not_probed',
            actorUserId: known ? creator.id : null,
            observedAt: known ? time : null,
            lastProbedAt: known ? time : null,
            manualBadge: false,
          },
        ];
      }),
    ),
    fallbacks: { requiredCapability: 'basic', connectionIds: [] },
  };
}
export function handleBotFixture(request, response, context) {
  const { user, users, memberships, workspaces, createSession, readJson, sendJson, trustedOrigin } =
    context;
  const path = new URL(request.url ?? '/', 'http://fixture').pathname;
  const login = (account) =>
    sendJson(
      response,
      200,
      { workspaceId },
      {
        'set-cookie': `openbot_session=${createSession(account)}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
      },
    );
  if (request.method === 'POST' && path === '/__bot/setup') {
    resetBotFixture();
    active = true;
    for (const account of [creator, viewer])
      users.set(account.email, { user: account, password: 'fixture-bot-password' });
    workspaces.set(workspaceId, { id: workspaceId, name: 'Bot Lab', description: '' });
    memberships.set(
      workspaceId,
      new Map([
        [creator.id, 'owner'],
        [viewer.id, 'administrator'],
      ]),
    );
    login(creator);
    return true;
  }
  if (!active) return false;
  if (request.method === 'POST' && path === '/__bot/viewer') {
    login(viewer);
    return true;
  }
  if (request.method === 'POST' && path === '/__bot/state') {
    readJson(request, (input) => {
      if (typeof input.disabled === 'boolean') disabled = input.disabled;
      if (typeof input.discoverable === 'boolean') discoverable = input.discoverable;
      sendJson(response, 200, { count: bots.length });
    });
    return true;
  }
  if (request.method === 'GET' && path === '/__bot/state') {
    sendJson(response, 200, { bots });
    return true;
  }
  const sharedBase = `/api/v1/workspaces/${workspaceId}/model-connections`;
  const botBase = `/api/v1/workspaces/${workspaceId}/bots`;
  if (
    path !== '/api/v1/model-connections' &&
    !path.startsWith(sharedBase) &&
    !path.startsWith(botBase)
  )
    return false;
  const reject = (status, code, reason) =>
    sendJson(response, status, { error: { code, ...(reason ? { reason } : {}) } });
  if (!user) {
    reject(401, 'authentication_required');
    return true;
  }
  if (!memberships.get(workspaceId)?.has(user.id)) {
    reject(403, 'bot_forbidden');
    return true;
  }
  if (path === '/api/v1/model-connections') {
    sendJson(response, 200, []);
    return true;
  }
  if (path === sharedBase) {
    sendJson(response, 200, {
      canManage: false,
      connections: models().map((model) => ({
        id: model.id,
        name: model.name,
        protocol: 'openai-chat',
        modelId: model.modelId,
        availability: model.enabled ? 'available' : 'unavailable',
        lastProbe: {
          testedAt: time,
          text: { ok: true, code: 'passed' },
          action: { ok: false, code: 'unsupported' },
        },
      })),
    });
    return true;
  }
  if (path.startsWith(sharedBase)) {
    const model = models().find((value) => path === `${sharedBase}/${value.id}/policy`);
    if (model) sendJson(response, 200, catalog(model));
    else reject(404, 'connection_not_found');
    return true;
  }
  const summary = (bot) => ({
    id: bot.id,
    workspaceId,
    visibility: discoverable ? 'workspace' : 'private',
    accessRole: user.id === creator.id ? 'owner' : null,
    ...(user.id === creator.id && bot.currentVersion.configuration.avatarObjectId
      ? { avatarVersionId: bot.currentVersion.id }
      : {}),
    name: bot.currentVersion.configuration.name,
    roleDescription: bot.currentVersion.configuration.roleDescription,
    description: bot.currentVersion.configuration.description,
    bindingStatus: disabled
      ? { state: 'unavailable', reason: 'disabled' }
      : { state: 'ready', chatOnly: true },
  });
  const detail = (bot) => ({
    ...summary(bot),
    ...(user.id === creator.id ? { currentVersion: bot.currentVersion } : {}),
  });
  const avatarBot = bots.find((value) => path === `${botBase}/${value.id}/avatar`);
  if (avatarBot) {
    if (user.id !== creator.id) {
      reject(403, 'bot_forbidden');
      return true;
    }
    const query = new URL(request.url, 'http://fixture').searchParams;
    if (request.method === 'GET' || request.method === 'HEAD') {
      const bytes = avatars.get(query.get('versionId') ?? avatarBot.currentVersion.id);
      if (!bytes) {
        reject(404, 'avatar_not_found');
        return true;
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return true;
    }
    if (request.headers.origin !== trustedOrigin) {
      reject(403, 'invalid_origin');
      return true;
    }
    if (query.get('expectedCurrentVersionId') !== avatarBot.currentVersion.id) {
      reject(409, 'bot_version_conflict');
      return true;
    }
    const publish = (bytes) => {
      const version = {
        ...avatarBot.currentVersion,
        id: randomUUID(),
        number: avatarBot.currentVersion.number + 1,
        rationale: bytes ? 'Avatar updated' : 'Avatar removed',
        configuration: {
          ...avatarBot.currentVersion.configuration,
          avatarObjectId: bytes ? randomUUID() : null,
        },
      };
      if (bytes) avatars.set(version.id, bytes);
      avatarBot.currentVersion = version;
      sendJson(response, 200, { version });
    };
    if (request.method === 'DELETE') {
      publish(null);
      return true;
    }
    if (request.method !== 'PUT') {
      reject(404, 'not_found');
      return true;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length > 2097152 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ) {
        reject(400, 'invalid_avatar');
        return;
      }
      // Full decoder behavior is independently exercised by API contract tests.
      publish(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
          'base64',
        ),
      );
    });
    return true;
  }
  if (request.method === 'GET') {
    if (path === botBase)
      sendJson(response, 200, {
        bots: user.id === creator.id || discoverable ? bots.map(summary) : [],
      });
    else {
      const bot = bots.find((value) => path === `${botBase}/${value.id}`);
      if (!bot || (user.id !== creator.id && !discoverable)) reject(403, 'bot_forbidden');
      else sendJson(response, 200, { bot: detail(bot) });
    }
    return true;
  }
  if (request.method !== 'POST' || path !== botBase) {
    reject(404, 'not_found');
    return true;
  }
  if (request.headers.origin !== trustedOrigin) {
    reject(403, 'invalid_origin');
    return true;
  }
  readJson(request, (input) => {
    if (
      !input.name?.trim() ||
      input.name.trim().length > 100 ||
      !input.roleDescription?.trim() ||
      input.roleDescription.trim().length > 200 ||
      input.description?.length > 2000 ||
      !input.instructions?.trim() ||
      input.instructions.length > 32000
    ) {
      reject(400, 'invalid_bot_request');
      return;
    }
    if (
      disabled ||
      input.modelBinding.connectionId !== connectionId ||
      input.modelBinding.scope.id !== workspaceId ||
      input.modelBinding.modelId !== 'basic-model'
    ) {
      reject(400, 'bot_model_unavailable', disabled ? 'disabled' : 'not-accessible');
      return;
    }
    const id = `bdcc0832-ce23-4d77-9c72-${String(bots.length + 1).padStart(12, '0')}`;
    const bot = {
      id,
      currentVersion: {
        id: `ddcc0832-ce23-4d77-9c72-${String(bots.length + 1).padStart(12, '0')}`,
        number: 1,
        author: { id: creator.id, displayName: creator.displayName },
        createdAt: time,
        rationale: 'Created',
        configuration: {
          ...input,
          name: input.name.trim(),
          roleDescription: input.roleDescription.trim(),
          description: input.description?.trim() ?? '',
          limits: {
            maxTotalTokens: 32768,
            maxDurationSeconds: 300,
            maxTurns: 8,
            maxDelegationDepth: 2,
            ...input.limits,
          },
        },
      },
    };
    bots.push(bot);
    sendJson(response, 201, { bot: detail(bot) });
  });
  return true;
}
