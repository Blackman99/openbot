import {
  currentPolicy,
  emptyPolicy,
  policyDetails,
  recordProbe,
  type ModelPolicy,
} from './capability-policy.js';
import { resolutionPreview } from './fallback-policy.js';
import {
  parseFallbacks,
  parseRequirement,
  parseOverride,
  policyMutation,
  type PolicyChange,
} from './policy-input.js';
import { randomUUID } from 'node:crypto';
import {
  credentialContext,
  personalAccess,
  sharedView,
  type ConnectionAccess,
  type ConnectionAuthority,
  type ConnectionPermission,
} from './scope.js';
import type { ProviderProtocol } from './model-events.js';
import type { ConnectionProbe, ProbeInput, ProbeReport, ProbeAdmission } from './model-probe.js';
import { ProviderSecretBox, redactProviderText } from './secrets.js';
import { ProviderError, ProviderUrlPolicy } from './url-policy.js';

export interface ConnectionInput {
  protocol: ProviderProtocol;
  anthropicVersion?: string;
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  headers: Record<string, string>;
}
export interface ConnectionMetadata {
  protocol: ProviderProtocol;
  anthropicVersion?: string;
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  headerNames: string[];
  lastProbe: ProbeReport;
}
export interface ConnectionRecord {
  policy?: ModelPolicy;
  metadata: ConnectionMetadata;
  access: ConnectionAccess;
  canManage: boolean;
  sealedCredentials: string;
  revision: number;
}
export interface ProviderRepository {
  authorize(
    access: ConnectionAccess,
    permission: ConnectionPermission,
  ): Promise<ConnectionAuthority>;
  insert(record: ConnectionRecord): Promise<void>;
  find(
    access: ConnectionAccess,
    id: string,
    permission?: ConnectionPermission,
  ): Promise<ConnectionRecord | undefined>;
  list(access: ConnectionAccess): Promise<{ canManage: boolean; records: ConnectionRecord[] }>;
  replace(record: ConnectionRecord, event: string): Promise<boolean>;
  delete(access: ConnectionAccess, id: string): Promise<boolean>;
  changePolicy(
    access: ConnectionAccess,
    id: string,
    expectedRevision: number,
    change: PolicyChange,
  ): Promise<ConnectionRecord>;
}

export function parseConnectionInput(value: unknown): ConnectionInput {
  const invalid = () => {
    throw new ProviderError('invalid_connection');
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  const protocol = input.protocol ?? 'openai-chat';
  if (
    protocol !== 'openai-chat' &&
    protocol !== 'openai-responses' &&
    protocol !== 'anthropic-messages'
  )
    return invalid();
  const anthropicVersion = input.anthropicVersion ?? '2023-06-01';
  if (
    protocol === 'anthropic-messages' &&
    (typeof anthropicVersion !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(anthropicVersion) ||
      !Number.isFinite(Date.parse(anthropicVersion)) ||
      new Date(anthropicVersion).toISOString().slice(0, 10) !== anthropicVersion)
  )
    return invalid();
  for (const name of ['name', 'baseUrl', 'modelId', 'apiKey']) {
    if (
      typeof input[name] !== 'string' ||
      (input[name] as string).length > (name === 'apiKey' ? 4096 : 2048)
    )
      return invalid();
  }
  const name = (input.name as string).trim();
  const modelId = (input.modelId as string).trim();
  if (!name || name.length > 120 || !modelId || modelId.length > 256) return invalid();
  if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers))
    return invalid();
  const entries = Object.entries(input.headers);
  if (entries.length > 20) return invalid();
  const headers: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(normalized) ||
      typeof value !== 'string' ||
      value.length > 4096 ||
      /[^\x20-\x7e]/u.test(value) ||
      [
        'host',
        'content-length',
        'transfer-encoding',
        'connection',
        'upgrade',
        'trailer',
        'te',
        'expect',
        'proxy-authorization',
        'proxy-connection',
        'cookie',
        'set-cookie',
        'content-type',
        'accept',
      ].includes(normalized) ||
      Object.hasOwn(headers, normalized)
    )
      return invalid();
    headers[normalized] = value;
  }
  const apiKey = input.apiKey as string;
  const authenticationHeader = protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization';
  if (
    /[^\x20-\x7e]/u.test(apiKey) ||
    (apiKey && headers[authenticationHeader]) ||
    (protocol === 'anthropic-messages' && headers['anthropic-version'])
  )
    return invalid();
  return {
    protocol,
    ...(protocol === 'anthropic-messages' ? { anthropicVersion: anthropicVersion as string } : {}),
    name,
    modelId,
    apiKey,
    headers,
    baseUrl: (input.baseUrl as string).trim().replace(/\/+$/u, ''),
  };
}

