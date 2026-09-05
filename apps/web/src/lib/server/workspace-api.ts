import { SESSION_COOKIE_NAME } from './auth-api.js';

export interface Workspace {
  id: string;
  name: string;
  description: string;
  role: 'owner' | 'administrator' | 'member';
}
export type WorkspaceResult<T> =
  | { status: 'available'; value: T }
  | { status: 'anonymous' | 'not-found' | 'invalid' | 'unavailable' };

function parseWorkspace(value: unknown): Workspace | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'description,id,name,role' ||
    typeof record.id !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(record.id) ||
    typeof record.name !== 'string' ||
    typeof record.description !== 'string' ||
    !['owner', 'administrator', 'member'].includes(String(record.role))
  )
    return undefined;
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    role: record.role as Workspace['role'],
  };
}

export class WorkspaceApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}

  async list(token: string | undefined): Promise<WorkspaceResult<Workspace[]>> {
    const result = await this.send(token, '/api/v1/workspaces');
    if (result.status !== 'available') return result;
    const payload = result.value;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('workspaces' in payload) ||
      Object.keys(payload).length !== 1 ||
      !Array.isArray(payload.workspaces)
    )
      return { status: 'unavailable' };
    const workspaces = payload.workspaces.map(parseWorkspace);
    if (workspaces.some((workspace) => !workspace)) return { status: 'unavailable' };
    return { status: 'available', value: workspaces as Workspace[] };
  }

  async create(
    token: string | undefined,
    input: { name: string; description: string },
  ): Promise<WorkspaceResult<Workspace>> {
    return this.write(token, '/api/v1/workspaces', 'POST', input);
  }

  async update(
    token: string | undefined,
    workspaceId: string,
    input: { name: string; description: string },
  ): Promise<WorkspaceResult<Workspace>> {
    return this.write(
      token,
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      'PATCH',
      input,
    );
  }

  private async write(
    token: string | undefined,
    path: string,
    method: string,
    input: { name: string; description: string },
  ): Promise<WorkspaceResult<Workspace>> {
    const result = await this.send(token, path, {
      method,
      headers: { 'content-type': 'application/json', origin: new URL(this.webOrigin).origin },
      body: JSON.stringify(input),
    });
    if (result.status !== 'available') return result;
    const payload = result.value;
    const workspace =
      typeof payload === 'object' &&
      payload !== null &&
      'workspace' in payload &&
      Object.keys(payload).length === 1
        ? parseWorkspace(payload.workspace)
        : undefined;
    return workspace ? { status: 'available', value: workspace } : { status: 'unavailable' };
  }

  private async send(
    token: string | undefined,
    path: string,
    init: RequestInit = {},
  ): Promise<WorkspaceResult<unknown>> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return { status: 'anonymous' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.request(`${this.baseUrl.replace(/\/$/u, '')}${path}`, {
        ...init,
        headers: { ...init.headers, cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
        signal: controller.signal,
      });
      if (response.status === 401) return { status: 'anonymous' };
      if (response.status === 403 || response.status === 404) return { status: 'not-found' };
      if (response.status === 400) return { status: 'invalid' };
      if (!response.ok) return { status: 'unavailable' };
      return { status: 'available', value: (await response.json()) as unknown };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createWorkspaceApiClient(request: typeof globalThis.fetch): WorkspaceApiClient {
  return new WorkspaceApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
