import { SESSION_COOKIE_NAME } from './auth-api.js';
import { isCommandKey, isConversationUuid, isConversationCursor } from './conversation-api.js';
import {
  parseTask,
  parseTaskRun,
  taskKeys,
  taskText,
  taskInteger,
  type TaskPage,
  type TaskView,
  type TaskRun,
} from './task-contract.js';
export type { TaskPage, TaskView, TaskRun, TaskStatus, TaskErrorCode } from './task-contract.js';
export interface TaskCommand {
  idempotencyKey: string;
  body: string;
  groupGrantId?: string;
}
export interface TaskRetryCommand {
  idempotencyKey: string;
  expectedRunId: string;
}
export interface TaskRetryResult {
  task: TaskView;
  receipt: { runId: string; attempt: number };
}
export interface TaskRunsPage {
  conversationId: string;
  taskId: string;
  runs: TaskRun[];
  nextCursor: string | null;
}
export type TaskResult<T> =
  | { status: 'available'; value: T }
  | {
      status:
        | 'anonymous'
        | 'invalid'
        | 'forbidden'
        | 'idempotency-conflict'
        | 'model-unavailable'
        | 'retry-state-conflict'
        | 'retry-run-conflict'
        | 'attempt-exhausted'
        | 'routing-unavailable'
        | 'unavailable';
    };
