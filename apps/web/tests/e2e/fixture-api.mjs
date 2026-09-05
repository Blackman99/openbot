import { createServer } from 'node:http';
import { handleProviderFixture, resetProviderFixture } from './provider-fixture.mjs';

let scenario = 'ready';
let claimed = false;
let owner;
let password;
let nextToken = 1;
const sessions = new Set();
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
  resetProviderFixture();
  claimed = false;
  owner = undefined;
  password = undefined;
  nextToken = 1;
  sessions.clear();
  workspaces.clear();
}

function createSession() {
  const token = Buffer.alloc(32, nextToken++).toString('base64url');
  sessions.add(token);
  return token;
}

function readSession(request) {
  const cookie = request.headers.cookie ?? '';
  return /(?:^|;\s*)openbot_session=([A-Za-z0-9_-]{43})(?:;|$)/u.exec(cookie)?.[1];
}

function identity() {
  return {
    user: owner,
    workspace: { id: 'workspace-id', name: 'My Workspace' },
  };
}

const server = createServer((request, response) => {
  if (
    handleProviderFixture(request, response, {
      authenticated: sessions.has(readSession(request)),
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
      if (!owner || input.email.toLowerCase() !== owner.email || input.password !== password) {
        sendJson(response, 401, { error: { code: 'invalid_credentials' } });
        return;
      }
      const token = createSession();
      sendJson(response, 200, identity(), {
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
    sendJson(response, 200, identity());
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

  if (request.url?.startsWith('/api/v1/workspaces')) {
    const token = readSession(request);
    if (!token || !sessions.has(token)) {
      sendJson(response, 401, { error: { code: 'authentication_required' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/workspaces') {
      sendJson(response, 200, { workspaces: [...workspaces.values()] });
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
