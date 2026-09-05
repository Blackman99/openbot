// Browser-only state; real API and PostgreSQL tests prove authorization, audits and locking.
const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
const botId = 'bdcc0832-ce23-4d77-9c72-fb4e9d01766c';
const ada = {
  id: 'ab661304-a1bc-4767-9a87-c47de763f749',
  email: 'ada@example.com',
  displayName: 'Ada',
};
const grace = {
  id: 'bb661304-a1bc-4767-9a87-c47de763f749',
  email: 'grace@example.com',
  displayName: 'Grace',
};
const lin = {
  id: 'cb661304-a1bc-4767-9a87-c47de763f749',
  email: 'lin@example.com',
  displayName: 'Lin',
};
const people = [ada, grace, lin];
const time = '2030-01-02T00:00:00.000Z';
let active = false;
let visibility = 'private';
const acl = new Map();
let audits = [];
export function resetBotAclFixture() {
  active = false;
  visibility = 'private';
  acl.clear();
  audits = [];
}
export function handleBotAclFixture(request, response, context) {
  const { user, users, memberships, workspaces, createSession, readJson, sendJson, trustedOrigin } =
    context;
  const path = new URL(request.url ?? '/', 'http://fixture').pathname;
  const login = (account) =>
    sendJson(
      response,
      200,
      { workspaceId, botId },
      {
        'set-cookie': `openbot_session=${createSession(account)}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
      },
    );
  if (request.method === 'POST' && path === '/__bot-acl/setup') {
    resetBotAclFixture();
    active = true;
    for (const account of people)
      users.set(account.email, { user: account, password: 'fixture-bot-password' });
    workspaces.set(workspaceId, { id: workspaceId, name: 'Bot permissions lab', description: '' });
    memberships.set(
      workspaceId,
      new Map([
        [ada.id, 'owner'],
        [grace.id, 'administrator'],
      ]),
    );
    acl.set(ada.id, 'owner');
    acl.set(lin.id, 'owner');
    login(ada);
    return true;
  }
  if (!active) return false;
  if (request.method === 'POST' && path === '/__bot-acl/viewer') {
    login(grace);
    return true;
  }
  if (path === '/__bot-acl/state') {
    if (request.method === 'POST')
      readJson(request, (input) => {
        if (input.graceWorkspaceAccess === false) memberships.get(workspaceId).delete(grace.id);
        if (input.graceWorkspaceAccess === true)
          memberships.get(workspaceId).set(grace.id, 'administrator');
        sendJson(response, 200, { ok: true });
      });
    else sendJson(response, 200, { audits, acl: Object.fromEntries(acl), visibility, version: 1 });
    return true;
  }
  const base = `/api/v1/workspaces/${workspaceId}/bots`;
  const scoped = `${base}/${botId}`;
  const memberPath = `/api/v1/workspaces/${workspaceId}/members`;
  const modelPath = `/api/v1/workspaces/${workspaceId}/model-connections`;
  if (
    !path.startsWith(base) &&
    path !== memberPath &&
    path !== modelPath &&
    path !== '/api/v1/model-connections'
  )
    return false;
  const reject = (status, code) => sendJson(response, status, { error: { code } });
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
  if (path === modelPath) {
    sendJson(response, 200, { canManage: false, connections: [] });
    return true;
  }
  if (path === memberPath) {
    sendJson(response, 200, {
      members: people
        .filter((person) => memberships.get(workspaceId).has(person.id))
        .map((person) => ({
          user: person,
          role: memberships.get(workspaceId).get(person.id),
          joinedAt: time,
          invitation: null,
        })),
    });
    return true;
  }
  const accessRole = acl.get(user.id) ?? null;
  const summary = {
    id: botId,
    workspaceId,
    visibility,
    accessRole,
    name: 'Researcher',
    roleDescription: 'Research assistant',
    description: 'Evidence and context',
    bindingStatus: { state: 'ready', chatOnly: true },
  };
  if (request.method === 'GET' && path === base) {
    sendJson(response, 200, { bots: accessRole || visibility === 'workspace' ? [summary] : [] });
    return true;
  }
  if (request.method === 'GET' && path === scoped) {
    if (!accessRole && visibility === 'private') {
      reject(403, 'bot_forbidden');
      return true;
    }
    sendJson(response, 200, {
      bot: {
        ...summary,
        ...(accessRole
          ? {
              currentVersion: {
                id: 'ddcc0832-ce23-4d77-9c72-fb4e9d01766c',
                number: 1,
                author: { id: ada.id, displayName: ada.displayName },
                createdAt: time,
                rationale: 'Created',
                configuration: {
                  name: summary.name,
                  roleDescription: summary.roleDescription,
                  description: summary.description,
                  instructions: 'Private review instructions.',
                  modelBinding: {
                    scope: { kind: 'workspace', id: workspaceId },
                    connectionId: 'ce661304-a1bc-4767-9a87-c47de763f749',
                    modelId: 'basic-model',
                  },
                  limits: {
                    maxTotalTokens: 32768,
                    maxDurationSeconds: 300,
                    maxTurns: 8,
                    maxDelegationDepth: 2,
                  },
                },
              },
            }
          : {}),
      },
    });
    return true;
  }
  if (accessRole !== 'owner') {
    reject(403, 'bot_forbidden');
    return true;
  }
  const toMember = (id) => ({
    user: people.find((person) => person.id === id),
    role: acl.get(id),
    joinedAt: time,
    hasWorkspaceAccess: memberships.get(workspaceId).has(id),
  });
  if (request.method === 'GET' && path === `${scoped}/acl`) {
    sendJson(response, 200, { members: [...acl.keys()].map(toMember) });
    return true;
  }
  if (request.headers.origin !== trustedOrigin) {
    reject(403, 'invalid_origin');
    return true;
  }
  if (request.method === 'PATCH' && path === `${scoped}/visibility`) {
    readJson(request, (input) => {
      if (!['private', 'workspace'].includes(input.visibility)) {
        reject(400, 'invalid_bot_request');
        return;
      }
      if (visibility !== input.visibility) audits.push('bot.visibility_changed');
      visibility = input.visibility;
      sendJson(response, 200, { visibility });
    });
    return true;
  }
  if (request.method === 'POST' && path === `${scoped}/acl`) {
    readJson(request, (input) => {
      if (!memberships.get(workspaceId).has(input.userId)) {
        reject(404, 'bot_acl_member_not_found');
        return;
      }
      if (acl.has(input.userId)) {
        reject(409, 'bot_acl_conflict');
        return;
      }
      const role = input.role ?? 'user';
      if (!['owner', 'editor', 'user'].includes(role)) {
        reject(400, 'invalid_bot_request');
        return;
      }
      acl.set(input.userId, role);
      audits.push('bot.acl_granted');
      sendJson(response, 201, { member: toMember(input.userId) });
    });
    return true;
  }
  const target = path.startsWith(`${scoped}/acl/`)
    ? path.slice(`${scoped}/acl/`.length)
    : undefined;
  if (target && ['DELETE', 'PATCH'].includes(request.method)) {
    const change = (role) => {
      if (!acl.has(target)) {
        reject(404, 'bot_acl_member_not_found');
        return;
      }
      const rank = { user: 1, editor: 2, owner: 3 };
      if (role && !rank[role]) {
        reject(400, 'invalid_bot_request');
        return;
      }
      if (role && rank[role] > rank[acl.get(target)] && !memberships.get(workspaceId).has(target)) {
        reject(404, 'bot_acl_member_not_found');
        return;
      }
      const owners = [...acl].filter(
        ([id, role]) => role === 'owner' && memberships.get(workspaceId).has(id),
      );
      if (
        acl.get(target) === 'owner' &&
        role !== 'owner' &&
        memberships.get(workspaceId).has(target) &&
        owners.length === 1
      ) {
        reject(409, 'last_bot_owner_required');
        return;
      }
      if (role === null) {
        acl.delete(target);
        audits.push('bot.acl_revoked');
        response.writeHead(204).end();
      } else {
        if (role !== acl.get(target)) audits.push('bot.acl_role_changed');
        acl.set(target, role);
        sendJson(response, 200, { member: toMember(target) });
      }
    };
    if (request.method === 'DELETE') {
      if (request.headers['content-type']) reject(400, 'invalid_bot_request');
      else change(null);
    } else readJson(request, (input) => change(input.role));
    return true;
  }
  reject(403, 'bot_forbidden');
  return true;
}
