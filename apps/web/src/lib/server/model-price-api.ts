export type ModelPriceView = {
  id: string;
  workspaceId: string;
  connectionId: string;
  modelId: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  createdAt: string;
};

export type ModelPriceResult<T> = { ok: true; value: T } | { ok: false; code: string };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function price(value: unknown): value is ModelPriceView {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.connectionId === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.inputMicrosPerMillion === 'number' &&
    typeof value.outputMicrosPerMillion === 'number' &&
    typeof value.createdAt === 'string'
  );
}

export class ModelPriceApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly apiBaseUrl: string,
    private readonly webOrigin: string,
  ) {}

  async list(
    token: string,
    workspaceId: string,
  ): Promise<ModelPriceResult<{ prices: ModelPriceView[] }>> {
    return this.send(token, workspaceId, 'GET');
  }

  async supersede(
    token: string,
    workspaceId: string,
    input: unknown,
  ): Promise<ModelPriceResult<{ price: ModelPriceView }>> {
    return this.send(token, workspaceId, 'PUT', input);
  }

  private async send(
    token: string,
    workspaceId: string,
    method: 'GET' | 'PUT',
    body?: unknown,
  ): Promise<ModelPriceResult<{ prices: ModelPriceView[] } & { price?: ModelPriceView }>> {
    const response = await this.request(
      `${this.apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/model-prices`,
      {
        method,
        headers: {
          cookie: `openbot_session=${token}`,
          origin: this.webOrigin,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (response.status === 401) return { ok: false, code: 'authentication_required' };
    if (response.status === 403) return { ok: false, code: 'workspace_forbidden' };
    if (response.status === 400) return { ok: false, code: 'invalid_model_price' };
    if (!response.ok) return { ok: false, code: 'model_price_unavailable' };
    const payload: unknown = await response.json();
    if (method === 'GET') {
      if (!record(payload) || !Array.isArray(payload.prices) || !payload.prices.every(price))
        return { ok: false, code: 'model_price_unavailable' };
      return { ok: true, value: { prices: payload.prices } };
    }
    if (!record(payload) || !price(payload.price))
      return { ok: false, code: 'model_price_unavailable' };
    return { ok: true, value: { prices: [payload.price], price: payload.price } };
  }
}

export function createModelPriceApiClient(request: typeof globalThis.fetch) {
  return new ModelPriceApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
