import { randomUUID } from 'node:crypto';
import type { ConnectionScope } from '../providers/scope.js';
import type { TransactionAdmission } from '../database/transaction-admission.js';

export type BotRole = 'owner' | 'editor' | 'user';
export type BotListView = 'default' | 'deleted' | 'usable';
export type BotLifecycleState = 'active' | 'archived' | 'deleted';
export type BindingStatus =
  | { state: 'ready'; chatOnly: boolean }
  | {
      state: 'unavailable';
      reason: 'disabled' | 'binding-changed' | 'capability-unavailable' | 'not-accessible';
    };
export interface BotLimits {
  maxTotalTokens: number;
  maxDurationSeconds: number;
  maxTurns: number;
  maxDelegationDepth: number;
}
export interface BotBinding {
  scope: ConnectionScope;
  connectionId: string;
  modelId: string;
}
export interface BotConfiguration {
  avatarObjectId?: string | null;
  name: string;
  roleDescription: string;
  description: string;
  instructions: string;
  modelBinding: BotBinding;
  limits: BotLimits;
}
export interface BotSummary {
  lifecycleState: BotLifecycleState;
  avatarVersionId?: string;
  id: string;
  workspaceId: string;
  visibility: 'private' | 'workspace';
  accessRole: BotRole | null;
  name: string;
  roleDescription: string;
  description: string;
  bindingStatus: BindingStatus;
}
export interface BotVersion {
  id: string;
  number: number;
  author: { id: string; displayName: string };
  createdAt: Date;
  rationale: string;
  configuration: BotConfiguration;
}
export type BotDetail = BotSummary & { currentVersion?: BotVersion };
export interface BotCreate {
  id: string;
  versionId: string;
  auditId: string;
  actorUserId: string;
  workspaceId: string;
  configuration: BotConfiguration;
}
export interface BotRepository {
  create(record: BotCreate, admission?: TransactionAdmission): Promise<BotDetail>;
  list(
    actorUserId: string,
    workspaceId: string,
    view?: BotListView,
    admission?: TransactionAdmission,
  ): Promise<BotSummary[]>;
  get(
    actorUserId: string,
    workspaceId: string,
    botId: string,
    admission?: TransactionAdmission,
  ): Promise<BotDetail>;
}
export class BotAccessError extends Error {}
export class BotInputError extends Error {}
export type BindingUnavailableReason = Extract<BindingStatus, { state: 'unavailable' }>['reason'];
export class BotModelError extends Error {
  constructor(readonly reason: BindingUnavailableReason) {
    super(reason);
  }
}
export const DEFAULT_BOT_LIMITS: BotLimits = {
  maxTotalTokens: 32768,
  maxDurationSeconds: 300,
  maxTurns: 8,
  maxDelegationDepth: 2,
};
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function parseBotConfiguration(input: unknown): BotConfiguration {
  if (
    !object(input) ||
    !onlyKeys(input, [
      'name',
      'roleDescription',
      'description',
      'instructions',
      'modelBinding',
      'limits',
    ])
  )
    throw new BotInputError();
  const { name, roleDescription, instructions, modelBinding } = input;
  const description = input.description === undefined ? '' : input.description;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 100 ||
    typeof roleDescription !== 'string' ||
    !roleDescription.trim() ||
    roleDescription.trim().length > 200 ||
    typeof description !== 'string' ||
    description.length > 2000 ||
    typeof instructions !== 'string' ||
    !instructions.trim() ||
    instructions.length > 32000
  )
    throw new BotInputError();
  if (
    !object(modelBinding) ||
    !onlyKeys(modelBinding, ['scope', 'connectionId', 'modelId']) ||
    !object(modelBinding.scope) ||
    !onlyKeys(modelBinding.scope, ['kind', 'id']) ||
    (modelBinding.scope.kind !== 'personal' && modelBinding.scope.kind !== 'workspace') ||
    typeof modelBinding.scope.id !== 'string' ||
    !uuid.test(modelBinding.scope.id) ||
    typeof modelBinding.connectionId !== 'string' ||
    !uuid.test(modelBinding.connectionId) ||
    typeof modelBinding.modelId !== 'string' ||
    !modelBinding.modelId.trim() ||
    modelBinding.modelId.length > 256
  )
    throw new BotInputError();
  const limits = { ...DEFAULT_BOT_LIMITS };
  if ('limits' in input) {
    if (!object(input.limits) || !onlyKeys(input.limits, Object.keys(limits)))
      throw new BotInputError();
    const ranges = {
      maxTotalTokens: [1, 1000000],
      maxDurationSeconds: [1, 3600],
      maxTurns: [1, 100],
      maxDelegationDepth: [0, 8],
    } as const;
    for (const key of Object.keys(ranges) as Array<keyof BotLimits>) {
      if (!(key in input.limits)) continue;
      const value = input.limits[key];
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < ranges[key][0] ||
        value > ranges[key][1]
      )
        throw new BotInputError();
      limits[key] = value;
    }
  }
  return {
    name: name.trim(),
    roleDescription: roleDescription.trim(),
    description: description.trim(),
    instructions,
    modelBinding: {
      scope: { kind: modelBinding.scope.kind, id: modelBinding.scope.id.toLowerCase() },
      connectionId: modelBinding.connectionId.toLowerCase(),
      modelId: modelBinding.modelId,
    },
    limits,
  };
}
export class BotService {
  constructor(private readonly repository: BotRepository) {}
  list(
    actorUserId: string,
    workspaceId: string,
    view: unknown = 'default',
    admission?: TransactionAdmission,
  ): Promise<BotSummary[]> {
    if (!uuid.test(workspaceId)) throw new BotAccessError();
    if (view !== 'default' && view !== 'deleted' && view !== 'usable') throw new BotInputError();
    return this.repository.list(
      actorUserId.toLowerCase(),
      workspaceId.toLowerCase(),
      view,
      admission,
    );
  }
  get(
    actorUserId: string,
    workspaceId: string,
    botId: string,
    admission?: TransactionAdmission,
  ): Promise<BotDetail> {
    if (!uuid.test(workspaceId) || !uuid.test(botId)) throw new BotAccessError();
    return this.repository.get(
      actorUserId.toLowerCase(),
      workspaceId.toLowerCase(),
      botId.toLowerCase(),
      admission,
    );
  }
  create(
    actorUserId: string,
    workspaceId: string,
    input: unknown,
    admission?: TransactionAdmission,
  ): Promise<BotDetail> {
    if (!uuid.test(workspaceId)) throw new BotAccessError();
    const configuration = parseBotConfiguration(input);
    return this.repository.create(
      {
        id: randomUUID(),
        versionId: randomUUID(),
        auditId: randomUUID(),
        actorUserId: actorUserId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
        configuration,
      },
      admission,
    );
  }
}
