import {
  parseGroupRoutingCommand,
  parseGroupRoutingSetting,
  routingKeys,
  routingUuid,
  type GroupRoutingCommand,
  type GroupRoutingSetting,
} from '../routing-contract.js';
import { RoutingHttp, type RoutingResult } from './routing-http.js';
export class GroupRoutingApiClient {
  private readonly http: RoutingHttp;
  constructor(request: typeof fetch, baseUrl: string, webOrigin: string, signal?: AbortSignal) {
    this.http = new RoutingHttp(request, baseUrl, webOrigin, signal);
  }
  get(session: string | undefined, workspaceId: string, groupId: string) {
    return this.send(session, workspaceId, groupId);
  }
  async update(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    input: GroupRoutingCommand,
  ): Promise<RoutingResult<GroupRoutingSetting>> {
    const command = parseGroupRoutingCommand(input);
    if (!command) return { status: 'invalid' };
    const result = await this.send(session, workspaceId, groupId, command);
    if (result.status !== 'available') return result;
    const setting = result.value;
    if (
      !setting.canManage ||
      (setting.revision !== command.expectedRevision &&
        setting.revision !== command.expectedRevision + 1) ||
      (setting.defaultLead?.grantId ?? null) !== command.defaultGrantId ||
      setting.defaultLead?.closed
    )
      return { status: 'unavailable' };
    return result;
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    groupId: string,
    command?: GroupRoutingCommand,
  ): Promise<RoutingResult<GroupRoutingSetting>> {
    if (!routingUuid(workspaceId) || !routingUuid(groupId)) return { status: 'invalid' };
    const result = await this.http.send(
      session,
      `/api/v1/workspaces/${workspaceId.toLowerCase()}/groups/${groupId.toLowerCase()}/routing`,
      'setting',
      command,
    );
    if (result.status !== 'available') return result;
    const setting = routingKeys(result.value, 'routing')
      ? parseGroupRoutingSetting(result.value.routing, groupId)
      : undefined;
    return setting ? { status: 'available', value: setting } : { status: 'unavailable' };
  }
}
export function createGroupRoutingApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new GroupRoutingApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}
