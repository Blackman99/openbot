import type { SqlConnection, SqlPool } from '../auth/postgres-auth-repository.js';
import type { TransactionAdmission } from '../database/transaction-admission.js';
import { avatarAccess, type BotAvatarService } from './avatar-service.js';
import {
  appendBotVersion,
  BotAvatarUnavailableError,
  BotVersionConflictError,
} from './append-version.js';
import { lockAuthorizedBot, type BotAccess } from './postgres-bot-access.js';
import { BotAccessError, BotInputError, type BotVersion } from './service.js';
import { ObjectNotFoundError } from '../objects/store.js';
import {
  compareConfigurations,
  readBotVersion,
  versionId,
  versionObject,
  versionRationale,
  type VersionRow,
} from './version-data.js';
export type BotVersionSummary = Omit<BotVersion, 'configuration'>;
export interface BotVersionPage {
  currentVersionId: string;
  versions: BotVersionSummary[];
  nextBefore: number | null;
}
export class BotVersionService {
  constructor(
    private readonly pool: SqlPool,
    private readonly avatars: Pick<BotAvatarService, 'read'>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async transaction<T>(
    operation: (connection: SqlConnection) => Promise<T>,
    admission?: TransactionAdmission,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await operation(connection);
      await admission?.(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  access(actor: string, workspace: string, bot: string): BotAccess {
    return avatarAccess(actor, workspace, bot);
  }
  private request(input: unknown, allowed: string[]) {
    if (!versionObject(input) || Object.keys(input).some((key) => !allowed.includes(key)))
      throw new BotInputError();
    return {
      input,
      expectedCurrentVersionId: versionId(input.expectedCurrentVersionId),
      rationale: versionRationale(input.rationale),
    };
  }
  edit(access: BotAccess, input: unknown, admission?: TransactionAdmission) {
    const request = this.request(input, ['expectedCurrentVersionId', 'changes', 'rationale']);
    return this.transaction(
      (connection) =>
        appendBotVersion(
          connection,
          access,
          {
            kind: 'configuration',
            expectedCurrentVersionId: request.expectedCurrentVersionId,
            changes: request.input.changes,
            ...(request.rationale ? { rationale: request.rationale } : {}),
          },
          this.now,
        ),
      admission,
    );
  }
  async restore(access: BotAccess, input: unknown) {
    const request = this.request(input, [
      'expectedCurrentVersionId',
      'sourceVersionId',
      'rationale',
    ]);
    const sourceVersionId = versionId(request.input.sourceVersionId);
    const source = await this.transaction(async (connection) => {
      const current = await lockAuthorizedBot(connection, access, 'edit');
      if (current.version_id !== request.expectedCurrentVersionId)
        throw new BotVersionConflictError();
      return readBotVersion(connection, access.botId, sourceVersionId);
    });
    if (source.configuration.avatarObjectId) {
      try {
        await this.avatars.read(access, sourceVersionId);
      } catch (error) {
        if (error instanceof BotAccessError) throw error;
        if (error instanceof ObjectNotFoundError || error instanceof BotAvatarUnavailableError)
          throw new BotAvatarUnavailableError();
        throw error;
      }
    }
    return this.transaction((connection) =>
      appendBotVersion(
        connection,
        access,
        {
          kind: 'restore',
          expectedCurrentVersionId: request.expectedCurrentVersionId,
          sourceVersionId,
          ...(request.rationale ? { rationale: request.rationale } : {}),
        },
        this.now,
      ),
    );
  }
  get(access: BotAccess, id: unknown, admission?: TransactionAdmission) {
    const selected = versionId(id);
    return this.transaction(async (connection) => {
      await lockAuthorizedBot(connection, access, 'inspect');
      return readBotVersion(connection, access.botId, selected);
    }, admission);
  }
  list(
    access: BotAccess,
    query: unknown,
    admission?: TransactionAdmission,
  ): Promise<BotVersionPage> {
    if (
      !versionObject(query) ||
      Object.keys(query).some((key) => !['before', 'limit'].includes(key))
    )
      throw new BotInputError();
    const positive = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      if (
        typeof value !== 'string' ||
        !/^[1-9][0-9]*$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) > max
      )
        throw new BotInputError();
      return Number(value);
    };
    const before = positive(query.before, 2147483647, 2147483647),
      limit = positive(query.limit, 50, 100);
    return this.transaction(async (connection) => {
      const bot = await lockAuthorizedBot(connection, access, 'inspect');
      const rows = (
        await connection.query<Omit<VersionRow, 'configuration'>>(
          'SELECT v.id,v.version,v.author_user_id,u.display_name AS author_name,v.created_at,v.rationale FROM bot_versions v INNER JOIN users u ON u.id=v.author_user_id WHERE v.bot_id=$1 AND v.version<$2 ORDER BY v.version DESC LIMIT $3',
          [access.botId, before, limit + 1],
        )
      ).rows;
      const versions = rows.slice(0, limit).map((row) => ({
        id: row.id,
        number: row.version,
        author: { id: row.author_user_id, displayName: row.author_name },
        createdAt: row.created_at,
        rationale: row.rationale,
      }));
      return {
        currentVersionId: bot.version_id,
        versions,
        nextBefore: rows.length > limit ? versions.at(-1)!.number : null,
      };
    }, admission);
  }
  compare(access: BotAccess, from: unknown, to: unknown) {
    const fromVersionId = versionId(from),
      toVersionId = versionId(to);
    return this.transaction(async (connection) => {
      await lockAuthorizedBot(connection, access, 'inspect');
      const before = await readBotVersion(connection, access.botId, fromVersionId),
        after = await readBotVersion(connection, access.botId, toVersionId);
      return {
        fromVersionId,
        toVersionId,
        differences: compareConfigurations(before.configuration, after.configuration),
      };
    });
  }
}