function targetChanged(
  input: ConnectionInput,
  previous: ConnectionMetadata,
  credentials: { apiKey: string; headers: Record<string, string> },
): boolean {
  const headers = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return (
    input.protocol !== previous.protocol ||
    input.baseUrl !== previous.baseUrl ||
    input.modelId !== previous.modelId ||
    input.anthropicVersion !== previous.anthropicVersion ||
    input.apiKey !== credentials.apiKey ||
    headers(input.headers) !== headers(credentials.headers)
  );
}

export class ProviderConnections {
  constructor(
    private readonly repository: ProviderRepository,
    private readonly secrets: ProviderSecretBox,
    private readonly policy: ProviderUrlPolicy,
    private readonly probe: ConnectionProbe,
    private readonly workspaceId?: string,
  ) {}

  inWorkspace(workspaceId: string): ProviderConnections {
    return new ProviderConnections(
      this.repository,
      this.secrets,
      this.policy,
      this.probe,
      workspaceId,
    );
  }
  private access(actorUserId: string): ConnectionAccess {
    return this.workspaceId === undefined
      ? personalAccess(actorUserId)
      : { actorUserId, scope: { kind: 'workspace', id: this.workspaceId.toLowerCase() } };
  }
  async view(actorUserId: string) {
    const result = await this.repository.list(this.access(actorUserId));
    return {
      canManage: result.canManage,
      connections: result.records.map((record) => sharedView(record.metadata, result.canManage)),
    };
  }
  async viewOne(actorUserId: string, id: string) {
    const record = await this.owned(actorUserId, id, 'read');
    return {
      canManage: record.canManage,
      connection: sharedView(record.metadata, record.canManage),
    };
  }

  async capabilities(actorUserId: string, id: string) {
    return policyDetails(await this.owned(actorUserId, id, 'read'));
  }

  async override(actorUserId: string, id: string, value: unknown) {
    const record = await this.owned(actorUserId, id, 'manage');
    const input = parseOverride(value);
    if (record.revision !== input.expectedRevision) throw new ProviderError('connection_conflict');
    const credentials = this.secrets.open(
      record.sealedCredentials,
      credentialContext(record.access.scope, record.metadata.id),
    );
    const changed = await this.repository.changePolicy(
      record.access,
      record.metadata.id,
      input.expectedRevision,
      {
        kind: 'override',
        capability: input.capability,
        value: input.value,
        rationale: redactProviderText(input.rationale, credentials),
        createdAt: new Date().toISOString(),
      },
    );
    return policyDetails(changed);
  }

  async setFallbacks(actorUserId: string, id: string, value: unknown) {
    await this.repository.authorize(this.access(actorUserId), 'manage');
    const input = parseFallbacks(value);
    const record = await this.repository.changePolicy(
      this.access(actorUserId),
      id,
      input.expectedRevision,
      {
        kind: 'fallbacks',
        requiredCapability: input.requiredCapability,
        connectionIds: input.connectionIds,
      },
    );
    return policyDetails(record);
  }
  async preview(actorUserId: string, id: string, requirement: unknown) {
    const graph = await this.repository.list(this.access(actorUserId));
    return resolutionPreview(graph.records, id, parseRequirement(requirement));
  }

  async save(ownerId: string, value: unknown, signal?: AbortSignal): Promise<ConnectionMetadata> {
    const access = this.access(ownerId);
    await this.repository.authorize(access, 'manage');
    const input = parseConnectionInput(value);
    this.policy.validate(input.baseUrl);
    const report = await this.runProbe(input, signal, this.admission(ownerId, 'manage'));
    const id = randomUUID();
    const metadata: ConnectionMetadata = {
      id,
      protocol: input.protocol,
      ...(input.anthropicVersion === undefined ? {} : { anthropicVersion: input.anthropicVersion }),
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      enabled: report.text.ok,
      apiKeyConfigured: Boolean(input.apiKey),
      headerNames: Object.keys(input.headers).sort(),
      lastProbe: report,
    };
    await this.repository.insert({
      access,
      canManage: true,
      metadata,
      revision: 0,
      policy: recordProbe({ ...emptyPolicy(), generation: 1 }, ownerId, report),
      sealedCredentials: this.secrets.seal(
        { apiKey: input.apiKey, headers: input.headers },
        credentialContext(this.access(ownerId).scope, id),
      ),
    });
    return metadata;
  }

  async get(ownerId: string, id: string): Promise<ConnectionMetadata> {
    const record = await this.repository.find(this.access(ownerId), id);
    if (!record) throw new ProviderError('connection_not_found');
    return record.metadata;
  }

  async list(ownerId: string): Promise<ConnectionMetadata[]> {
    return (await this.repository.list(this.access(ownerId))).records.map(
      (record) => record.metadata,
    );
  }

  private async owned(
    ownerId: string,
    id: string,
    permission: ConnectionPermission = 'manage',
  ): Promise<ConnectionRecord> {
    const record = await this.repository.find(this.access(ownerId), id, permission);
    if (!record) throw new ProviderError('connection_not_found');
    return record;
  }

