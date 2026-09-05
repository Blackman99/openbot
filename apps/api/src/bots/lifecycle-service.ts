import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../auth/postgres-auth-repository.js';
import type { TransactionAdmission } from '../database/transaction-admission.js';
import { lockAuthorizedBot, type BotRow } from './postgres-bot-access.js';
import { BotAccessError, type BotLifecycleState } from './service.js';
import { admitBotModel } from './model-binding.js';

export class BotLifecycleConflictError extends Error {}
export class BotRecoveryExpiredError extends Error {}
export const BOT_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export type BotLifecycleAction = 'archive' | 'restore' | 'delete' | 'undo-delete';
export interface BotLifecycle {
  botId: string;
  workspaceId: string;
  state: BotLifecycleState;
  deletedAt: Date | null;
  recoveryDeadline: Date | null;
  preDeletedState: 'active' | 'archived' | null;
}
function lifecycle(row: BotRow): BotLifecycle {
  return {
    botId: row.id,
    workspaceId: row.workspace_id,
    state: row.lifecycle_state,
    deletedAt: row.deleted_at,
    recoveryDeadline: row.recovery_deadline,
    preDeletedState: row.pre_deleted_state,
  };
}
export class BotLifecycleService {
  constructor(
    private readonly pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
    private readonly graceMilliseconds = BOT_DELETION_GRACE_MS,
  ) {
    if (!Number.isSafeInteger(graceMilliseconds) || graceMilliseconds <= 0)
      throw new Error('Bot deletion grace must be a positive duration');
  }
  get(actorUserId: string, workspaceId: string, botId: string) {
    return this.transition(actorUserId, workspaceId, botId);
  }
  archive(
    actorUserId: string,
    workspaceId: string,
    botId: string,
    admission?: TransactionAdmission,
  ) {
    return this.transition(actorUserId, workspaceId, botId, 'archive', admission);
  }
  restore(actorUserId: string, workspaceId: string, botId: string) {
    return this.transition(actorUserId, workspaceId, botId, 'restore');
  }
  softDelete(actorUserId: string, workspaceId: string, botId: string) {
    return this.transition(actorUserId, workspaceId, botId, 'delete');
  }
  undoDelete(actorUserId: string, workspaceId: string, botId: string) {
    return this.transition(actorUserId, workspaceId, botId, 'undo-delete');
  }
  private async transition(
    actorUserId: string,
    workspaceId: string,
    botId: string,
    action?: BotLifecycleAction,
    admission?: TransactionAdmission,
  ): Promise<BotLifecycle> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (!uuid.test(workspaceId) || !uuid.test(botId)) throw new BotAccessError();
    actorUserId = actorUserId.toLowerCase();
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const row = await lockAuthorizedBot(
        connection,
        { actorUserId, workspaceId: workspaceId.toLowerCase(), botId: botId.toLowerCase() },
        'manageLifecycle',
      );
      const previous = row.lifecycle_state;
      if (previous === 'deleted' && (action === 'archive' || action === 'restore'))
        throw new BotLifecycleConflictError();
      const target =
        action === 'delete'
          ? 'deleted'
          : action === 'archive'
            ? 'archived'
            : action === 'restore'
              ? 'active'
              : action === 'undo-delete' && previous === 'deleted'
                ? row.pre_deleted_state!
                : previous;
      if (target !== previous) {
        if (target === 'active')
          await admitBotModel(
            connection,
            actorUserId,
            row.workspace_id,
            row.configuration.modelBinding,
          );
        // Sample only after all current authority locks, including provider admission.
        const occurredAt = this.now();
        if (action === 'undo-delete' && occurredAt.getTime() >= row.recovery_deadline!.getTime())
          throw new BotRecoveryExpiredError();
        row.lifecycle_state = target;
        row.deleted_at = target === 'deleted' ? occurredAt : null;
        row.recovery_deadline =
          target === 'deleted' ? new Date(occurredAt.getTime() + this.graceMilliseconds) : null;
        row.pre_deleted_state = target === 'deleted' ? (previous as 'active' | 'archived') : null;
        await connection.query(
          'UPDATE bots SET lifecycle_state=$2,deleted_at=$3,recovery_deadline=$4,pre_deleted_state=$5 WHERE id=$1',
          [row.id, target, row.deleted_at, row.recovery_deadline, row.pre_deleted_state],
        );
        const event =
          action === 'delete'
            ? 'bot.soft_deleted'
            : action === 'undo-delete'
              ? 'bot.deletion_undone'
              : action === 'archive'
                ? 'bot.archived'
                : 'bot.restored';
        await connection.query(
          'INSERT INTO audit_events(id,event_type,actor_user_id,occurred_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            randomUUID(),
            event,
            actorUserId,
            occurredAt,
            JSON.stringify({
              workspaceId: row.workspace_id,
              botId: row.id,
              fromState: previous,
              toState: target,
              ...(target === 'deleted'
                ? { deletedAt: row.deleted_at, recoveryDeadline: row.recovery_deadline }
                : {}),
            }),
          ],
        );
      }
      await admission?.(connection);
      await connection.query('COMMIT');
      return lifecycle(row);
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
