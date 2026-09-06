import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import type { TransactionAdmission } from '../database/transaction-admission.js';
import { lockAuthorizedGroup } from '../groups/postgres-group-access.js';
import { GroupAccessError, GroupArchivedError } from '../groups/service.js';

export class RoutineInputError extends Error {
  constructor() {
    super('Invalid routine request');
    this.name = 'RoutineInputError';
  }
}
export class RoutineAccessError extends Error {
  constructor() {
    super('Routine forbidden');
    this.name = 'RoutineAccessError';
  }
}
export class RoutineConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RoutineConflictError';
  }
}

export type RoutineRoutingPolicy = 'lead' | 'group';
export type RoutineStatus = 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';

export interface RoutineView {
  id: string;
  workspaceId: string;
  groupId: string;
  ownerUserId: string;
  prompt: string;
  routingPolicy: RoutineRoutingPolicy;
  leadGrantId: string | null;
  timeZone: string;
  executeAt: Date;
  expiresAt: Date;
  maxCostMicros: number;
  kind: 'one_time';
  status: RoutineStatus;
  createdAt: Date;
  updatedAt: Date;
  taskId?: string | null;
  conversationId?: string | null;
}

export interface CreateRoutineInput {
  groupId: string;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new RoutineInputError();
  return value.toLowerCase();
}

function isIanaTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseInstant(value: unknown): Date {
  if (typeof value !== 'string' || !value.trim()) throw new RoutineInputError();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RoutineInputError();
  return parsed;
}

function parsePositiveBudget(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    throw new RoutineInputError();
  return value;
}

export function parseCreateRoutineInput(input: unknown): CreateRoutineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoutineInputError();
  const value = input as Record<string, unknown>;
  const allowed = [
    'groupId',
    'prompt',
    'timeZone',
    'executeAt',
    'expiresAt',
    'maxCostMicros',
    'leadGrantId',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RoutineInputError();
  if (
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    value.prompt.length > 32000 ||
    typeof value.timeZone !== 'string' ||
    !isIanaTimeZone(value.timeZone) ||
    (value.leadGrantId !== undefined && typeof value.leadGrantId !== 'string')
  )
    throw new RoutineInputError();
  return {
    groupId: uuid(value.groupId),
    prompt: value.prompt,
    timeZone: value.timeZone,
    executeAt: parseInstant(value.executeAt).toISOString(),
    expiresAt: parseInstant(value.expiresAt).toISOString(),
    maxCostMicros: parsePositiveBudget(value.maxCostMicros),
    ...(value.leadGrantId === undefined ? {} : { leadGrantId: uuid(value.leadGrantId) }),
  };
}

export function parseEditRoutineInput(input: unknown): EditRoutineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoutineInputError();
  const value = input as Record<string, unknown>;
  const allowed = ['prompt', 'timeZone', 'executeAt', 'expiresAt', 'maxCostMicros', 'leadGrantId'];
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new RoutineInputError();
  const next: EditRoutineInput = {};
  if (value.prompt !== undefined) {
    if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 32000)
      throw new RoutineInputError();
    next.prompt = value.prompt;
  }
  if (value.timeZone !== undefined) {
    if (typeof value.timeZone !== 'string' || !isIanaTimeZone(value.timeZone))
      throw new RoutineInputError();
    next.timeZone = value.timeZone;
  }
  if (value.executeAt !== undefined) next.executeAt = parseInstant(value.executeAt).toISOString();
  if (value.expiresAt !== undefined) next.expiresAt = parseInstant(value.expiresAt).toISOString();
  if (value.maxCostMicros !== undefined)
    next.maxCostMicros = parsePositiveBudget(value.maxCostMicros);
  if (value.leadGrantId !== undefined) {
    if (value.leadGrantId === null) next.leadGrantId = null;
    else next.leadGrantId = uuid(value.leadGrantId);
  }
  return next;
}

export function oneTimeOccurrenceKey(executeAt: Date): string {
  return executeAt.toISOString();
}

type RoutineRow = {
  id: string;
  workspace_id: string;
  group_id: string;
  owner_user_id: string;
  prompt: string;
  lead_grant_id: string | null;
  routing_policy: RoutineRoutingPolicy;
  time_zone: string;
  execute_at: Date;
  expires_at: Date;
  max_cost_micros: string | number;
  kind: 'one_time';
  status: RoutineStatus;
  created_at: Date;
  updated_at: Date;
};

function toView(
  row: RoutineRow,
  link?: { taskId: string | null; conversationId: string | null },
): RoutineView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    groupId: row.group_id,
    ownerUserId: row.owner_user_id,
    prompt: row.prompt,
    routingPolicy: row.routing_policy,
    leadGrantId: row.lead_grant_id,
    timeZone: row.time_zone,
    executeAt: row.execute_at,
    expiresAt: row.expires_at,
    maxCostMicros: Number(row.max_cost_micros),
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(link ? { taskId: link.taskId, conversationId: link.conversationId } : {}),
  };
}

