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
    typeof value.maxCostMicros !== 'number' ||
    !Number.isInteger(value.maxCostMicros) ||
    value.maxCostMicros <= 0 ||
    value.maxCostMicros > Number.MAX_SAFE_INTEGER ||
    (value.leadGrantId !== undefined && typeof value.leadGrantId !== 'string')
  )
    throw new RoutineInputError();
  return {
    groupId: uuid(value.groupId),
    prompt: value.prompt,
    timeZone: value.timeZone,
    executeAt: parseInstant(value.executeAt).toISOString(),
    expiresAt: parseInstant(value.expiresAt).toISOString(),
    maxCostMicros: value.maxCostMicros,
    ...(value.leadGrantId === undefined ? {} : { leadGrantId: uuid(value.leadGrantId) }),
  };
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

function toView(row: RoutineRow): RoutineView {
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
      try {
        await lockAuthorizedGroup(
          connection,
          { actorId, workspaceId: workspace, groupId: command.groupId },
          'content',
        );
      } catch (error) {
        if (error instanceof GroupAccessError || error instanceof GroupArchivedError)
          throw new RoutineAccessError();
        throw error;
      }
      if (command.leadGrantId) {
        const grant = (
          await connection.query<{ id: string }>(
            `SELECT id FROM group_bot_grants
             WHERE id=$1 AND workspace_id=$2 AND group_id=$3 AND close_event_id IS NULL`,
            [command.leadGrantId, workspace, command.groupId],
          )
        ).rows[0];
        if (!grant) throw new RoutineInputError();
      }
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
      await connection.query(
        "INSERT INTO audit_events (id,event_type,actor_user_id,occurred_at,metadata) VALUES ($1,'routine.created',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          actorId,
          occurredAt,
          JSON.stringify({
            workspaceId: workspace,
            groupId: command.groupId,
            routineId: id,
            routingPolicy,
            timeZone: command.timeZone,
            maxCostMicros: command.maxCostMicros,
          }),
        ],
      );
      await admission?.(connection);
      const row = (await connection.query<RoutineRow>('SELECT * FROM routines WHERE id=$1', [id]))
        .rows[0];
      if (!row) throw new RoutineInputError();
      return toView(row);
    });
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
