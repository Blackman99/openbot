import { SESSION_COOKIE_NAME } from './auth-api.js';

export const TEAM_TEMPLATE_SCHEMA_VERSION = 'openbot.team-template.v1';

const FORBIDDEN_FIELDS = new Set([
  'apikey',
  'attachment',
  'attachmentbody',
  'connectionid',
  'email',
  'filebody',
  'headers',
  'history',
  'members',
  'memories',
  'memory',
  'secret',
  'sourcebotid',
  'sourcegroupid',
  'sourceworkspaceid',
  'userid',
  'users',
]);

export type TeamTemplateResult<T> =
  | { status: 'available'; value: T }
  | { status: 'anonymous' }
  | { status: 'forbidden' }
  | { status: 'invalid'; fields?: Array<{ field: string; code: string }> }
  | { status: 'unavailable' };

export interface TeamTemplatePreview {
  template: Record<string, unknown>;
  objects: Array<Record<string, unknown> & { kind: string }>;
  mappings: Array<{ botKey: string; requiredCapability: string; bound: boolean }>;
  acknowledgements: Array<{ id: string; required: true; accepted: boolean }>;
  unresolved: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function forbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbidden);
  if (!object(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => FORBIDDEN_FIELDS.has(key.toLowerCase()) || forbidden(nested),
  );
}

export function parseTeamTemplate(value: unknown): Record<string, unknown> | undefined {
  if (forbidden(value) || !object(value)) return undefined;
  if (
    value.schemaVersion !== TEAM_TEMPLATE_SCHEMA_VERSION &&
    value.schemaVersion !== 'openbot.team-template.v1.routines'
  )
    return undefined;
  if (!object(value.identity) || typeof value.identity.name !== 'string') return undefined;
  if (!Array.isArray(value.bots) || value.bots.length === 0) return undefined;
  return value;
}

export function parseTeamTemplatePreview(value: unknown): TeamTemplatePreview | undefined {
  if (
    !object(value) ||
    !Array.isArray(value.objects) ||
    !Array.isArray(value.mappings) ||
    !Array.isArray(value.acknowledgements) ||
    typeof value.unresolved !== 'boolean'
  )
    return undefined;
  const template = parseTeamTemplate(value.template);
  if (!template) return undefined;
  return {
    template,
    objects: value.objects.filter(object).map((row) => ({
      ...row,
      kind: String(row.kind),
    })),
    mappings: value.mappings.flatMap((row) => {
      if (
        !object(row) ||
        typeof row.botKey !== 'string' ||
        typeof row.requiredCapability !== 'string' ||
        typeof row.bound !== 'boolean'
      )
        return [];
      return [
        {
          botKey: row.botKey,
          requiredCapability: row.requiredCapability,
          bound: row.bound,
        },
      ];
    }),
    acknowledgements: value.acknowledgements.flatMap((row) => {
      if (!object(row) || typeof row.id !== 'string' || row.required !== true) return [];
      return [{ id: row.id, required: true as const, accepted: row.accepted === true }];
    }),
    unresolved: value.unresolved,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function result<T>(
  status: number,
  body: unknown,
  read: (value: unknown) => T | undefined,
): TeamTemplateResult<T> {
  if (status === 401) return { status: 'anonymous' };
  if (status === 403) return { status: 'forbidden' };
  if (status === 400) {
    const error =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { fields?: Array<{ field: string; code: string }> } }).error
        : undefined;
    return { status: 'invalid', ...(error?.fields ? { fields: error.fields } : {}) };
  }
  if (status >= 200 && status < 300) {
    const value = read(body);
    if (value !== undefined) return { status: 'available', value };
  }
  return { status: 'unavailable' };
}

export class TeamTemplateApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/u, '')}/api/v1${path}`;
  }

  private headers(session: string, body?: unknown): HeadersInit {
    return {
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
      origin: new URL(this.webOrigin).origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
  }

  async export(
    session: string,
    workspaceId: string,
    groupId: string,
  ): Promise<TeamTemplateResult<Record<string, unknown>>> {
    const response = await this.request(
      this.url(`/workspaces/${workspaceId}/groups/${groupId}/template`),
      { headers: this.headers(session) },
    );
    const body = await readJson(response);
    return result(response.status, body, (value) => {
      if (!object(value) || !('template' in value)) return undefined;
      return parseTeamTemplate(value.template);
    });
  }

  async preview(
    session: string,
    workspaceId: string,
    payload: {
      template: unknown;
      modelBindings?: Record<string, unknown>;
      acknowledgements?: string[];
    },
  ): Promise<TeamTemplateResult<TeamTemplatePreview>> {
    const response = await this.request(
      this.url(`/workspaces/${workspaceId}/team-templates/previews`),
      {
        method: 'POST',
        headers: this.headers(session, payload),
        body: JSON.stringify(payload),
      },
    );
    const body = await readJson(response);
    return result(response.status, body, (value) => {
      if (!object(value) || !('preview' in value)) return undefined;
      return parseTeamTemplatePreview(value.preview);
    });
  }

  async import(
    session: string,
    workspaceId: string,
    payload: {
      template: unknown;
      modelBindings: Record<string, unknown>;
      acknowledgements: string[];
    },
  ): Promise<TeamTemplateResult<{ id: string; workspaceId: string }>> {
    if (!parseTeamTemplate(payload.template)) return { status: 'invalid' };
    const response = await this.request(this.url(`/workspaces/${workspaceId}/team-templates`), {
      method: 'POST',
      headers: this.headers(session, payload),
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    return result(response.status, body, (value) => {
      if (!object(value) || !object(value.group) || typeof value.group.id !== 'string')
        return undefined;
      if (typeof value.group.workspaceId !== 'string') return undefined;
      return { id: value.group.id, workspaceId: value.group.workspaceId };
    });
  }
}

export function createTeamTemplateApiClient(fetchFn: typeof fetch) {
  return new TeamTemplateApiClient(
    fetchFn,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
