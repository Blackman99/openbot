import type { RequestEvent } from '@sveltejs/kit';
import { createTaskApiClient } from './task-api.js';
import { clearSessionCookie, readSessionCookie } from './session-cookie.js';

export async function readTaskPartialOutput(
  context: Pick<RequestEvent, 'fetch' | 'request' | 'params' | 'cookies' | 'url'>,
): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store', vary: 'Cookie' };
  if (context.url.search)
    return Response.json({ error: { code: 'invalid_task_request' } }, { status: 400, headers });
  const { workspaceId = '', conversationId = '', taskId = '', runId = '' } = context.params;
  const result = await createTaskApiClient(context.fetch, context.request.signal).partialOutput(
    readSessionCookie(context.cookies),
    workspaceId,
    conversationId,
    taskId,
    runId,
  );
  if (result.status === 'available') return Response.json(result.value, { headers });
  if (result.status === 'anonymous') clearSessionCookie(context.cookies);
  const status =
    result.status === 'anonymous'
      ? 401
      : result.status === 'forbidden'
        ? 403
        : result.status === 'invalid'
          ? 400
          : result.status === 'partial-state-conflict'
            ? 409
            : 503;
  return Response.json(
    {
      error: {
        code:
          status === 401
            ? 'authentication_required'
            : status === 403
              ? 'task_forbidden'
              : status === 400
                ? 'invalid_task_request'
                : status === 409
                  ? 'task_partial_state_conflict'
                  : 'task_unavailable',
      },
    },
    { status, headers },
  );
}
