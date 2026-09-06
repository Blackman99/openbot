import type {
  CapabilityCatalog,
  RequiredCapability,
  ResolutionPreview,
} from '../capability-types.js';
import type { ProviderResult } from './provider-api.js';
import { catalog, preview, record } from './capability-contract.js';
const errorStatuses: Record<string, number> = {
  authentication_required: 401,
  workspace_forbidden: 403,
  invalid_origin: 403,
  connection_not_found: 404,
  connection_disabled: 409,
  connection_conflict: 409,
  invalid_capability_policy: 400,
  duplicate_fallback: 400,
  fallback_cycle: 400,
  fallback_unavailable: 400,
  fallback_capability_required: 400,
  invalid_connection: 400,
  provider_url_not_allowed: 400,
  providers_not_configured: 503,
  provider_operation_failed: 503,
  provider_credentials_unavailable: 503,
};
export class CapabilityApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly apiBaseUrl: string,
    private readonly webOrigin: string,
  ) {}
  get(token: string, id: string, workspaceId?: string): Promise<ProviderResult<CapabilityCatalog>> {
    return this.send(
      token,
      id,
      workspaceId,
      '/policy',
      'GET',
      undefined,
      (value): value is CapabilityCatalog => catalog(value) && value.id === id.toLowerCase(),
    );
  }
  override(
    token: string,
    id: string,
    input: unknown,
    workspaceId?: string,
  ): Promise<ProviderResult<CapabilityCatalog>> {
    return this.send(
      token,
      id,
      workspaceId,
      '/overrides',
      'POST',
      input,
      (value): value is CapabilityCatalog => catalog(value) && value.id === id.toLowerCase(),
    );
  }
  fallbacks(
    token: string,
    id: string,
    input: unknown,
    workspaceId?: string,
  ): Promise<ProviderResult<CapabilityCatalog>> {
    return this.send(
      token,
      id,
      workspaceId,
      '/fallbacks',
      'PUT',
      input,
      (value): value is CapabilityCatalog => catalog(value) && value.id === id.toLowerCase(),
    );
  }
  reprobe(
    token: string,
    id: string,
    expectedRevision: number,
    workspaceId?: string,
  ): Promise<ProviderResult<CapabilityCatalog>> {
    return this.send(
      token,
      id,
      workspaceId,
      '/reprobe',
      'POST',
      { expectedRevision },
      (value): value is CapabilityCatalog => catalog(value) && value.id === id.toLowerCase(),
    );
  }
  preview(
    token: string,
    id: string,
    requiredCapability: RequiredCapability,
    workspaceId?: string,
  ): Promise<ProviderResult<ResolutionPreview>> {
    return this.send(
      token,
      id,
      workspaceId,
      `/resolution-preview?capability=${encodeURIComponent(requiredCapability)}`,
      'GET',
      undefined,
      (value): value is ResolutionPreview =>
        preview(value) &&
        value.primaryId === id.toLowerCase() &&
        value.requiredCapability === requiredCapability,
    );
  }
  private async send<T>(
    token: string,
    id: string,
    workspaceId: string | undefined,
    path: string,
    method: string,
    input: unknown,
    valid: (value: unknown) => value is T,
  ): Promise<ProviderResult<T>> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return { ok: false, code: 'authentication_required' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const scope =
        workspaceId === undefined ? '' : `/workspaces/${encodeURIComponent(workspaceId)}`;
      const response = await this.request(
        `${this.apiBaseUrl.replace(/\/$/u, '')}/api/v1${scope}/model-connections/${encodeURIComponent(id)}${path}`,
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
export function createCapabilityApiClient(request: typeof fetch): CapabilityApiClient {
  return new CapabilityApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
