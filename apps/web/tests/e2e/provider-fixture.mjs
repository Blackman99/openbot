// Browser seam fixture; production network/persistence behavior is covered by
// provider-routes, provider-connections, and the real HTTP provider-probe tests.
const connections = new Map();
export function resetProviderFixture() {
  connections.clear();
}
const report = () => ({
  testedAt: '2030-01-02T00:00:00.000Z',
  text: { ok: true, code: 'passed', raw: 'data: OK' },
  action: { ok: true, code: 'passed', raw: '{"ok":true}' },
});

export function handleProviderFixture(
  request,
  response,
  { authenticated, readJson, sendJson, trustedOrigin },
) {
  const match = /^\/api\/v1\/model-connections(?:\/([^/]+))?(\/test)?$/u.exec(request.url ?? '');
  if (!match) return false;
  if (!authenticated) {
    sendJson(response, 401, { error: { code: 'authentication_required' } });
    return true;
  }
  if (request.method !== 'GET' && request.headers.origin !== trustedOrigin) {
    sendJson(response, 403, { error: { code: 'invalid_origin' } });
    return true;
  }
  const id = match[1];
  const existing = id ? connections.get(id) : undefined;
  if (id && !existing) {
    sendJson(response, 404, { error: { code: 'connection_not_found' } });
    return true;
  }
  if (request.method === 'GET') {
    sendJson(response, 200, id ? existing : [...connections.values()]);
  } else if (request.method === 'DELETE') {
    connections.delete(id);
    response.writeHead(204).end();
  } else if (request.method === 'PATCH') {
    existing.enabled = false;
    sendJson(response, 200, existing);
  } else if (match[2]) {
    existing.lastProbe = report();
    sendJson(response, 200, existing.lastProbe);
  } else {
    readJson(request, (input) => {
      const connectionId = id ?? `connection-${connections.size + 1}`;
      const metadata = {
        id: connectionId,
        name: input.name,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        enabled: true,
        apiKeyConfigured:
          input.apiKey === undefined ? existing?.apiKeyConfigured : Boolean(input.apiKey),
        headerNames:
          input.headers === undefined ? existing?.headerNames : Object.keys(input.headers),
        lastProbe: report(),
      };
      connections.set(connectionId, metadata);
      sendJson(response, id ? 200 : 201, metadata);
    });
  }
  return true;
}
