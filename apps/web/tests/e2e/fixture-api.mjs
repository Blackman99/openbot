import { handleBotFixture, resetBotFixture } from './bot-fixture.mjs';
import { handleBotAclFixture, resetBotAclFixture } from './bot-acl-fixture.mjs';
import { handleApiTokenFixture, resetApiTokenFixture } from './api-token-fixture.mjs';
import { createServer } from 'node:http';
import { handleGroupFixture, resetGroupFixture } from './group-fixture.mjs';
import { handleCapabilityFixture, resetCapabilityFixture } from './capability-fixture.mjs';
import { handleProviderFixture, resetProviderFixture } from './provider-fixture.mjs';
import {
  handleWorkspaceProviderFixture,
  resetWorkspaceProviderFixture,
} from './workspace-provider-fixture.mjs';
import {
  handleMemberFixture,
  recordFixtureInvitation,
  recordFixtureMembership,
  resetMemberFixture,
} from './member-fixture.mjs';

let scenario = 'ready';
let claimed = false;
let owner;
let password;
let nextToken = 1;
const sessions = new Map();
const users = new Map();
const memberships = new Map();
const invitations = new Map();
const workspaces = new Map();
const trustedOrigin = 'http://127.0.0.1:4173';

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

function readJson(request, callback) {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => callback(JSON.parse(body)));
}

function resetAuth() {
  resetBotAclFixture();
  resetBotFixture();
  resetGroupFixture();
  resetApiTokenFixture();
  resetCapabilityFixture();
  resetProviderFixture();
  resetWorkspaceProviderFixture();
  resetMemberFixture();
  claimed = false;
  owner = undefined;
  password = undefined;
  nextToken = 1;
  sessions.clear();
  workspaces.clear();
  users.clear();
  memberships.clear();
  invitations.clear();
}

function createSession(user = owner) {
  const token = Buffer.alloc(32, nextToken++).toString('base64url');
  sessions.set(token, user);
  return token;
}

function readSession(request) {
  const cookie = request.headers.cookie ?? '';
  return /(?:^|;\s*)openbot_session=([A-Za-z0-9_-]{43})(?:;|$)/u.exec(cookie)?.[1];
}

function userWorkspaces(user) {
  return [...workspaces.values()]
    .filter((workspace) => memberships.get(workspace.id)?.has(user.id))
    .map((workspace) => ({ ...workspace, role: memberships.get(workspace.id).get(user.id) }));
}
function identity(user = owner, workspace = userWorkspaces(user)[0]) {
  return { user, workspace: workspace ? { id: workspace.id, name: workspace.name } : null };
}

