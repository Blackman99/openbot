import {
  MAX_STREAM_PREVIEW_BYTES,
  MAX_STREAM_PREVIEWS,
  parseConversationStreamBootstrap,
  parseConversationStreamCursor,
  parseConversationStreamEvent,
  parseMessageReference,
  type ConversationStreamBootstrap,
  type ConversationStreamEvent,
  type ConversationStreamScope,
  type ExecutionState,
  type MessageReference,
  type StreamPreview,
} from './conversation-stream-contract.js';
import { parseTaskPartialOutput, type TaskPartialOutput } from './task-partial-output.js';
export interface StreamPreviewState extends StreamPreview {
  status: 'streaming' | 'unavailable' | 'interrupted';
}
export interface ConversationMessageRevision {
  id: string;
  creationSequence: number;
  versionEventId: string;
  sequence: number;
  deleted: boolean;
}
export interface ConversationStreamState {
  scope: ConversationStreamScope;
  acknowledgedCursor: string;
  acknowledgedSequence: number;
  messages: Readonly<Record<string, MessageReference>>;
  executions: Readonly<Record<string, ExecutionState>>;
  previews: Readonly<Record<string, StreamPreviewState>>;
  previewsTruncated: boolean;
  pendingMessage: { cursor: string; sequence: number; reference: MessageReference } | null;
}
export interface ConversationStreamTransition {
  status: 'applied' | 'duplicate' | 'resolve-message' | 'blocked' | 'resync-required';
  state: ConversationStreamState;
  reference?: MessageReference;
  cursor?: string;
  clearMessageId?: string;
}
export function createConversationStreamState(
  bootstrap: ConversationStreamBootstrap,
): ConversationStreamState {
  const cursor = parseConversationStreamCursor(bootstrap.cursor);
  const parsed = cursor && parseConversationStreamBootstrap(JSON.stringify(bootstrap), cursor);
  if (!cursor || !parsed) throw new Error('invalid_stream_bootstrap');
  // The caller resolves bootstrap references before subscribing after this H.
  // This module retains references only; it never owns a captured message body.
  return {
    scope: { workspaceId: cursor.workspaceId, conversationId: cursor.conversationId },
    acknowledgedCursor: parsed.cursor,
    acknowledgedSequence: cursor.after,
    messages: Object.fromEntries(parsed.messages.map((message) => [message.messageId, message])),
    executions: Object.fromEntries(
      parsed.executions.map((execution) => [execution.runId, execution]),
    ),
    previews: Object.fromEntries(
      parsed.previews.map((preview) => [preview.runId, { ...preview, status: 'streaming' }]),
    ),
    previewsTruncated: parsed.previewsTruncated,
    pendingMessage: null,
  };
}
export function applyConversationStreamEvent(
  state: ConversationStreamState,
  input: ConversationStreamEvent,
): ConversationStreamTransition {
  const event = parseConversationStreamEvent(input, state.scope);
  if (!event) return { status: 'resync-required', state };
  if (event.sequence <= state.acknowledgedSequence) return { status: 'duplicate', state };
  if (state.pendingMessage) {
    const pending = state.pendingMessage;
    if (event.cursor !== pending.cursor)
      return { status: 'blocked', state, reference: pending.reference, cursor: pending.cursor };
    if (event.type !== 'message.changed') return { status: 'resync-required', state };
    const incoming = event.data.message,
      previous = pending.reference;
    if (
      incoming.messageId !== previous.messageId ||
      incoming.creationSequence !== previous.creationSequence ||
      incoming.taskId !== previous.taskId ||
      incoming.runId !== previous.runId ||
      (incoming.sequence === previous.sequence &&
        (incoming.versionEventId !== previous.versionEventId ||
          (previous.deleted && !incoming.deleted)))
    )
      return { status: 'resync-required', state };
    const reference = incoming.sequence >= previous.sequence ? incoming : previous;
    if (previous.deleted && !reference.deleted) return { status: 'resync-required', state };
    // Reconnect resumes after the last acknowledgement, so the unresolved
    // reference must be retryable rather than permanently blocking its replay.
    return {
      status: 'resolve-message',
      reference,
      cursor: pending.cursor,
      ...(reference.deleted ? { clearMessageId: reference.messageId } : {}),
      state: { ...state, pendingMessage: { ...pending, reference } },
    };
  }
  if (event.sequence !== state.acknowledgedSequence + 1)
    return { status: 'resync-required', state };
  if (event.type === 'message.changed') {
    const reference = event.data.message;
    const previous = state.messages[reference.messageId];
    if (
      previous &&
      (previous.creationSequence !== reference.creationSequence ||
        previous.taskId !== reference.taskId ||
        previous.runId !== reference.runId)
    )
      return { status: 'resync-required', state };
    const previews = { ...state.previews };
    if (reference.runId) delete previews[reference.runId];
    return {
      status: 'resolve-message',
      reference,
      cursor: event.cursor,
      ...(reference.deleted ? { clearMessageId: reference.messageId } : {}),
      state: {
        ...state,
        previews,
        pendingMessage: { cursor: event.cursor, sequence: event.sequence, reference },
      },
    };
  }
  if (event.type === 'conversation.invalidated' || event.type === 'task.limit.warning')
    return applied(state, event);
  if (event.type === 'task.run.updated') {
    const execution = event.data.execution,
      previous = state.executions[execution.runId];
    if (
      previous &&
      (!sameExecution(previous, execution) ||
        rank(execution.runStatus) < rank(previous.runStatus) ||
        (rank(previous.runStatus) === 2 &&
          (execution.runStatus !== previous.runStatus ||
            JSON.stringify(execution.output) !== JSON.stringify(previous.output))))
    )
      return { status: 'resync-required', state };
    const previews = { ...state.previews },
      preview = previews[execution.runId];
    if (preview && (preview.taskId !== execution.taskId || preview.attempt !== execution.attempt))
      return { status: 'resync-required', state };
    if (execution.runStatus === 'cancelled') {
      if (preview?.status === 'streaming')
        previews[execution.runId] = { ...preview, status: 'interrupted' };
    } else if (rank(execution.runStatus) === 2) delete previews[execution.runId];
    const executions = { ...state.executions, [execution.runId]: execution };
    // Visible interrupted output still needs its author and terminal fence.
    // At most eight previews are visible, leaving room in this 64-Run cache.
    const withoutVisiblePreview = (run: ExecutionState) =>
      !previews[run.runId] || previews[run.runId]?.status === 'unavailable';
    const removed = trimRuns(
      executions,
      (run) => rank(run.runStatus) === 2 && withoutVisiblePreview(run),
      withoutVisiblePreview,
    );
    if (removed) delete previews[removed];
    return applied(state, event, { executions, previews });
  }
  const delta = event.data,
    execution = state.executions[delta.runId],
    previous = state.previews[delta.runId];
  if (
    (execution && (execution.taskId !== delta.taskId || execution.attempt !== delta.attempt)) ||
    (previous && (previous.taskId !== delta.taskId || previous.attempt !== delta.attempt))
  )
    return { status: 'resync-required', state };
  if (
    (execution && rank(execution.runStatus) === 2) ||
    Object.values(state.messages).some((message) => message.runId === delta.runId)
  )
    return applied(state, event);
  const previews = { ...state.previews };
  if (previous?.status === 'unavailable') {
    previews[delta.runId] = { ...previous, endByte: Math.max(previous.endByte, delta.endByte) };
    return applied(state, event, { previews });
  }
  if (previous && delta.endByte <= previous.endByte) {
    const stored = new TextEncoder().encode(previous.text).subarray(delta.startByte, delta.endByte);
    try {
      if (new TextDecoder('utf-8', { fatal: true }).decode(stored) === delta.text)
        return applied(state, event);
    } catch {
      // Offsets inside a codepoint cannot prove an identical UTF-8 replay.
    }
  }
  const available = Object.values(previews).filter((preview) => preview.status !== 'unavailable');
  const bytes = available.reduce((sum, preview) => sum + preview.endByte, 0);
  const contiguous = delta.startByte === (previous?.endByte ?? 0);
  const fits =
    (previous !== undefined || available.length < MAX_STREAM_PREVIEWS) &&
    bytes + delta.endByte - delta.startByte <= MAX_STREAM_PREVIEW_BYTES;
  if (contiguous && fits)
    previews[delta.runId] = {
      taskId: delta.taskId,
      runId: delta.runId,
      attempt: delta.attempt,
      endByte: delta.endByte,
      text: (previous?.text ?? '') + delta.text,
      status: 'streaming',
    };
  else
    previews[delta.runId] = {
      taskId: delta.taskId,
      runId: delta.runId,
      attempt: delta.attempt,
      endByte: Math.max(previous?.endByte ?? 0, delta.endByte),
      text: '',
      status: 'unavailable',
    };
  // Missing/expired/omitted prefixes are not stream-sequence gaps. Acknowledge
  // the valid delta, keep no invented suffix, and wait for the final reference.
  trimRuns(previews, (preview) => preview.status === 'unavailable');
  return applied(state, event, {
    previews,
    previewsTruncated: state.previewsTruncated || previews[delta.runId]?.status === 'unavailable',
  });
}
export function resolveCancelledTaskPartial(
  state: ConversationStreamState,
  input: TaskPartialOutput,
): ConversationStreamState {
  const execution = state.executions[input.runId];
  const parsed =
    execution &&
    parseTaskPartialOutput(input, {
      conversationId: state.scope.conversationId,
      taskId: execution.taskId,
      runId: execution.runId,
    });
  if (!parsed || execution?.runStatus !== 'cancelled')
    throw new Error('invalid_cancelled_task_partial');
  const previews = { ...state.previews };
  delete previews[execution.runId];
  if (parsed.partial === null) return { ...state, previews };
  const visible = Object.values(previews).filter((p) => p.status !== 'unavailable');
  const fits =
    visible.length < MAX_STREAM_PREVIEWS &&
    visible.reduce((sum, p) => sum + p.endByte, 0) + parsed.partial.endByte <=
      MAX_STREAM_PREVIEW_BYTES;
  previews[execution.runId] = {
    taskId: execution.taskId,
    runId: execution.runId,
    attempt: execution.attempt,
    text: fits ? parsed.partial.text : '',
    endByte: parsed.partial.endByte,
    status: fits ? 'interrupted' : 'unavailable',
  };
  trimRuns(previews, (p) => p.status === 'unavailable');
  return { ...state, previews, previewsTruncated: state.previewsTruncated || !fits };
}
export function resolveConversationStreamMessage(
  state: ConversationStreamState,
  cursor: string,
  revision: ConversationMessageRevision,
): ConversationStreamTransition {
  const position = parseConversationStreamCursor(cursor, state.scope);
  if (!position) return { status: 'resync-required', state };
  if (position.after <= state.acknowledgedSequence) return { status: 'duplicate', state };
  const pending = state.pendingMessage;
  if (!pending || pending.cursor !== cursor) return { status: 'resync-required', state };
  const reference = pending.reference,
    previous = state.messages[reference.messageId];
  const current = parseMessageReference({
    ...reference,
    messageId: revision.id,
    creationSequence: revision.creationSequence,
    versionEventId: revision.versionEventId,
    sequence: revision.sequence,
    deleted: revision.deleted,
  });
  if (
    !current ||
    current.messageId !== reference.messageId ||
    current.creationSequence !== reference.creationSequence ||
    current.sequence < Math.max(reference.sequence, previous?.sequence ?? 0) ||
    ((reference.deleted || previous?.deleted) && !current.deleted) ||
    // A permanent purge hides the source without rewriting its immutable
    // version event. Allow that monotonic deletion marker, never resurrection.
    (current.sequence === reference.sequence &&
      current.versionEventId !== reference.versionEventId) ||
    (current.sequence > reference.sequence && current.versionEventId === reference.versionEventId)
  )
    return { status: 'resync-required', state };
  const messages = { ...state.messages, [current.messageId]: current };
  // Ordinary paginated projections belong to the caller. Bound this reference
  // cache while retaining stable message identity for every upsert we return.
  if (Object.keys(messages).length > 1000) {
    const oldest = Object.values(messages).sort(
      (a, b) => a.creationSequence - b.creationSequence,
    )[0];
    if (oldest) delete messages[oldest.messageId];
  }
  return {
    status: 'applied',
    reference: current,
    state: {
      ...state,
      messages,
      pendingMessage: null,
      acknowledgedCursor: pending.cursor,
      acknowledgedSequence: pending.sequence,
    },
  };
}
function applied(
  state: ConversationStreamState,
  event: ConversationStreamEvent,
  changes: Partial<ConversationStreamState> = {},
): ConversationStreamTransition {
  return {
    status: 'applied',
    state: {
      ...state,
      ...changes,
      acknowledgedCursor: event.cursor,
      acknowledgedSequence: event.sequence,
    },
  };
}
function rank(status: ExecutionState['runStatus']) {
  return status === 'queued' ? 0 : status === 'running' ? 1 : 2;
}
function sameExecution(a: ExecutionState, b: ExecutionState) {
  return (
    a.taskId === b.taskId &&
    a.attempt === b.attempt &&
    a.bot.id === b.bot.id &&
    a.bot.versionId === b.bot.versionId &&
    a.bot.versionNumber === b.bot.versionNumber &&
    a.executionUser.id === b.executionUser.id &&
    a.createdAt === b.createdAt &&
    (a.startedAt === null || a.startedAt === b.startedAt)
  );
}
function trimRuns<T>(
  runs: Record<string, T>,
  disposable: (value: T) => boolean,
  fallback: (value: T) => boolean = () => true,
) {
  const entries = Object.entries(runs);
  if (entries.length > 64) {
    const selected =
      entries.find(([, value]) => disposable(value)) ??
      entries.find(([, value]) => fallback(value)) ??
      entries[0];
    if (selected) {
      delete runs[selected[0]];
      return selected[0];
    }
  }
}
