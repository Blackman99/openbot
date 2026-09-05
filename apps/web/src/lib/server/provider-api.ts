export interface ProviderProbeResult {
  ok: boolean;
  code: string;
  raw: string;
}
export interface ProviderProbeReport {
  testedAt: string;
  text: ProviderProbeResult;
  action: ProviderProbeResult;
}
export interface PersonalConnection {
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  anthropicVersion?: string;
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  headerNames: string[];
  lastProbe: ProviderProbeReport;
}
export type ProviderResult<T> = { ok: true; value: T } | { ok: false; code: string };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}
function probeResult(value: unknown): value is ProviderProbeResult {
  return (
    record(value) &&
    keys(value, ['ok', 'code', 'raw']) &&
    typeof value.ok === 'boolean' &&
    typeof value.code === 'string' &&
    typeof value.raw === 'string'
  );
}
function probeReport(value: unknown): value is ProviderProbeReport {
  return (
    record(value) &&
    keys(value, ['testedAt', 'text', 'action']) &&
    typeof value.testedAt === 'string' &&
    Number.isFinite(Date.parse(value.testedAt)) &&
    probeResult(value.text) &&
    probeResult(value.action)
  );
}
function connection(value: unknown): value is PersonalConnection {
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
      ...(value.protocol === 'anthropic-messages' ? ['anthropicVersion'] : []),
    ]) &&
    (value.protocol === 'openai-chat' ||
      value.protocol === 'openai-responses' ||
      value.protocol === 'anthropic-messages') &&
    (value.protocol !== 'anthropic-messages' ||
      (typeof value.anthropicVersion === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/u.test(value.anthropicVersion))) &&
    ['id', 'name', 'baseUrl', 'modelId'].every((key) => typeof value[key] === 'string') &&
    typeof value.enabled === 'boolean' &&
    typeof value.apiKeyConfigured === 'boolean' &&
    Array.isArray(value.headerNames) &&
    value.headerNames.every((name) => typeof name === 'string') &&
    probeReport(value.lastProbe)
  );
}

const knownErrors = new Set([
  'authentication_required',
  'providers_not_configured',
  'invalid_connection',
  'provider_url_not_allowed',
  'connection_not_found',
  'connection_disabled',
  'connection_conflict',
  'provider_credentials_unavailable',
]);

export class ProviderApiClient {
  private readonly base: string;
  private readonly origin: string;
  constructor(
    private readonly request: typeof globalThis.fetch,
    apiBaseUrl: string,
    webOrigin: string,
  ) {
    this.base = `${apiBaseUrl.replace(/\/$/u, '')}/api/v1/model-connections`;
    this.origin = new URL(webOrigin).origin;
  }

  list(token: string): Promise<ProviderResult<PersonalConnection[]>> {
    return this.send(
      token,
      '',
      'GET',
      undefined,
      (value): value is PersonalConnection[] => Array.isArray(value) && value.every(connection),
    );
  }
  get(token: string, id: string): Promise<ProviderResult<PersonalConnection>> {
    return this.send(token, `/${encodeURIComponent(id)}`, 'GET', undefined, connection);
  }
  save(token: string, input: unknown): Promise<ProviderResult<PersonalConnection>> {
    return this.send(token, '', 'POST', input, connection);
  }
  update(token: string, id: string, input: unknown): Promise<ProviderResult<PersonalConnection>> {
    return this.send(token, `/${encodeURIComponent(id)}`, 'PUT', input, connection);
  }
  disable(token: string, id: string): Promise<ProviderResult<PersonalConnection>> {
    return this.send(token, `/${encodeURIComponent(id)}`, 'PATCH', { enabled: false }, connection);
  }
  test(token: string, id: string): Promise<ProviderResult<ProviderProbeReport>> {
    return this.send(token, `/${encodeURIComponent(id)}/test`, 'POST', undefined, probeReport);
  }
  delete(token: string, id: string): Promise<ProviderResult<undefined>> {
    return this.send(
      token,
      `/${encodeURIComponent(id)}`,
      'DELETE',
      undefined,
      (value): value is undefined => value === undefined,
    );
  }

  private async send<T>(
    token: string,
    path: string,
    method: string,
    input: unknown,
    valid: (value: unknown) => value is T,
  ): Promise<ProviderResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.request(`${this.base}${path}`, {
        method,
        headers: {
          cookie: `openbot_session=${encodeURIComponent(token)}`,
          origin: this.origin,
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: controller.signal,
      });
      const payload: unknown = response.status === 204 ? undefined : await response.json();
      if (!response.ok) {
        const code =
          record(payload) &&
          record(payload.error) &&
          typeof payload.error.code === 'string' &&
          knownErrors.has(payload.error.code)
            ? payload.error.code
            : 'provider_unavailable';
        return { ok: false, code };
      }
      return valid(payload)
        ? { ok: true, value: payload }
        : { ok: false, code: 'provider_unavailable' };
    } catch {
      return { ok: false, code: 'provider_unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createProviderApiClient(request: typeof globalThis.fetch): ProviderApiClient {
  return new ProviderApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
