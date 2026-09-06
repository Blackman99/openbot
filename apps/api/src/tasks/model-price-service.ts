import { randomUUID } from 'node:crypto';
import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import { TaskAccessError, TaskInputError } from './errors.js';
import {
  parseModelPriceInput,
  type ModelPriceInput,
  type ModelPriceVersion,
} from './model-price.js';

export { TaskAccessError, TaskInputError };

export type ModelPriceView = ModelPriceVersion & {
  createdAt: Date;
};

async function requireWorkspaceAdmin(
  connection: SqlConnection,
  workspaceId: string,
  actorUserId: string,
) {
  const member = (
    await connection.query<{ role: string }>(
      "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','administrator')",
      [workspaceId, actorUserId],
    )
  ).rows[0];
  if (!member) throw new TaskAccessError();
}

async function requireWorkspaceMember(
  connection: SqlConnection,
  workspaceId: string,
  actorUserId: string,
) {
  const member = (
    await connection.query<{ role: string }>(
      'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
      [workspaceId, actorUserId],
    )
  ).rows[0];
  if (!member) throw new TaskAccessError();
}

async function requirePricedConnection(
  connection: SqlConnection,
  workspaceId: string,
  input: ModelPriceInput,
) {
  const workspace = (
    await connection.query<{ model_id: string }>(
      `SELECT metadata->>'modelId' AS model_id FROM workspace_model_connections
       WHERE id=$1 AND workspace_id=$2`,
      [input.connectionId, workspaceId],
    )
  ).rows[0];
  const personal = workspace
    ? undefined
    : (
        await connection.query<{ model_id: string }>(
          `SELECT metadata->>'modelId' AS model_id FROM personal_model_connections WHERE id=$1`,
          [input.connectionId],
        )
      ).rows[0];
  const modelId = workspace?.model_id ?? personal?.model_id;
  if (!modelId || modelId !== input.modelId) throw new TaskInputError();
}

function view(row: {
  id: string;
  workspace_id: string;
  connection_id: string;
  model_id: string;
  input_micros_per_million: string | number;
  output_micros_per_million: string | number;
  created_at: Date;
}): ModelPriceView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    modelId: row.model_id,
    inputMicrosPerMillion: Number(row.input_micros_per_million),
    outputMicrosPerMillion: Number(row.output_micros_per_million),
    createdAt: row.created_at,
  };
}

export async function loadActiveModelPrice(
  connection: SqlConnection,
  workspaceId: string,
  connectionId: string,
  modelId: string,
): Promise<ModelPriceVersion | undefined> {
  const row = (
    await connection.query<{
      id: string;
      workspace_id: string;
      connection_id: string;
      model_id: string;
      input_micros_per_million: string | number;
      output_micros_per_million: string | number;
    }>(
      `SELECT id,workspace_id,connection_id,model_id,input_micros_per_million,output_micros_per_million
       FROM model_price_versions
       WHERE workspace_id=$1 AND connection_id=$2 AND model_id=$3 AND superseded_at IS NULL
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [workspaceId, connectionId, modelId],
    )
  ).rows[0];
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        connectionId: row.connection_id,
        modelId: row.model_id,
        inputMicrosPerMillion: Number(row.input_micros_per_million),
        outputMicrosPerMillion: Number(row.output_micros_per_million),
      }
    : undefined;
}

export async function loadPinnedModelPrice(
  connection: SqlConnection,
  priceVersionId: string,
): Promise<ModelPriceVersion | undefined> {
  const row = (
    await connection.query<{
      id: string;
      workspace_id: string;
      connection_id: string;
      model_id: string;
      input_micros_per_million: string | number;
      output_micros_per_million: string | number;
    }>(
      `SELECT id,workspace_id,connection_id,model_id,input_micros_per_million,output_micros_per_million
       FROM model_price_versions WHERE id=$1`,
      [priceVersionId],
    )
  ).rows[0];
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        connectionId: row.connection_id,
        modelId: row.model_id,
        inputMicrosPerMillion: Number(row.input_micros_per_million),
        outputMicrosPerMillion: Number(row.output_micros_per_million),
      }
    : undefined;
}

export class ModelPriceService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(actorUserId: string, workspaceId: string): Promise<ModelPriceView[]> {
    const connection = await this.pool.connect();
    try {
      await requireWorkspaceMember(connection, workspaceId, actorUserId);
      const rows = (
        await connection.query<{
          id: string;
          workspace_id: string;
          connection_id: string;
          model_id: string;
          input_micros_per_million: string | number;
          output_micros_per_million: string | number;
          created_at: Date;
        }>(
          `SELECT id,workspace_id,connection_id,model_id,input_micros_per_million,output_micros_per_million,created_at
           FROM model_price_versions
           WHERE workspace_id=$1 AND superseded_at IS NULL
           ORDER BY created_at DESC,id`,
          [workspaceId],
        )
      ).rows;
      return rows.map(view);
    } finally {
      connection.release();
    }
  }

  async supersede(
    actorUserId: string,
    workspaceId: string,
    body: unknown,
  ): Promise<ModelPriceView> {
    const input = parseModelPriceInput(body);
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await requireWorkspaceAdmin(connection, workspaceId, actorUserId);
      await requirePricedConnection(connection, workspaceId, input);
      const now = this.now();
      await connection.query(
        `SELECT id FROM model_price_versions
         WHERE workspace_id=$1 AND connection_id=$2 AND model_id=$3 AND superseded_at IS NULL
         FOR UPDATE`,
        [workspaceId, input.connectionId, input.modelId],
      );
      await connection.query(
        `UPDATE model_price_versions SET superseded_at=$4
         WHERE workspace_id=$1 AND connection_id=$2 AND model_id=$3 AND superseded_at IS NULL`,
        [workspaceId, input.connectionId, input.modelId, now],
      );
      const id = randomUUID();
      await connection.query(
        `INSERT INTO model_price_versions(
          id,workspace_id,connection_id,model_id,input_micros_per_million,output_micros_per_million,
          created_by_user_id,created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          workspaceId,
          input.connectionId,
          input.modelId,
          input.inputMicrosPerMillion,
          input.outputMicrosPerMillion,
          actorUserId,
          now,
        ],
      );
      await connection.query(
        "INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,'model.price.superseded',$2,$3,$4::jsonb)",
        [
          randomUUID(),
          actorUserId,
          now,
          JSON.stringify({
            workspaceId,
            connectionId: input.connectionId,
            modelId: input.modelId,
            priceVersionId: id,
            inputMicrosPerMillion: input.inputMicrosPerMillion,
            outputMicrosPerMillion: input.outputMicrosPerMillion,
          }),
        ],
      );
      await connection.query('COMMIT');
      return {
        id,
        workspaceId,
        connectionId: input.connectionId,
        modelId: input.modelId,
        inputMicrosPerMillion: input.inputMicrosPerMillion,
        outputMicrosPerMillion: input.outputMicrosPerMillion,
        createdAt: now,
      };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
