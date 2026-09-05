import type { PersonalConnection, ProviderResult } from './provider-api.js';

export interface PublicProbeReport {
  testedAt: string;
  text: { ok: boolean; code: string };
  action: { ok: boolean; code: string };
}
export interface SharedConnectionView {
  id: string;
  name: string;
  protocol: PersonalConnection['protocol'];
  modelId: string;
  availability: 'available' | 'unavailable';
  lastProbe: PublicProbeReport;
  settings?: PersonalConnection;
}
export interface WorkspaceConnections {
  canManage: boolean;
  connections: SharedConnectionView[];
}
export interface WorkspaceConnection {
  canManage: boolean;
  connection: SharedConnectionView;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}
function report(value: unknown, raw = false): value is PublicProbeReport {
  return (
    record(value) &&
    keys(value, ['testedAt', 'text', 'action']) &&
    typeof value.testedAt === 'string' &&
    Number.isFinite(Date.parse(value.testedAt)) &&
    [value.text, value.action].every(
      (result) =>
        record(result) &&
        keys(result, ['ok', 'code', ...(raw ? ['raw'] : [])]) &&
        typeof result.ok === 'boolean' &&
        typeof result.code === 'string' &&
        (!raw || typeof result.raw === 'string'),
    )
  );
}
function settings(value: unknown, shared: Record<string, unknown>): value is PersonalConnection {
  return (
    record(value) &&
    keys(value, [
      'id',
      'protocol',
      'name',
      'baseUrl',
      'modelId',
      'enabled',
      'apiKeyConfigured',
      'headerNames',
      'lastProbe',
      ...(shared.protocol === 'anthropic-messages' ? ['anthropicVersion'] : []),
    ]) &&
    ['id', 'protocol', 'name', 'modelId'].every((key) => value[key] === shared[key]) &&
    typeof value.baseUrl === 'string' &&
    value.enabled === (shared.availability === 'available') &&
    typeof value.apiKeyConfigured === 'boolean' &&
    Array.isArray(value.headerNames) &&
    value.headerNames.every((name) => typeof name === 'string') &&
    (shared.protocol !== 'anthropic-messages' ||
      (typeof value.anthropicVersion === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/u.test(value.anthropicVersion))) &&
    report(value.lastProbe, true)
  );
}
function connection(value: unknown, canManage: boolean): value is SharedConnectionView {
  return (
    record(value) &&
    keys(value, [
      'id',
      'name',
      'protocol',
      'modelId',
      'availability',
      'lastProbe',
      ...(canManage ? ['settings'] : []),
    ]) &&
    ['id', 'name', 'modelId'].every((key) => typeof value[key] === 'string') &&
    ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(String(value.protocol)) &&
    (value.availability === 'available' || value.availability === 'unavailable') &&
    report(value.lastProbe) &&
    (!canManage || settings(value.settings, value))
  );
}
function list(value: unknown): value is WorkspaceConnections {
  return (
    record(value) &&
    keys(value, ['canManage', 'connections']) &&
    typeof value.canManage === 'boolean' &&
    Array.isArray(value.connections) &&
    value.connections.every((item) => connection(item, value.canManage as boolean)) &&
    new Set(value.connections.map(({ id }) => id)).size === value.connections.length
  );
}
function detail(value: unknown): value is WorkspaceConnection {
  return (
    record(value) &&
    keys(value, ['canManage', 'connection']) &&
    typeof value.canManage === 'boolean' &&
    connection(value.connection, value.canManage)
  );
}
function probe(value: unknown): value is { report: PublicProbeReport } {
  return record(value) && keys(value, ['report']) && report(value.report);
}
const errorStatuses: Record<string, number> = {
  authentication_required: 401,
  workspace_forbidden: 403,
  invalid_origin: 403,
  connection_not_found: 404,
  connection_disabled: 409,
  connection_conflict: 409,
  invalid_connection: 400,
  provider_url_not_allowed: 400,
  providers_not_configured: 503,
  provider_operation_failed: 503,
  provider_credentials_unavailable: 503,
};

export class WorkspaceProviderApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly apiBaseUrl: string,
    private readonly webOrigin: string,
  ) {}
  list(token: string, workspaceId: string): Promise<ProviderResult<WorkspaceConnections>> {
    return this.send(token, workspaceId, '', 'GET', undefined, list);
  }
  get(
    token: string,
    workspaceId: string,
    id: string,
  ): Promise<ProviderResult<WorkspaceConnection>> {
    return this.send(
      token,
      workspaceId,
      `/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      (value): value is WorkspaceConnection => detail(value) && value.connection.id === id,
    );
  }
  save(
    token: string,
    workspaceId: string,
    input: unknown,
  ): Promise<ProviderResult<WorkspaceConnection>> {
    return this.send(token, workspaceId, '', 'POST', input, detail);
  }
  update(
    token: string,
    workspaceId: string,
    id: string,
    input: unknown,
  ): Promise<ProviderResult<WorkspaceConnection>> {
    return this.send(
      token,
      workspaceId,
      `/${encodeURIComponent(id)}`,
      'PUT',
      input,
      (value): value is WorkspaceConnection => detail(value) && value.connection.id === id,
    );
  }
  disable(
    token: string,
    workspaceId: string,
    id: string,
  ): Promise<ProviderResult<WorkspaceConnection>> {
    return this.send(
      token,
      workspaceId,
      `/${encodeURIComponent(id)}`,
      'PATCH',
      { enabled: false },
      (value): value is WorkspaceConnection => detail(value) && value.connection.id === id,
    );
  }
  test(
    token: string,
    workspaceId: string,
    id: string,
  ): Promise<ProviderResult<{ report: PublicProbeReport }>> {
    return this.send(
      token,
      workspaceId,
      `/${encodeURIComponent(id)}/test`,
      'POST',
      undefined,
      probe,
    );
  }

  private async send<T>(
    token: string,
    workspaceId: string,
    path: string,
    method: string,
    input: unknown,
    valid: (value: unknown) => value is T,
  ): Promise<ProviderResult<T>> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return { ok: false, code: 'authentication_required' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request(
        `${this.apiBaseUrl.replace(/\/$/u, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/model-connections${path}`,
        {
          method,
          headers: {
            cookie: `openbot_session=${encodeURIComponent(token)}`,
            origin: new URL(this.webOrigin).origin,
            ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          signal: controller.signal,
        },
      );
      if (response.status === 401) return { ok: false, code: 'authentication_required' };
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code =
          record(payload) &&
          record(payload.error) &&
          typeof payload.error.code === 'string' &&
          errorStatuses[payload.error.code] === response.status
            ? payload.error.code
            : 'provider_unavailable';
        return { ok: false, code };
      }
      return response.ok && valid(payload)
        ? { ok: true, value: payload }
        : { ok: false, code: 'provider_unavailable' };
    } catch {
      return { ok: false, code: 'provider_unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createWorkspaceProviderApiClient(
  request: typeof globalThis.fetch,
): WorkspaceProviderApiClient {
  return new WorkspaceProviderApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