async function readJson(response: Response, controller: AbortController): Promise<unknown> {
  const maximum = response.ok ? 1024 * 1024 : 16 * 1024;
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  controller.signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      controller.signal.throwIfAborted();
      const next = await reader.read();
      controller.signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new Error('response_too_large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    controller.signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
export class TaskApiClient {
  constructor(
    private readonly request: typeof fetch,
    private readonly baseUrl: string,
    private readonly webOrigin: string,
    private readonly externalSignal?: AbortSignal,
  ) {}
  async list(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<TaskResult<TaskPage>> {
    if (
      Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)) ||
      (query.cursor !== undefined && !isConversationCursor(query.cursor)) ||
      (query.limit !== undefined && (!taskInteger(query.limit) || query.limit > 50))
    )
      return { status: 'invalid' };
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const result = await this.send(
      session,
      workspaceId,
      conversationId,
      params.size ? '?' + params : '',
    );
    if (result.status !== 'available') return result;
    const value = result.value;
    if (
      !taskKeys(value, 'conversationId,nextCursor,tasks') ||
      !isConversationUuid(value.conversationId) ||
      value.conversationId.toLowerCase() !== conversationId.toLowerCase() ||
      !Array.isArray(value.tasks) ||
      value.tasks.length > (query.limit ?? 20) ||
      (value.nextCursor !== null && !isConversationCursor(value.nextCursor))
    )
      return { status: 'unavailable' };
    const tasks: TaskView[] = [],
      ids = new Set<string>();
    for (const row of value.tasks) {
      const task = parseTask(row, conversationId);
      if (
        !task ||
        ids.has(task.id) ||
        (tasks.at(-1)?.trigger.sequence ?? 0) >= task.trigger.sequence
      )
        return { status: 'unavailable' };
      tasks.push(task);
      ids.add(task.id);
    }
    return {
      status: 'available',
      value: {
        conversationId: value.conversationId.toLowerCase(),
        tasks,
        nextCursor: value.nextCursor,
      },
    };
  }
  async get(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    taskId: string,
  ): Promise<TaskResult<TaskView>> {
    if (!isConversationUuid(taskId)) return { status: 'invalid' };
    const result = await this.send(
      session,
      workspaceId,
      conversationId,
      '/' + taskId.toLowerCase(),
    );
    if (result.status !== 'available') return result;
    const task = taskKeys(result.value, 'task')
      ? parseTask(result.value.task, conversationId)
      : undefined;
    return task?.id === taskId.toLowerCase()
      ? { status: 'available', value: task }
      : { status: 'unavailable' };
  }
  async submit(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    command: TaskCommand,
  ): Promise<TaskResult<TaskView>> {
    if (
      !isCommandKey(command.idempotencyKey) ||
      !taskText(command.body, 32000) ||
      Object.keys(command).some(
        (key) => !['idempotencyKey', 'body', 'groupGrantId'].includes(key),
      ) ||
      (command.groupGrantId !== undefined && !isConversationUuid(command.groupGrantId))
    )
      return { status: 'invalid' };
    const result = await this.send(session, workspaceId, conversationId, '', {
      idempotencyKey: command.idempotencyKey,
      body: command.body,
      ...(command.groupGrantId === undefined
        ? {}
        : { groupGrantId: command.groupGrantId.toLowerCase() }),
    });
    if (result.status !== 'available') return result;
    const task = taskKeys(result.value, 'task')
      ? parseTask(result.value.task, conversationId)
      : undefined;
    if (!task) return { status: 'unavailable' };
    const matchesCommand =
      command.groupGrantId === undefined
        ? (task.groupGrantId === null && task.routing === undefined) ||
          (task.groupGrantId !== null &&
            (task.routing?.reason === 'default' || task.routing?.reason === 'local-match'))
        : task.groupGrantId === command.groupGrantId.toLowerCase() &&
          (task.routing === undefined || task.routing.reason === 'mention');
    return matchesCommand ? { status: 'available', value: task } : { status: 'unavailable' };
  }
  async retry(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    command: TaskRetryCommand,
  ): Promise<TaskResult<TaskRetryResult>> {
    if (
      !isConversationUuid(taskId) ||
      !taskKeys(command, 'expectedRunId,idempotencyKey') ||
      !isCommandKey(command.idempotencyKey) ||
      !isConversationUuid(command.expectedRunId)
    )
      return { status: 'invalid' };
    const result = await this.send(
      session,
      workspaceId,
      conversationId,
      '/' + taskId.toLowerCase() + '/retries',
      {
        idempotencyKey: command.idempotencyKey,
        expectedRunId: command.expectedRunId.toLowerCase(),
      },
    );
    if (result.status !== 'available') return result;
    if (!taskKeys(result.value, 'receipt,task')) return { status: 'unavailable' };
    const task = parseTask(result.value.task, conversationId),
      receipt = result.value.receipt;
    if (
      !task ||
      task.id !== taskId.toLowerCase() ||
      !taskKeys(receipt, 'attempt,runId') ||
      !isConversationUuid(receipt.runId) ||
      !taskInteger(receipt.attempt, 2) ||
      receipt.attempt > task.runCount ||
      receipt.runId.toLowerCase() === command.expectedRunId.toLowerCase() ||
      (receipt.attempt === task.runCount) !== (receipt.runId.toLowerCase() === task.runs[0]?.id)
    )
      return { status: 'unavailable' };
    return {
      status: 'available',
      value: {
        task,
        receipt: { runId: receipt.runId.toLowerCase(), attempt: receipt.attempt },
      },
    };
  }
  async runs(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    taskId: string,
    query: { cursor?: string; limit?: number } = {},
  ): Promise<TaskResult<TaskRunsPage>> {
    if (
      !isConversationUuid(taskId) ||
      Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)) ||
      (query.cursor !== undefined && !isConversationCursor(query.cursor)) ||
      (query.limit !== undefined && (!taskInteger(query.limit) || query.limit > 50))
    )
      return { status: 'invalid' };
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const result = await this.send(
      session,
      workspaceId,
      conversationId,
      '/' + taskId.toLowerCase() + '/runs' + (params.size ? '?' + params : ''),
    );
    if (result.status !== 'available') return result;
    const value = result.value;
    if (
      !taskKeys(value, 'conversationId,nextCursor,runs,taskId') ||
      !isConversationUuid(value.conversationId) ||
      value.conversationId.toLowerCase() !== conversationId.toLowerCase() ||
      !isConversationUuid(value.taskId) ||
      value.taskId.toLowerCase() !== taskId.toLowerCase() ||
      !Array.isArray(value.runs) ||
      value.runs.length > (query.limit ?? 20) ||
      (value.nextCursor !== null &&
        (!isConversationCursor(value.nextCursor) || value.runs.length === 0))
    )
      return { status: 'unavailable' };
    const runs: TaskRun[] = [],
      ids = new Set<string>();
    for (const row of value.runs) {
      const run = parseTaskRun(row);
      if (!run || ids.has(run.id) || (runs.at(-1)?.attempt ?? Infinity) <= run.attempt)
        return { status: 'unavailable' };
      runs.push(run);
      ids.add(run.id);
    }
    return {
      status: 'available',
      value: {
        conversationId: value.conversationId.toLowerCase(),
        taskId: value.taskId.toLowerCase(),
        runs,
        nextCursor: value.nextCursor,
      },
    };
  }
  private async send(
    session: string | undefined,
    workspaceId: string,
    conversationId: string,
    suffix: string,
    body?: TaskCommand | TaskRetryCommand,
  ): Promise<TaskResult<unknown>> {
    if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
    if (!isConversationUuid(workspaceId) || !isConversationUuid(conversationId))
      return { status: 'invalid' };
    if (this.externalSignal?.aborted) return { status: 'unavailable' };
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    const abort = () => controller.abort();
    this.externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.request(
        this.baseUrl.replace(/\/$/u, '') +
          '/api/v1/workspaces/' +
          workspaceId.toLowerCase() +
          '/conversations/' +
          conversationId.toLowerCase() +
          '/tasks' +
          suffix,
        {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            origin: new URL(this.webOrigin).origin,
            cookie: SESSION_COOKIE_NAME + '=' + session,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (response.status === 401) return { status: 'anonymous' };
      const payload = await readJson(response, controller);
      if (taskKeys(payload, 'error') && taskKeys(payload.error, 'code')) {
        const code = payload.error.code;
        if (response.status === 403 && (code === 'task_forbidden' || code === 'invalid_origin'))
          return { status: 'forbidden' };
        if ([400, 413, 415].includes(response.status) && code === 'invalid_task_request')
          return { status: 'invalid' };
        if (response.status === 409 && code === 'idempotency_conflict')
          return { status: 'idempotency-conflict' };
        if (response.status === 409 && code === 'no_eligible_bot')
          return { status: 'routing-unavailable' };
        if (response.status === 409 && code === 'task_model_unavailable')
          return { status: 'model-unavailable' };
        if (response.status === 409 && code === 'task_retry_state_conflict')
          return { status: 'retry-state-conflict' };
        if (response.status === 409 && code === 'task_retry_run_conflict')
          return { status: 'retry-run-conflict' };
        if (response.status === 409 && code === 'task_attempt_exhausted')
          return { status: 'attempt-exhausted' };
      }

      return response.status === (body === undefined ? 200 : 202)
        ? { status: 'available', value: payload }
        : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      this.externalSignal?.removeEventListener('abort', abort);
      controller.abort();
      clearTimeout(timer);
    }
  }
}
export function createTaskApiClient(request: typeof fetch, signal?: AbortSignal) {
  return new TaskApiClient(
    request,
    process.env.API_BASE_URL ?? 'http://localhost:3001',
    process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    signal,
  );
}
