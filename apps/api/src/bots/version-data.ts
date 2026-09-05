import type { SqlConnection } from '../auth/postgres-auth-repository.js';
import {
  BotInputError,
  parseBotConfiguration,
  type BotConfiguration,
  type BotVersion,
} from './service.js';
export class BotVersionNotFoundError extends Error {}
export const versionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function versionId(input: unknown): string {
  if (typeof input !== 'string' || !versionUuid.test(input)) throw new BotInputError();
  return input.toLowerCase();
}
export function versionObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function versionRationale(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 500) throw new BotInputError();
  return value.trim() || undefined;
}
export function applyConfigurationChange(
  current: BotConfiguration,
  change: unknown,
): BotConfiguration {
  if (
    !versionObject(change) ||
    Object.keys(change).some(
      (key) =>
        ![
          'name',
          'roleDescription',
          'description',
          'instructions',
          'modelBinding',
          'limits',
        ].includes(key),
    )
  )
    throw new BotInputError();
  let limits = current.limits;
  if ('limits' in change) {
    if (!versionObject(change.limits)) throw new BotInputError();
    limits = { ...current.limits, ...change.limits };
  }
  const { avatarObjectId, ...previous } = current;
  return {
    ...parseBotConfiguration({
      ...previous,
      ...change,
      limits,
    }),
    ...(avatarObjectId === undefined ? {} : { avatarObjectId }),
  };
}
export type VersionRow = {
  id: string;
  version: number;
  configuration: BotConfiguration;
  author_user_id: string;
  author_name: string;
  created_at: Date;
  rationale: string;
};
export function mapVersion(row: VersionRow): BotVersion {
  return {
    id: row.id,
    number: row.version,
    configuration: row.configuration,
    author: { id: row.author_user_id, displayName: row.author_name },
    createdAt: row.created_at,
    rationale: row.rationale,
  };
}
export async function readBotVersion(
  connection: SqlConnection,
  botId: string,
  id: string,
): Promise<BotVersion> {
  const row = (
    await connection.query<VersionRow>(
      'SELECT v.id,v.version,v.configuration,v.author_user_id,u.display_name AS author_name,v.created_at,v.rationale FROM bot_versions v INNER JOIN users u ON u.id=v.author_user_id WHERE v.bot_id=$1 AND v.id=$2',
      [botId, id],
    )
  ).rows[0];
  if (!row) throw new BotVersionNotFoundError();
  return mapVersion(row);
}
export function configurationFields(config: BotConfiguration) {
  return {
    name: config.name,
    roleDescription: config.roleDescription,
    description: config.description,
    instructions: config.instructions,
    'modelBinding.scope.kind': config.modelBinding.scope.kind,
    'modelBinding.scope.id': config.modelBinding.scope.id,
    'modelBinding.connectionId': config.modelBinding.connectionId,
    'modelBinding.modelId': config.modelBinding.modelId,
    avatarObjectId: config.avatarObjectId ?? null,
    'limits.maxTotalTokens': config.limits.maxTotalTokens,
    'limits.maxDurationSeconds': config.limits.maxDurationSeconds,
    'limits.maxTurns': config.limits.maxTurns,
    'limits.maxDelegationDepth': config.limits.maxDelegationDepth,
  };
}
export type BotVersionField = keyof ReturnType<typeof configurationFields>;
export interface BotVersionDifference {
  field: BotVersionField;
  before: string | number | null;
  after: string | number | null;
}
export function compareConfigurations(
  before: BotConfiguration,
  after: BotConfiguration,
): BotVersionDifference[] {
  const previous = configurationFields(before),
    next = configurationFields(after);
  return (Object.keys(previous) as BotVersionField[])
    .filter((field) => previous[field] !== next[field])
    .map((field) => ({ field, before: previous[field], after: next[field] }));
}