export class RoutineService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(
    actorUserId: string,
    workspaceId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<RoutineView> {
    const command = parseCreateRoutineInput(input);
    const actorId = uuid(actorUserId);
    const workspace = uuid(workspaceId);
    const executeAt = new Date(command.executeAt);
    const expiresAt = new Date(command.expiresAt);
    const occurredAt = this.now();
    if (!(expiresAt > executeAt) || !(executeAt > occurredAt)) throw new RoutineInputError();
    const routingPolicy: RoutineRoutingPolicy = command.leadGrantId ? 'lead' : 'group';
    return this.transaction(async (connection) => {
      await this.lockGroup(connection, actorId, workspace, command.groupId);
      if (command.leadGrantId)
        await this.requireOpenLeadGrant(
          connection,
          workspace,
          command.groupId,
          command.leadGrantId,
        );
      const id = randomUUID();
      await connection.query(
        `INSERT INTO routines(
          id,workspace_id,group_id,owner_user_id,prompt,lead_grant_id,routing_policy,
          time_zone,execute_at,expires_at,max_cost_micros,kind,status,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'one_time','active',$12,$12)`,
        [
          id,
          workspace,
          command.groupId,
          actorId,
          command.prompt,
          command.leadGrantId ?? null,
          routingPolicy,
          command.timeZone,
          executeAt,
          expiresAt,
          command.maxCostMicros,
          occurredAt,
        ],
      );
      await this.audit(connection, 'routine.created', actorId, occurredAt, {
        workspaceId: workspace,
        groupId: command.groupId,
        routineId: id,
        routingPolicy,
        timeZone: command.timeZone,
        maxCostMicros: command.maxCostMicros,
      });
      await admission?.(connection);
      return this.requireView(connection, id);
    });
  }

  edit(
    actorUserId: string,
    workspaceId: string,
    routineId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<RoutineView> {
    const command = parseEditRoutineInput(input);
    const actorId = uuid(actorUserId);
    const workspace = uuid(workspaceId);
    const id = uuid(routineId);
    const occurredAt = this.now();
    return this.mutate(actorId, workspace, id, admission, async (connection, current) => {
      if (current.status !== 'active' && current.status !== 'paused')
        throw new RoutineConflictError('routine_not_mutable');
      const prompt = command.prompt ?? current.prompt;
      const timeZone = command.timeZone ?? current.time_zone;
      const executeAt = command.executeAt ? new Date(command.executeAt) : current.execute_at;
      const expiresAt = command.expiresAt ? new Date(command.expiresAt) : current.expires_at;
      const maxCostMicros = command.maxCostMicros ?? Number(current.max_cost_micros);
      let leadGrantId = current.lead_grant_id;
      let routingPolicy = current.routing_policy;
      if (command.leadGrantId !== undefined) {
        if (command.leadGrantId === null) {
          leadGrantId = null;
          routingPolicy = 'group';
        } else {
          await this.requireOpenLeadGrant(
            connection,
            workspace,
            current.group_id,
            command.leadGrantId,
          );
          leadGrantId = command.leadGrantId;
          routingPolicy = 'lead';
        }
      }
      if (!(expiresAt > executeAt) || !(executeAt > occurredAt)) throw new RoutineInputError();
      await connection.query(
        `UPDATE routines SET prompt=$2,lead_grant_id=$3,routing_policy=$4,time_zone=$5,
          execute_at=$6,expires_at=$7,max_cost_micros=$8,updated_at=$9
         WHERE id=$1`,
        [
          id,
          prompt,
          leadGrantId,
          routingPolicy,
          timeZone,
          executeAt,
          expiresAt,
          maxCostMicros,
          occurredAt,
        ],
      );
      await this.audit(connection, 'routine.updated', actorId, occurredAt, {
        workspaceId: workspace,
        groupId: current.group_id,
        routineId: id,
        routingPolicy,
        timeZone,
        maxCostMicros,
      });
    });
  }

  pause(
    actorUserId: string,
    workspaceId: string,
    routineId: string,
    admission?: TransactionAdmission,
  ): Promise<RoutineView> {
    return this.transition(
      actorUserId,
      workspaceId,
      routineId,
      admission,
      'active',
      'paused',
      'routine.paused',
      'routine_not_active',
    );
  }

  resume(
    actorUserId: string,
    workspaceId: string,
    routineId: string,
    admission?: TransactionAdmission,
  ): Promise<RoutineView> {
    return this.transition(
      actorUserId,
      workspaceId,
      routineId,
      admission,
      'paused',
      'active',
      'routine.resumed',
      'routine_not_paused',
    );
  }

  cancel(
    actorUserId: string,
    workspaceId: string,
    routineId: string,
    admission?: TransactionAdmission,
  ): Promise<RoutineView> {
    const actorId = uuid(actorUserId);
    const workspace = uuid(workspaceId);
    const id = uuid(routineId);
    const occurredAt = this.now();
    return this.mutate(actorId, workspace, id, admission, async (connection, current) => {
      if (current.status !== 'active' && current.status !== 'paused')
        throw new RoutineConflictError('routine_not_mutable');
      await connection.query(`UPDATE routines SET status='cancelled',updated_at=$2 WHERE id=$1`, [
        id,
        occurredAt,
      ]);
      await this.audit(connection, 'routine.cancelled', actorId, occurredAt, {
        workspaceId: workspace,
        groupId: current.group_id,
        routineId: id,
        previousStatus: current.status,
      });
    });
  }

  get(actorUserId: string, workspaceId: string, routineId: string): Promise<RoutineView> {
    const actorId = uuid(actorUserId);
    const workspace = uuid(workspaceId);
    const id = uuid(routineId);
    return this.transaction(async (connection) => {
      const preview = (
        await connection.query<{ group_id: string }>(
          'SELECT group_id FROM routines WHERE id=$1 AND workspace_id=$2',
          [id, workspace],
        )
      ).rows[0];
      if (!preview) throw new RoutineAccessError();
      await this.lockGroup(connection, actorId, workspace, preview.group_id);
      const current = (
        await connection.query<RoutineRow>(
          'SELECT * FROM routines WHERE id=$1 AND workspace_id=$2',
          [id, workspace],
        )
      ).rows[0];
      if (!current || current.group_id !== preview.group_id) throw new RoutineAccessError();
      const link = (
        await connection.query<{ task_id: string | null; conversation_id: string | null }>(
          `SELECT task_id,conversation_id FROM routine_occurrences
           WHERE routine_id=$1 AND outcome='created'
           ORDER BY created_at,id LIMIT 1`,
          [id],
        )
      ).rows[0];
      return toView(
        current,
        link
          ? { taskId: link.task_id, conversationId: link.conversation_id }
          : { taskId: null, conversationId: null },
      );
    });
  }

  private transition(
    actorUserId: string,
    workspaceId: string,
    routineId: string,
    admission: TransactionAdmission | undefined,
    from: RoutineStatus,
    to: RoutineStatus,
    eventType: string,
    conflictCode: string,
  ): Promise<RoutineView> {
    const actorId = uuid(actorUserId);
    const workspace = uuid(workspaceId);
    const id = uuid(routineId);
    const occurredAt = this.now();
    return this.mutate(actorId, workspace, id, admission, async (connection, current) => {
      if (current.status !== from) throw new RoutineConflictError(conflictCode);
      if (!(current.expires_at > occurredAt)) throw new RoutineConflictError('routine_expired');
      await connection.query(`UPDATE routines SET status=$2,updated_at=$3 WHERE id=$1`, [
        id,
        to,
        occurredAt,
      ]);
      await this.audit(connection, eventType, actorId, occurredAt, {
        workspaceId: workspace,
        groupId: current.group_id,
        routineId: id,
        previousStatus: current.status,
        status: to,
      });
    });
  }

  private async mutate(
    actorId: string,
    workspace: string,
    routineId: string,
    admission: TransactionAdmission | undefined,
    work: (connection: SqlConnection, current: RoutineRow) => Promise<void>,
  ): Promise<RoutineView> {
    return this.transaction(async (connection) => {
      const preview = (
        await connection.query<{ group_id: string }>(
          'SELECT group_id FROM routines WHERE id=$1 AND workspace_id=$2',
          [routineId, workspace],
        )
      ).rows[0];
      if (!preview) throw new RoutineAccessError();
      await this.lockGroup(connection, actorId, workspace, preview.group_id);
      const current = (
        await connection.query<RoutineRow>(
          'SELECT * FROM routines WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [routineId, workspace],
        )
      ).rows[0];
      if (!current || current.group_id !== preview.group_id) throw new RoutineAccessError();
      await work(connection, current);
      await admission?.(connection);
      return this.requireView(connection, routineId);
    });
  }

  private async lockGroup(
    connection: SqlConnection,
    actorId: string,
    workspaceId: string,
    groupId: string,
  ) {
    try {
      await lockAuthorizedGroup(connection, { actorId, workspaceId, groupId }, 'content');
    } catch (error) {
      if (error instanceof GroupAccessError || error instanceof GroupArchivedError)
        throw new RoutineAccessError();
      throw error;
    }
  }

  private async requireOpenLeadGrant(
    connection: SqlConnection,
    workspaceId: string,
    groupId: string,
    leadGrantId: string,
  ) {
    const grant = (
      await connection.query<{ id: string }>(
        `SELECT id FROM group_bot_grants
         WHERE id=$1 AND workspace_id=$2 AND group_id=$3 AND close_event_id IS NULL`,
        [leadGrantId, workspaceId, groupId],
      )
    ).rows[0];
    if (!grant) throw new RoutineInputError();
  }

  private async audit(
    connection: SqlConnection,
    eventType: string,
    actorId: string,
    occurredAt: Date,
    metadata: Record<string, unknown>,
  ) {
    await connection.query(
      'INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [randomUUID(), eventType, actorId, occurredAt, JSON.stringify(metadata)],
    );
  }

  private async requireView(connection: SqlConnection, id: string): Promise<RoutineView> {
    const row = (await connection.query<RoutineRow>('SELECT * FROM routines WHERE id=$1', [id]))
      .rows[0];
    if (!row) throw new RoutineInputError();
    return toView(row);
  }

  private async transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await work(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