  async update(
    ownerId: string,
    id: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionMetadata> {
    const record = await this.owned(ownerId, id);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ProviderError('invalid_connection');
    const existing = this.secrets.open(
      record.sealedCredentials,
      credentialContext(this.access(ownerId).scope, id),
    );
    const input = parseConnectionInput({ ...record.metadata, ...existing, ...value });
    this.policy.validate(input.baseUrl);
    const report = await this.runProbe(input, signal, this.admission(ownerId, 'manage', record));
    const metadata: ConnectionMetadata = {
      id: record.metadata.id,
      protocol: input.protocol,
      ...(input.anthropicVersion === undefined ? {} : { anthropicVersion: input.anthropicVersion }),
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      enabled: report.text.ok,
      apiKeyConfigured: Boolean(input.apiKey),
      headerNames: Object.keys(input.headers).sort(),
      lastProbe: report,
    };
    const previousPolicy = currentPolicy(record.policy);
    const policy = recordProbe(
      {
        ...previousPolicy,
        generation:
          previousPolicy.generation + (targetChanged(input, record.metadata, existing) ? 1 : 0),
      },
      ownerId,
      report,
    );
    const sealedCredentials = this.secrets.seal(
      { apiKey: input.apiKey, headers: input.headers },
      credentialContext(this.access(ownerId).scope, id),
    );
    if (
      !(await this.repository.replace(
        {
          access: this.access(ownerId),
          canManage: true,
          metadata,
          sealedCredentials,
          policy,
          revision: record.revision,
        },
        'provider.connection_updated',
      ))
    )
      throw new ProviderError('connection_conflict');
    return metadata;
  }

  async test(ownerId: string, id: string, signal?: AbortSignal): Promise<ProbeReport> {
    const record = await this.owned(ownerId, id, 'use');
    return this.probeSaved(record, ownerId, signal, 'use', 'provider.connection_tested');
  }
  async reprobe(ownerId: string, id: string, value: unknown, signal?: AbortSignal) {
    const record = await this.owned(ownerId, id, 'manage');
    const input = policyMutation(value, ['expectedRevision']);
    if (record.revision !== input.expectedRevision) throw new ProviderError('connection_conflict');
    await this.probeSaved(record, ownerId, signal, 'manage', 'provider.connection_reprobed');
    return this.capabilities(ownerId, id);
  }
  private async probeSaved(
    record: ConnectionRecord,
    ownerId: string,
    signal: AbortSignal | undefined,
    permission: ConnectionPermission,
    event: string,
  ): Promise<ProbeReport> {
    const id = record.metadata.id;
    if (!record.metadata.enabled) throw new ProviderError('connection_disabled');
    const credentials = this.secrets.open(
      record.sealedCredentials,
      credentialContext(this.access(ownerId).scope, id),
    );
    this.policy.validate(record.metadata.baseUrl);
    const report = await this.runProbe(
      { ...record.metadata, ...credentials },
      signal,
      this.admission(ownerId, permission, record, true),
    );
    record.metadata.lastProbe = report;
    record.policy = recordProbe(currentPolicy(record.policy), ownerId, report);
    if (!(await this.repository.replace(record, event)))
      throw new ProviderError('connection_conflict');
    return report;
  }

  async disable(ownerId: string, id: string): Promise<ConnectionMetadata> {
    const record = await this.owned(ownerId, id);
    record.metadata.enabled = false;
    if (!(await this.repository.replace(record, 'provider.connection_disabled')))
      throw new ProviderError('connection_conflict');
    return record.metadata;
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.owned(ownerId, id);
    if (!(await this.repository.delete(this.access(ownerId), id)))
      throw new ProviderError('connection_not_found');
  }

  private admission(
    actorUserId: string,
    permission: ConnectionPermission,
    expected?: ConnectionRecord,
    requiresEnabled = false,
  ): ProbeAdmission | undefined {
    return async () => {
      if (!expected) {
        await this.repository.authorize(this.access(actorUserId), permission);
        return;
      }
      const current = await this.owned(actorUserId, expected.metadata.id, permission);
      if ((permission === 'use' || requiresEnabled) && !current.metadata.enabled)
        throw new ProviderError('connection_disabled');
      if (current.revision !== expected.revision) throw new ProviderError('connection_conflict');
    };
  }

  private async runProbe(
    input: ProbeInput,
    signal?: AbortSignal,
    admission?: ProbeAdmission,
  ): Promise<ProbeReport> {
    if (signal?.aborted) throw new ProviderError('provider_cancelled');
    const report = await (admission
      ? this.probe.run(input, signal, admission)
      : this.probe.run(input, signal));
    if (signal?.aborted) throw new ProviderError('provider_cancelled');
    if ([report.text.code, report.action.code].includes('provider_url_not_allowed'))
      throw new ProviderError('provider_url_not_allowed');
    return {
      testedAt: report.testedAt,
      text: { ...report.text, raw: redactProviderText(report.text.raw, input) },
      action: { ...report.action, raw: redactProviderText(report.action.raw, input) },
    };
  }
}