const server = createServer((request, response) => {
  if (
    handleBotAclFixture(request, response, {
      user: sessions.get(readSession(request)),
      users,
      memberships,
      workspaces,
      createSession,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleBotFixture(request, response, {
      user: sessions.get(readSession(request)),
      users,
      memberships,
      workspaces,
      createSession,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleCapabilityFixture(request, response, {
      user: sessions.get(readSession(request)),
      memberships,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleApiTokenFixture(request, response, {
      user: sessions.get(readSession(request)),
      memberships,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleWorkspaceProviderFixture(request, response, {
      user: sessions.get(readSession(request)),
      memberships,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleProviderFixture(request, response, {
      authenticated: sessions.has(readSession(request)),
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleMemberFixture(request, response, {
      user: sessions.get(readSession(request)),
      users,
      memberships,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (
    handleGroupFixture(request, response, {
      user: sessions.get(readSession(request)),
      users,
      memberships,
      readJson,
      sendJson,
      trustedOrigin,
    })
  )
    return;
  if (request.method === 'POST' && request.url === '/__scenario') {
    readJson(request, ({ scenario: requestedScenario }) => {
      scenario = requestedScenario === 'unavailable' ? 'unavailable' : 'ready';
      if (requestedScenario === 'unclaimed') {
        resetAuth();
      }
      response.writeHead(204).end();
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/status') {
    const unavailable = scenario === 'unavailable';
    const payload = unavailable
      ? {
          schemaVersion: 1,
          status: 'unavailable',
          checks: { database: 'unavailable', migrations: 'unknown' },
        }
      : {
          schemaVersion: 1,
          status: 'ready',
          checks: { database: 'ready', migrations: 'current' },
        };

    sendJson(response, unavailable ? 503 : 200, payload);
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/oidc') {
    sendJson(response, 200, { enabled: false });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/auth/state') {
    sendJson(response, 200, { claimed });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/setup') {
    if (request.headers.origin !== trustedOrigin) {
      sendJson(response, 403, { error: { code: 'invalid_origin' } });
      return;
    }
    if (request.headers['x-openbot-setup-token'] !== 'local-only-openbot-setup-token-change-me') {
      sendJson(response, 403, { error: { code: 'invalid_setup_token' } });
      return;
    }
    if (claimed) {
      sendJson(response, 409, { error: { code: 'instance_already_claimed' } });
      return;
    }
    readJson(request, (input) => {
      claimed = true;
      owner = {
        displayName: input.displayName,
        email: input.email.toLowerCase(),
        id: 'user-id',
      };
      password = input.password;
      users.set(owner.email, { user: owner, password });
      memberships.set('workspace-id', new Map([[owner.id, 'owner']]));
      recordFixtureMembership('workspace-id', owner.id);
      workspaces.set('workspace-id', {
        id: 'workspace-id',
        name: 'My Workspace',
        description: '',
        role: 'owner',
      });
      const token = createSession();
      sendJson(response, 201, identity(), {
        'set-cookie': `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
      });
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/session') {
    if (request.headers.origin !== trustedOrigin) {
      sendJson(response, 403, { error: { code: 'invalid_origin' } });
      return;
    }
    readJson(request, (input) => {
      const account = users.get(input.email.toLowerCase());
      if (!account || input.password !== account.password) {
        sendJson(response, 401, { error: { code: 'invalid_credentials' } });
        return;
      }
      const token = createSession(account.user);
      sendJson(response, 200, identity(account.user), {
        'set-cookie': `openbot_session=${token}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
      });
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/v1/me') {
    const token = readSession(request);
    if (!token || !sessions.has(token)) {
      sendJson(response, 401, { error: { code: 'authentication_required' } });
      return;
    }
    sendJson(response, 200, identity(sessions.get(token)));
    return;
  }

  if (request.method === 'DELETE' && request.url === '/api/v1/session') {
    if (request.headers.origin !== trustedOrigin) {
      sendJson(response, 403, { error: { code: 'invalid_origin' } });
      return;
    }
    const token = readSession(request);
    if (!token || !sessions.delete(token)) {
      sendJson(response, 401, { error: { code: 'authentication_required' } });
      return;
    }
    response.writeHead(204, {
      'set-cookie':
        'openbot_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/invitations/accept') {
    if (request.headers.origin !== trustedOrigin) {
      sendJson(response, 403, { error: { code: 'invalid_origin' } });
      return;
    }
    readJson(request, (input) => {
      const record = invitations.get(input.token);
      const session = readSession(request);
      let user = session ? sessions.get(session) : undefined;
      const unavailable = () =>
        sendJson(response, 409, { error: { code: 'invitation_unavailable' } });
      if (session && !user) {
        sendJson(response, 401, { error: { code: 'authentication_required' } });
        return;
      }
      if (
        !record ||
        record.revokedAt ||
        record.consumedAt ||
        Date.parse(record.expiresAt) <= Date.now() ||
        (user ? user.email : input.email?.toLowerCase()) !== record.email
      ) {
        unavailable();
        return;
      }
      let newUser = false;
      if (!user) {
        if (users.has(input.email.toLowerCase())) {
          unavailable();
          return;
        }
        if (
          !input.displayName ||
          typeof input.password !== 'string' ||
          input.password.length < 12
        ) {
          sendJson(response, 400, { error: { code: 'invalid_request' } });
          return;
        }
        user = {
          id: `user-${users.size + 1}`,
          email: input.email.toLowerCase(),
          displayName: input.displayName,
        };
        users.set(user.email, { user, password: input.password });
        newUser = true;
      }
      if (memberships.get(record.workspaceId).has(user.id)) {
        unavailable();
        return;
      }
      memberships.get(record.workspaceId).set(user.id, record.role);
      recordFixtureMembership(record.workspaceId, user.id, record.id);
      record.consumedAt = new Date().toISOString();
      const headers = newUser
        ? {
            'set-cookie': `openbot_session=${createSession(user)}; Path=/; Expires=Fri, 01 Feb 2030 00:00:00 GMT; HttpOnly; SameSite=Lax`,
          }
        : {};
      sendJson(
        response,
        newUser ? 201 : 200,
        identity(user, workspaces.get(record.workspaceId)),
        headers,
      );
    });
    return;
  }
  const invitationRoute = /^\/api\/v1\/workspaces\/([^/]+)\/invitations(?:\/([^/]+))?$/u.exec(
    request.url ?? '',
  );
  if (invitationRoute) {
    const session = readSession(request);
    const user = sessions.get(session);
    if (!user) {
      sendJson(response, 401, { error: { code: 'authentication_required' } });
      return;
    }
    const [, workspaceId, invitationId] = invitationRoute;
    const role = memberships.get(workspaceId)?.get(user.id);
    if (!role || role === 'member') {
      sendJson(response, 403, { error: { code: 'invitation_forbidden' } });
      return;
    }
    if (request.method === 'GET') {
      sendJson(response, 200, {
        invitations: [...invitations.values()].filter((value) => value.workspaceId === workspaceId),
      });
      return;
    }
    if (request.headers.origin !== trustedOrigin) {
      sendJson(response, 403, { error: { code: 'invalid_origin' } });
      return;
    }
    if (request.method === 'POST') {
      readJson(request, (input) => {
        const token = Buffer.alloc(32, 100 + invitations.size).toString('base64url');
        const invitation = {
          id: `invitation-${invitations.size + 1}`,
          workspaceId,
          email: input.email.toLowerCase(),
          role: input.role,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + input.expiresInDays * 86400000).toISOString(),
          revokedAt: null,
          consumedAt: null,
        };
        invitations.set(token, invitation);
        recordFixtureInvitation(invitation.id, user);
        sendJson(response, 201, { invitation, token });
      });
      return;
    }
    if (request.method === 'DELETE') {
      const record = [...invitations.values()].find(
        (value) => value.id === invitationId && value.workspaceId === workspaceId,
      );
      if (!record || record.revokedAt || record.consumedAt) {
        sendJson(response, 409, { error: { code: 'invitation_unavailable' } });
        return;
      }
      record.revokedAt = new Date().toISOString();
      response.writeHead(204).end();
      return;
    }
  }
  if (request.url?.startsWith('/api/v1/workspaces')) {
    const token = readSession(request);
    if (!token || !sessions.has(token)) {
      sendJson(response, 401, { error: { code: 'authentication_required' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/workspaces') {
      sendJson(response, 200, { workspaces: userWorkspaces(sessions.get(token)) });
      return;
    }
    if (request.method === 'GET') {
      const id = request.url.split('/').at(-1);
      const role = memberships.get(id)?.get(sessions.get(token).id);
      if (!role) sendJson(response, 403, { error: { code: 'workspace_forbidden' } });
      else sendJson(response, 200, { workspace: { ...workspaces.get(id), role } });
      return;
    }
    if (request.headers.origin !== trustedOrigin) {
      sendJson(response, 403, { error: { code: 'invalid_origin' } });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/workspaces') {
      readJson(request, ({ name, description }) => {
        const id = `workspace-${workspaces.size + 1}`;
        const workspace = { id, name, description, role: 'owner' };
        workspaces.set(id, workspace);
        memberships.set(id, new Map([[sessions.get(token).id, 'owner']]));
        recordFixtureMembership(id, sessions.get(token).id);
        sendJson(response, 201, { workspace });
      });
      return;
    }
    if (request.method === 'PATCH') {
      const id = request.url.split('/').at(-1);
      const workspace = workspaces.get(id);
      if (!workspace) {
        sendJson(response, 404, { error: { code: 'workspace_not_found' } });
        return;
      }
      readJson(request, ({ name, description }) => {
        Object.assign(workspace, { name, description });
        sendJson(response, 200, { workspace });
      });
      return;
    }
  }

  response.writeHead(404).end();
});

server.listen(4399, '127.0.0.1');

const close = () => server.close();
process.once('SIGINT', close);
process.once('SIGTERM', close);
