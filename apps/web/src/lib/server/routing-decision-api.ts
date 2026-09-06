import {
  parseRoutingDecision,
  parseRoutingSummary,
  routingKeys,
  routingUuid,
  type RoutingDecision,
  type RoutingSummary,
} from '../routing-contract.js';
import { RoutingHttp, type RoutingResult } from './routing-http.js';
export class RoutingDecisionApiClient {
  private readonly http: RoutingHttp;
  constructor(request: typeof fetch, baseUrl: string, webOrigin: string, signal?: AbortSignal) {
    this.http = new RoutingHttp(request, baseUrl, webOrigin, signal);
  }
  async getForTask(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    task: { id: string; routing?: RoutingSummary },
  ): Promise<RoutingResult<RoutingDecision | null>> {
    if (!routingUuid(workspaceId) || !routingUuid(conversationId) || !routingUuid(task.id))
      return { status: 'invalid' };
    if (task.routing === undefined) return { status: 'available', value: null };
    const summary = parseRoutingSummary(task.routing);
    if (!summary) return { status: 'invalid' };
    const result = await this.http.send(
      session,
      `/api/v1/workspaces/${workspaceId.toLowerCase()}/conversations/${conversationId.toLowerCase()}/tasks/${task.id.toLowerCase()}/routing`,
      'decision',
    );
    if (result.status !== 'available') return result;
    const decision = routingKeys(result.value, 'routing')
      ? parseRoutingDecision(result.value.routing)
      : undefined;
    return decision &&
      decision.algorithm === summary.algorithm &&
      decision.reason === summary.reason
      ? { status: 'available', value: decision }
      : { status: 'unavailable' };
  }
}
export function createRoutingDecisionApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new RoutingDecisionApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}
