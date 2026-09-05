import { randomUUID } from 'node:crypto';
import type { ConnectionProbe, ProbeInput, ProbeReport } from './openai-chat-probe.js';
import { ProviderSecretBox, redactProviderText } from './secrets.js';
import { ProviderError, ProviderUrlPolicy } from './url-policy.js';

export interface ConnectionInput {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  headers: Record<string, string>;
}
export interface ConnectionMetadata {
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
  metadata: ConnectionMetadata;
  ownerId: string;
  sealedCredentials: string;
  revision: number;
}
export interface ProviderRepository {
  insert(record: ConnectionRecord): Promise<void>;
  find(ownerId: string, id: string): Promise<ConnectionRecord | undefined>;
  list(ownerId: string): Promise<ConnectionRecord[]>;
  replace(record: ConnectionRecord, event: string): Promise<boolean>;
  delete(ownerId: string, id: string): Promise<boolean>;
}

export function parseConnectionInput(value: unknown): ConnectionInput {
  const invalid = () => {
    throw new ProviderError('invalid_connection');
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
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
  if (/[^\x20-\x7e]/u.test(apiKey) || (apiKey && headers.authorization)) return invalid();
  return {
    name,
    modelId,
    apiKey,
    headers,
    baseUrl: (input.baseUrl as string).trim().replace(/\/+$/u, ''),
  };
}

export class ProviderConnections {
  constructor(
    private readonly repository: ProviderRepository,
    private readonly secrets: ProviderSecretBox,
    private readonly policy: ProviderUrlPolicy,
    private readonly probe: ConnectionProbe,
  ) {}

  async save(ownerId: string, value: unknown, signal?: AbortSignal): Promise<ConnectionMetadata> {
    const input = parseConnectionInput(value);
    this.policy.validate(input.baseUrl);
    const report = await this.runProbe(input, signal);
    const id = randomUUID();
    const metadata: ConnectionMetadata = {
      id,
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      enabled: report.text.ok,
      apiKeyConfigured: Boolean(input.apiKey),
      headerNames: Object.keys(input.headers).sort(),
      lastProbe: report,
    };
    await this.repository.insert({
      ownerId,
      metadata,
      revision: 0,
      sealedCredentials: this.secrets.seal(
        { apiKey: input.apiKey, headers: input.headers },
        `${ownerId}/${id}`,
      ),
    });
    return metadata;
  }

  async get(ownerId: string, id: string): Promise<ConnectionMetadata> {
    const record = await this.repository.find(ownerId, id);
    if (!record) throw new ProviderError('connection_not_found');
    return record.metadata;
  }

  async list(ownerId: string): Promise<ConnectionMetadata[]> {
    return (await this.repository.list(ownerId)).map((record) => record.metadata);
  }

  private async owned(ownerId: string, id: string): Promise<ConnectionRecord> {
    const record = await this.repository.find(ownerId, id);
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
    const existing = this.secrets.open(record.sealedCredentials, `${ownerId}/${id}`);
    const input = parseConnectionInput({ ...record.metadata, ...existing, ...value });
    this.policy.validate(input.baseUrl);
    const report = await this.runProbe(input, signal);
    const metadata: ConnectionMetadata = {
      id,
      name: input.name,
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      enabled: report.text.ok,
      apiKeyConfigured: Boolean(input.apiKey),
      headerNames: Object.keys(input.headers).sort(),
      lastProbe: report,
    };
    const sealedCredentials = this.secrets.seal(
      { apiKey: input.apiKey, headers: input.headers },
      `${ownerId}/${id}`,
    );
    if (
      !(await this.repository.replace(
        { ownerId, metadata, sealedCredentials, revision: record.revision },
        'provider.connection_updated',
      ))
    )
      throw new ProviderError('connection_conflict');
    return metadata;
  }

  async test(ownerId: string, id: string, signal?: AbortSignal): Promise<ProbeReport> {
    const record = await this.owned(ownerId, id);
    if (!record.metadata.enabled) throw new ProviderError('connection_disabled');
    const credentials = this.secrets.open(record.sealedCredentials, `${ownerId}/${id}`);
    this.policy.validate(record.metadata.baseUrl);
    const report = await this.runProbe({ ...record.metadata, ...credentials }, signal);
    record.metadata.lastProbe = report;
    if (!(await this.repository.replace(record, 'provider.connection_tested')))
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
    if (!(await this.repository.delete(ownerId, id)))
      throw new ProviderError('connection_not_found');
  }

  private async runProbe(input: ProbeInput, signal?: AbortSignal): Promise<ProbeReport> {
    if (signal?.aborted) throw new ProviderError('provider_cancelled');
    const report = await this.probe.run(input, signal);
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
