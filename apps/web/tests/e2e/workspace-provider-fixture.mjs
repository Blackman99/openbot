// Browser seam fixture. API integration tests cover encryption, fresh authorization,
// provider transport, revision conflicts, and transactional audit persistence.
const connections = new Map();
export function resetWorkspaceProviderFixture() {
  connections.clear();
}
function report() {
  return {
    testedAt: '2030-01-02T00:00:00.000Z',
    text: { ok: true, code: 'passed', raw: 'data: OK' },
    action: { ok: true, code: 'passed', raw: '{"ok":true}' },
  };
}
function publicReport(value) {
  return {
    testedAt: value.testedAt,
    text: { ok: value.text.ok, code: value.text.code },
    action: { ok: value.action.ok, code: value.action.code },
  };
}
function view(metadata, canManage) {
  return {
    id: metadata.id,
    name: metadata.name,
    protocol: metadata.protocol,
    modelId: metadata.modelId,
    availability: metadata.enabled ? 'available' : 'unavailable',
    lastProbe: publicReport(metadata.lastProbe),
    ...(canManage ? { settings: metadata } : {}),
  };
}

export function handleWorkspaceProviderFixture(
  request,
  response,
  { user, memberships, readJson, sendJson, trustedOrigin },
) {
  const match = /^\/api\/v1\/workspaces\/([^/]+)\/model-connections(?:\/([^/]+))?(\/test)?$/u.exec(
    request.url ?? '',
  );
  if (!match) return false;
  const [, workspaceId, id, test] = match;
  const role = user && memberships.get(workspaceId)?.get(user.id);
  const failure = (status, code) => sendJson(response, status, { error: { code } });
  if (!user) {
    failure(401, 'authentication_required');
    return true;
  }
  if (!role) {
    failure(403, 'workspace_forbidden');
    return true;
  }
  if (request.method !== 'GET' && request.headers.origin !== trustedOrigin) {
    failure(403, 'invalid_origin');
    return true;
  }
  const canManage = role === 'owner' || role === 'administrator';
  if (request.method !== 'GET' && !test && !canManage) {
    failure(403, 'workspace_forbidden');
    return true;
  }
  const models = connections.get(workspaceId) ?? new Map();
  connections.set(workspaceId, models);
  const existing = models.get(id);
  if (id && !existing) {
    failure(404, 'connection_not_found');
    return true;
  }
  if (request.method === 'GET' && !test) {
    sendJson(
      response,
      200,
      id
        ? { canManage, connection: view(existing, canManage) }
        : { canManage, connections: [...models.values()].map((model) => view(model, canManage)) },
    );
  } else if (request.method === 'POST' && test) {
    if (!existing.enabled) failure(409, 'connection_disabled');
    else if (request.headers['content-type']) failure(400, 'invalid_connection');
    else {
      existing.lastProbe = report();
      sendJson(response, 200, { report: publicReport(existing.lastProbe) });
    }
  } else if (request.method === 'PATCH' && id && !test) {
    readJson(request, (input) => {
      if (input.enabled !== false) {
        failure(400, 'invalid_connection');
        return;
      }
      existing.enabled = false;
      sendJson(response, 200, { canManage, connection: view(existing, canManage) });
    });
  } else if (!test && ((request.method === 'POST' && !id) || (request.method === 'PUT' && id))) {
    readJson(request, (input) => {
      const protocol = input.protocol ?? existing?.protocol ?? 'openai-chat';
      const metadata = {
        id: id ?? `shared-${models.size + 1}`,
        name: input.name,
        protocol,
        ...(protocol === 'anthropic-messages'
          ? {
              anthropicVersion:
                input.anthropicVersion ?? existing?.anthropicVersion ?? '2023-06-01',
            }
          : {}),
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        enabled: true,
        apiKeyConfigured:
          input.apiKey === undefined ? existing?.apiKeyConfigured : Boolean(input.apiKey),
        headerNames:
          input.headers === undefined ? existing?.headerNames : Object.keys(input.headers),
        lastProbe: report(),
      };
      models.set(metadata.id, metadata);
      sendJson(response, id ? 200 : 201, { canManage, connection: view(metadata, canManage) });
    });
  } else response.writeHead(404).end();
  return true;
}
