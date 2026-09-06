import { SESSION_COOKIE_NAME } from './auth-api.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type RoutineStatus = 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';
export type RoutineRoutingPolicy = 'lead' | 'group';

export interface Routine {
  id: string;
  workspaceId: string;
  groupId: string;
  ownerUserId: string;
  prompt: string;
  routingPolicy: RoutineRoutingPolicy;
  leadGrantId: string | null;
  timeZone: string;
  executeAt: string;
  expiresAt: string;
  maxCostMicros: number;
  kind: 'one_time';
  status: RoutineStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string | null;
  conversationId?: string | null;
}

export interface CreateRoutineInput {
  prompt: string;
  timeZone: string;
  executeAt: string;
  expiresAt: string;
  maxCostMicros: number;
  leadGrantId?: string;
}

export interface EditRoutineInput {
  prompt?: string;
  timeZone?: string;
  executeAt?: string;
  expiresAt?: string;
  maxCostMicros?: number;
  leadGrantId?: string | null;
}

export type RoutineResult<T> =
  | { status: 'available'; value: T }
  | {
      status: 'anonymous' | 'forbidden' | 'invalid' | 'conflict' | 'unavailable';
      code?: string;
    };

function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}

export function isRoutineUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseRoutine(value: unknown, workspaceId: string, groupId: string): Routine | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const required = [
    'createdAt',
    'executeAt',
    'expiresAt',
    'groupId',
    'id',
    'kind',
    'leadGrantId',
    'maxCostMicros',
    'ownerUserId',
    'prompt',
    'routingPolicy',
    'status',
    'timeZone',
    'updatedAt',
    'workspaceId',
  ];
  const optional = ['conversationId', 'taskId'];
  const present = Object.keys(row).sort();
  if (present.some((key) => !required.includes(key) && !optional.includes(key))) return undefined;
  if (required.some((key) => !(key in row))) return undefined;
  if (
    typeof row.id !== 'string' ||
    !UUID_RE.test(row.id) ||
    row.workspaceId !== workspaceId.toLowerCase() ||
    row.groupId !== groupId.toLowerCase() ||
    typeof row.ownerUserId !== 'string' ||
    !UUID_RE.test(row.ownerUserId) ||
    typeof row.prompt !== 'string' ||
    !row.prompt.trim() ||
    (row.routingPolicy !== 'lead' && row.routingPolicy !== 'group') ||
    (row.leadGrantId !== null &&
      (typeof row.leadGrantId !== 'string' || !UUID_RE.test(row.leadGrantId))) ||
    typeof row.timeZone !== 'string' ||
    !row.timeZone ||
    !isDate(row.executeAt) ||
    !isDate(row.expiresAt) ||
    typeof row.maxCostMicros !== 'number' ||
    !Number.isInteger(row.maxCostMicros) ||
    row.maxCostMicros <= 0 ||
    row.kind !== 'one_time' ||
    !['active', 'paused', 'cancelled', 'completed', 'expired'].includes(String(row.status)) ||
    !isDate(row.createdAt) ||
    !isDate(row.updatedAt)
  )
    return undefined;
  const routine: Routine = {
    id: row.id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    groupId: groupId.toLowerCase(),
    ownerUserId: String(row.ownerUserId).toLowerCase(),
    prompt: row.prompt,
    routingPolicy: row.routingPolicy as RoutineRoutingPolicy,
    leadGrantId: row.leadGrantId === null ? null : String(row.leadGrantId).toLowerCase(),
    timeZone: row.timeZone,
    executeAt: new Date(row.executeAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    maxCostMicros: row.maxCostMicros,
    kind: 'one_time',
    status: row.status as RoutineStatus,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if ('taskId' in row) {
    if (row.taskId !== null && (typeof row.taskId !== 'string' || !UUID_RE.test(row.taskId)))
      return undefined;
    if (
      row.conversationId !== null &&
      row.conversationId !== undefined &&
      (typeof row.conversationId !== 'string' || !UUID_RE.test(row.conversationId))
    )
      return undefined;
    routine.taskId = row.taskId === null ? null : String(row.taskId).toLowerCase();
    routine.conversationId =
      row.conversationId === null || row.conversationId === undefined
        ? null
        : String(row.conversationId).toLowerCase();
  }
  return routine;
}

export class RoutineApiClient {
  constructor(
    private readonly request: typeof globalThis.fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
  ) {}

  private path(workspaceId: string, groupId: string, routineId?: string, suffix = '') {
    const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId.toLowerCase())}/groups/${encodeURIComponent(groupId.toLowerCase())}/routines`;
    return routineId
      ? `${base}/${encodeURIComponent(routineId.toLowerCase())}${suffix}`
      : `${base}${suffix}`;
  }

  private async send(
    session: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    mutate = false,
  ): Promise<{ status: number; payload: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (session) headers.cookie = `${SESSION_COOKIE_NAME}=${session}`;
    if (mutate) headers.origin = this.webOrigin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.request(new URL(path, this.baseUrl), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  private mapError(status: number, payload: unknown): RoutineResult<never> {
    if (status === 401) return { status: 'anonymous' };
    if (status === 403) return { status: 'forbidden' };
    if (status === 400) return { status: 'invalid' };
    if (status === 409) {
      const code =
        keys(payload, 'error') &&
        keys((payload as { error: unknown }).error, 'code') &&
        typeof (payload as { error: { code: unknown } }).error.code === 'string'
          ? (payload as { error: { code: string } }).error.code
          : undefined;
      return { status: 'conflict', code };
    }
    return { status: 'unavailable' };
  }

  async list(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
  ): Promise<RoutineResult<Routine[]>> {
    if (!isRoutineUuid(workspaceId) || !isRoutineUuid(groupId)) return { status: 'invalid' };
    const { status, payload } = await this.send(session, 'GET', this.path(workspaceId, groupId));
    if (status !== 200) return this.mapError(status, payload);
    if (!keys(payload, 'routines') || !Array.isArray((payload as { routines: unknown }).routines))
      return { status: 'unavailable' };
    const routines: Routine[] = [];
    for (const row of (payload as { routines: unknown[] }).routines) {
      const parsed = parseRoutine(row, workspaceId, groupId);
      if (!parsed) return { status: 'unavailable' };
      routines.push(parsed);
    }
    return { status: 'available', value: routines };
  }

  async get(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    routineId: string,
  ): Promise<RoutineResult<Routine>> {
    if (!isRoutineUuid(workspaceId) || !isRoutineUuid(groupId) || !isRoutineUuid(routineId))
      return { status: 'invalid' };
    const { status, payload } = await this.send(
      session,
      'GET',
      this.path(workspaceId, groupId, routineId),
    );
    if (status !== 200) return this.mapError(status, payload);
    if (!keys(payload, 'routine')) return { status: 'unavailable' };
    const routine = parseRoutine((payload as { routine: unknown }).routine, workspaceId, groupId);
    return routine ? { status: 'available', value: routine } : { status: 'unavailable' };
  }

  async create(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    input: CreateRoutineInput,
  ): Promise<RoutineResult<Routine>> {
    if (!isRoutineUuid(workspaceId) || !isRoutineUuid(groupId)) return { status: 'invalid' };
    const { status, payload } = await this.send(
      session,
      'POST',
      this.path(workspaceId, groupId),
      input,
      true,
    );
    if (status !== 201) return this.mapError(status, payload);
    if (!keys(payload, 'routine')) return { status: 'unavailable' };
    const routine = parseRoutine((payload as { routine: unknown }).routine, workspaceId, groupId);
    return routine ? { status: 'available', value: routine } : { status: 'unavailable' };
  }

  async edit(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    routineId: string,
    input: EditRoutineInput,
  ): Promise<RoutineResult<Routine>> {
    if (!isRoutineUuid(workspaceId) || !isRoutineUuid(groupId) || !isRoutineUuid(routineId))
      return { status: 'invalid' };
    const { status, payload } = await this.send(
      session,
      'PATCH',
      this.path(workspaceId, groupId, routineId),
      input,
      true,
    );
    if (status !== 200) return this.mapError(status, payload);
    if (!keys(payload, 'routine')) return { status: 'unavailable' };
    const routine = parseRoutine((payload as { routine: unknown }).routine, workspaceId, groupId);
    return routine ? { status: 'available', value: routine } : { status: 'unavailable' };
  }

  async transition(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    routineId: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<RoutineResult<Routine>> {
    if (!isRoutineUuid(workspaceId) || !isRoutineUuid(groupId) || !isRoutineUuid(routineId))
      return { status: 'invalid' };
    const { status, payload } = await this.send(
      session,
      'POST',
      this.path(workspaceId, groupId, routineId, `/${action}`),
      undefined,
      true,
    );
    if (status !== 200) return this.mapError(status, payload);
    if (!keys(payload, 'routine')) return { status: 'unavailable' };
    const routine = parseRoutine((payload as { routine: unknown }).routine, workspaceId, groupId);
    return routine ? { status: 'available', value: routine } : { status: 'unavailable' };
  }
}

export function createRoutineApiClient(request: typeof globalThis.fetch) {
  return new RoutineApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  );
}
