// Isolated browser seam. Native API tests independently prove immutable storage, locks and audit atomicity.
import { randomUUID } from 'node:crypto';
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const connectionId = 'ce661304-a1bc-4767-9a87-c47de763f749';
const alternateId = 'fe661304-a1bc-4767-9a87-c47de763f749';
const owner = {
  id: 'ab661304-a1bc-4767-9a87-c47de763f749',
  email: 'version-owner@example.com',
  displayName: 'Ada',
};
const viewer = {
  id: 'bb661304-a1bc-4767-9a87-c47de763f749',
  email: 'version-viewer@example.com',
  displayName: 'Grace',
};
const time = '2026-09-05T00:00:00.000Z';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
let active = false;
let versions = [];
let attempts = [];
let disabledCurrent = false;
let refuseNextModel = false;
let failAfterCommit = false;
let missingAvatar = false;
let viewerRole = 'user';
let ownerRole = 'owner';
export function resetBotVersionFixture() {
  active = false;
  versions = [];
  attempts = [];
  disabledCurrent = false;
  refuseNextModel = false;
  failAfterCommit = false;
  missingAvatar = false;
  viewerRole = 'user';
  ownerRole = 'owner';
}
function models() {
  return [
    { id: connectionId, name: 'Team Basic', modelId: 'basic-model', enabled: !disabledCurrent },
    { id: alternateId, name: 'Alternate', modelId: 'alternate-model', enabled: true },
  ];
}
function catalog(model) {
  return {
    id: model.id,
    name: model.name,
    modelId: model.modelId,
    protocol: 'openai-chat',
    enabled: model.enabled,
    canManage: false,
    revision: 1,
    generation: 0,
    basic: true,
    collaboration: false,
    enhanced: { visionInput: false },
    lastProbedAt: time,
    flags: Object.fromEntries(
      ['text', 'streaming', 'toolCalling', 'structuredOutput', 'visionInput'].map((flag) => [
        flag,
        {
          status: ['text', 'streaming'].includes(flag) ? 'supported' : 'unsupported',
          source: 'probe',
          evidence: 'passed',
          actorUserId: owner.id,
          observedAt: time,
          lastProbedAt: time,
          manualBadge: false,
        },
      ]),
    ),
    fallbacks: { requiredCapability: 'basic', connectionIds: [] },
  };
}
function fields(configuration) {
  return {
    name: configuration.name,
    roleDescription: configuration.roleDescription,
    description: configuration.description,
    instructions: configuration.instructions,
    'modelBinding.scope.kind': configuration.modelBinding.scope.kind,
    'modelBinding.scope.id': configuration.modelBinding.scope.id,
    'modelBinding.connectionId': configuration.modelBinding.connectionId,
    'modelBinding.modelId': configuration.modelBinding.modelId,
    avatarObjectId: configuration.avatarObjectId ?? null,
    'limits.maxTotalTokens': configuration.limits.maxTotalTokens,
    'limits.maxDurationSeconds': configuration.limits.maxDurationSeconds,
    'limits.maxTurns': configuration.limits.maxTurns,
    'limits.maxDelegationDepth': configuration.limits.maxDelegationDepth,
  };
}
function append(configuration, user, rationale) {
  const version = {
    id: randomUUID(),
    number: versions.length + 1,
    author: { id: user.id, displayName: user.displayName },
    createdAt: time,
    rationale,
    configuration: structuredClone(configuration),
  };
  versions.push(version);
  return version;
}
export function handleBotVersionFixture(request, response, context) {
  const { user, users, memberships, workspaces, createSession, readJson, sendJson, trustedOrigin } =
    context;
  const url = new URL(request.url ?? '/', 'http://fixture');
  const path = url.pathname;
  const login = (account) =>
    sendJson(
      response,
      200,
      { workspaceId, botId },
      { 'set-cookie': `openbot_session=${createSession(account)}; Path=/; HttpOnly; SameSite=Lax` },
    );
  if (request.method === 'POST' && path === '/__bot-version/setup') {
    resetBotVersionFixture();
    active = true;
    for (const account of [owner, viewer])
      users.set(account.email, { user: account, password: 'fixture-only-password' });
    workspaces.set(workspaceId, { id: workspaceId, name: 'Version Lab', description: '' });
    memberships.set(
      workspaceId,
      new Map([
        [owner.id, 'owner'],
        [viewer.id, 'member'],
      ]),
    );
    append(
      {
        name: 'Versioned researcher',
        roleDescription: 'Research assistant',
        description: 'Original description',
        instructions: 'Original instructions',
        modelBinding: {
          scope: { kind: 'workspace', id: workspaceId },
          connectionId,
          modelId: 'basic-model',
        },
        limits: {
          maxTotalTokens: 32768,
          maxDurationSeconds: 300,
          maxTurns: 8,
          maxDelegationDepth: 2,
        },
      },
      owner,
      'Created',
    );
    login(owner);
    return true;
  }
  if (!active) return false;
  if (request.method === 'POST' && path === '/__bot-version/viewer') {
    login(viewer);
    return true;
  }
  if (request.method === 'POST' && path === '/__bot-version/state') {
    readJson(request, (input) => {
      if (typeof input.disabledCurrent === 'boolean') disabledCurrent = input.disabledCurrent;
      if (typeof input.missingAvatar === 'boolean') missingAvatar = input.missingAvatar;
      if (input.failAfterCommit) failAfterCommit = true;
      if (input.refuseNextModel) refuseNextModel = true;
      if (['user', 'editor', null].includes(input.viewerRole)) viewerRole = input.viewerRole;
      if (['owner', 'editor', 'user', null].includes(input.ownerRole)) ownerRole = input.ownerRole;
      sendJson(response, 200, { ok: true });
    });
    return true;
  }
  if (request.method === 'GET' && path === '/__bot-version/state') {
    sendJson(response, 200, { versions, attempts });
    return true;
  }
  const base = `/api/v1/workspaces/${workspaceId}/bots/${botId}`;
  const shared = `/api/v1/workspaces/${workspaceId}/model-connections`;
  if (
    !path.startsWith(base) &&
    path !== `${base.slice(0, base.lastIndexOf('/'))}` &&
    path !== '/api/v1/model-connections' &&
    !path.startsWith(shared)
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
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.headers.origin !== trustedOrigin
  ) {
    reject(403, 'invalid_origin');
    return true;
  }
  if (path === '/api/v1/model-connections') {
    sendJson(response, 200, []);
    return true;
  }
  if (path === shared) {
    sendJson(response, 200, {
      canManage: false,
      connections: models().map((model) => ({
        id: model.id,
        name: model.name,
        modelId: model.modelId,
        protocol: 'openai-chat',
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
  if (path.startsWith(shared)) {
    const model = models().find((item) => path === `${shared}/${item.id}/policy`);
    if (model) sendJson(response, 200, catalog(model));
    else reject(404, 'connection_not_found');
    return true;
  }
  const role = user.id === owner.id ? ownerRole : viewerRole;
  const current = versions.at(-1);
  const summary = {
    id: botId,
    workspaceId,
    visibility: 'workspace',
    accessRole: role,
    name: current.configuration.name,
    roleDescription: current.configuration.roleDescription,
    description: current.configuration.description,
    bindingStatus: models().find(
      (model) => model.id === current.configuration.modelBinding.connectionId,
    )?.enabled
      ? { state: 'ready', chatOnly: true }
      : { state: 'unavailable', reason: 'disabled' },
    ...(role && current.configuration.avatarObjectId ? { avatarVersionId: current.id } : {}),
  };
  if (path === base && request.method === 'GET') {
    sendJson(response, 200, { bot: { ...summary, ...(role ? { currentVersion: current } : {}) } });
    return true;
  }
  if (path === base.slice(0, base.lastIndexOf('/')) && request.method === 'GET') {
    sendJson(response, 200, { bots: [summary] });
    return true;
  }
  if (!role) {
    reject(403, 'bot_forbidden');
    return true;
  }
  if (path === `${base}/avatar`) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const selected = versions.find(
        (version) => version.id === (url.searchParams.get('versionId') ?? current.id),
      );
      if (!selected?.configuration.avatarObjectId || missingAvatar) {
        reject(404, 'avatar_not_found');
        return true;
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(png.length),
        'cache-control': 'private, no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : png);
      return true;
    }
    if (role !== 'owner' && role !== 'editor') {
      reject(403, 'bot_forbidden');
      return true;
    }
    if (url.searchParams.get('expectedCurrentVersionId') !== current.id) {
      reject(409, 'bot_version_conflict');
      return true;
    }
    const publish = (hasImage) =>
      sendJson(response, 200, {
        version: append(
          { ...current.configuration, avatarObjectId: hasImage ? randomUUID() : null },
          user,
          hasImage ? 'Avatar updated' : 'Avatar removed',
        ),
      });
    if (request.method === 'DELETE') publish(false);
    else if (request.method === 'PUT') {
      request.resume();
      request.on('end', () => publish(true));
    } else reject(404, 'not_found');
    return true;
  }
  if (request.method === 'GET') {
    if (path === `${base}/versions`) {
      const before = Number(url.searchParams.get('before') ?? 2147483647),
        limit = Number(url.searchParams.get('limit') ?? 50);
      const eligible = [...versions].reverse().filter((version) => version.number < before);
      const selected = eligible
        .slice(0, limit)
        .map(({ configuration: _configuration, ...metadata }) => metadata);
      sendJson(response, 200, {
        currentVersionId: current.id,
        versions: selected,
        nextBefore: eligible.length > limit ? selected.at(-1).number : null,
      });
    } else if (path === `${base}/versions/compare`) {
      const from = versions.find((version) => version.id === url.searchParams.get('fromVersionId'));
      const to = versions.find((version) => version.id === url.searchParams.get('toVersionId'));
      if (!from || !to) reject(404, 'bot_version_not_found');
      else {
        const before = fields(from.configuration),
          after = fields(to.configuration);
        sendJson(response, 200, {
          fromVersionId: from.id,
          toVersionId: to.id,
          differences: Object.keys(before)
            .filter((field) => before[field] !== after[field])
            .map((field) => ({ field, before: before[field], after: after[field] })),
        });
      }
    } else {
      const selected = versions.find((version) => path === `${base}/versions/${version.id}`);
      if (selected) sendJson(response, 200, { version: selected });
      else reject(404, 'bot_version_not_found');
    }
    return true;
  }
  if (role !== 'owner' && role !== 'editor') {
    reject(403, 'bot_forbidden');
    return true;
  }
  const restore = path === `${base}/versions/restore` && request.method === 'POST';
  if (!restore && (path !== `${base}/configuration` || request.method !== 'PATCH')) {
    reject(404, 'not_found');
    return true;
  }
  readJson(request, (command) => {
    attempts.push({ method: request.method, command });
    if (command.expectedCurrentVersionId !== current.id) {
      reject(409, 'bot_version_conflict');
      return;
    }
    const source = restore
      ? versions.find((version) => version.id === command.sourceVersionId)
      : undefined;
    if (restore && !source) {
      reject(404, 'bot_version_not_found');
      return;
    }
    if (restore && source.configuration.avatarObjectId && missingAvatar) {
      reject(409, 'bot_avatar_unavailable');
      return;
    }
    const configuration = restore
      ? structuredClone(source.configuration)
      : {
          ...current.configuration,
          ...command.changes,
          limits: { ...current.configuration.limits, ...command.changes?.limits },
        };
    if (restore || command.changes?.modelBinding) {
      if (refuseNextModel) {
        refuseNextModel = false;
        disabledCurrent = true;
        reject(400, 'bot_model_unavailable', 'disabled');
        return;
      }
      const binding = configuration.modelBinding;
      const model = models().find(
        (model) =>
          binding.connectionId === model.id &&
          binding.modelId === model.modelId &&
          binding.scope.kind === 'workspace' &&
          binding.scope.id === workspaceId,
      );
      if (!model || !model.enabled) {
        reject(400, 'bot_model_unavailable', model ? 'disabled' : 'not-accessible');
        return;
      }
    }
    const unchanged =
      !restore &&
      JSON.stringify(fields(configuration)) === JSON.stringify(fields(current.configuration));
    const version = unchanged
      ? current
      : append(
          configuration,
          user,
          command.rationale?.trim() ||
            (restore ? `Restored version ${source.number}` : 'Configuration updated'),
        );
    if (failAfterCommit) {
      failAfterCommit = false;
      reject(503, 'bot_version_unavailable');
    } else sendJson(response, 200, { version });
  });
  return true;
}
