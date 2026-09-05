import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { createBotApiClient } from './bot-api.js';
import { createConversationApiClient, isCommandKey, isConversationUuid } from './conversation-api.js';
import { createGroupApiClient } from './group-api.js';
import {
  createMemoryApiClient,
  type CandidateDestination,
  type CandidateReviewPreview,
  type MemoryCandidate,
} from './memory-api.js';
import { requireConversationWorkspace } from './conversation-page.js';
import { readSessionCookie } from './session-cookie.js';

type Context = Pick<RequestEvent, 'cookies' | 'fetch' | 'setHeaders'>;
type ReviewAction = 'editCandidate' | 'rejectCandidate' | 'approveCandidate' | 'previewCandidate' | 'confirmCandidate';

function readFailure(status: string, context: Context): never {
  if (status === 'anonymous') {
    redirect(303, '/sign-in');
  }
  if (status === 'forbidden' || status === 'not-found')
    error(403, 'This conversation is not available with your current access.');
  if (status === 'invalid') error(400, 'Invalid memory review request');
  error(503, 'Memory review unavailable');
}

function validOrigin(request: Request) {
  return (
    request.headers.get('origin') ===
    new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin
  );
}

async function formValues(request: Request, allowed: string[]) {
  const values: Record<string, string> = {},
    form = await request.formData();
  for (const [key, value] of form) {
    if (
      !allowed.includes(key) ||
      typeof value !== 'string' ||
      form.getAll(key).length !== 1 ||
      value.length > 1000
    )
      throw new Error('Invalid memory review form');
    values[key] = value;
  }
  return values;
}

function actionFailure(
  status: string,
  context: Context,
  action: ReviewAction,
  values: Record<string, string>,
  preview?: CandidateReviewPreview,
) {
  if (status === 'anonymous') readFailure(status, context);
  const conflict = status === 'idempotency-conflict' || status === 'version-conflict';
  return fail(status === 'forbidden' ? 403 : status === 'invalid' ? 400 : conflict ? 409 : 503, {
    action,
    values,
    conflict,
    ...(preview ? { preview } : {}),
    error:
      status === 'forbidden'
        ? 'Your current conversation or destination access no longer allows this review.'
        : status === 'invalid'
          ? 'Choose a pending candidate, an explicit destination, and a confidence estimate between 0 and 1.'
          : status === 'version-conflict'
            ? 'This candidate changed. Refresh the inbox before reviewing it again.'
            : status === 'idempotency-conflict'
              ? 'This command key already has different choices. Refresh before reviewing another candidate.'
              : 'The result could not be confirmed. Retry the unchanged form with the same command key.',
  });
}

export function destinationFrom(
  values: Record<string, string>,
  workspaceId: string,
): CandidateDestination | undefined {
  const raw = values.destination ?? '';
  const match = /^(group|bot|workspace):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(
    raw,
  );
  if (!match) return undefined;
  const kind = match[1] as CandidateDestination['kind'];
  const id = match[2]!.toLowerCase();
  if (kind === 'workspace' && id !== workspaceId.toLowerCase()) return undefined;
  return { kind, id };
}

export function sameOriginGroup(
  subject: { kind: string; id: string },
  destination: CandidateDestination,
) {
  return subject.kind === 'group' && destination.kind === 'group' && destination.id === subject.id;
}

export async function loadCandidatesPage(
  context: Context & Pick<RequestEvent, 'url'>,
  workspaceId: string,
  conversationId: string,
) {
  const page = await requireConversationWorkspace(context, workspaceId);
  if (!isConversationUuid(conversationId)) readFailure('invalid', context);
  const session = readSessionCookie(context.cookies);
  const conversation = await createConversationApiClient(context.fetch).get(
    session,
    workspaceId,
    conversationId,
    { limit: 1 },
  );
  if (conversation.status !== 'available') readFailure(conversation.status, context);
  const [candidates, groups, bots] = await Promise.all([
    createMemoryApiClient(context.fetch).listCandidates(session, { workspaceId, conversationId }),
    createGroupApiClient(context.fetch).list(session, workspaceId),
    createBotApiClient(context.fetch).list(session, workspaceId),
  ]);
  if (candidates.status !== 'available') readFailure(candidates.status, context);
  if (groups.status !== 'available') readFailure(groups.status, context);
  if (bots.status !== 'available') readFailure(bots.status, context);
  return {
    ...page,
    conversation: conversation.value.conversation,
    candidatePage: candidates.value,
    destinationGroups: groups.value.filter((group) => group.role !== null),
    destinationBots: bots.value.filter(
      (bot) =>
        bot.lifecycleState === 'active' &&
        (bot.accessRole === 'owner' || bot.accessRole === 'editor'),
    ),
    canApproveWorkspace:
      page.workspace.role === 'owner' || page.workspace.role === 'administrator',
  };
}

export async function editCandidateAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  conversationId: string,
) {
  if (!validOrigin(context.request)) return actionFailure('forbidden', context, 'editCandidate', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['candidateId', 'expectedRevision', 'body']);
  } catch {
    return actionFailure('invalid', context, 'editCandidate', {});
  }
  const revision = Number(values.expectedRevision);
  if (
    !isConversationUuid(values.candidateId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !values.body?.trim()
  )
    return actionFailure('invalid', context, 'editCandidate', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).editCandidate(
    readSessionCookie(context.cookies),
    { workspaceId, conversationId },
    values.candidateId,
    { expectedRevision: revision, body: values.body },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'editCandidate', values);
  redirect(303, inboxPath(workspaceId, conversationId));
}

export async function rejectCandidateAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  conversationId: string,
) {
  if (!validOrigin(context.request))
    return actionFailure('forbidden', context, 'rejectCandidate', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, [
      'candidateId',
      'expectedRevision',
      'idempotencyKey',
    ]);
  } catch {
    return actionFailure('invalid', context, 'rejectCandidate', {});
  }
  const revision = Number(values.expectedRevision);
  if (
    !isConversationUuid(values.candidateId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !isCommandKey(values.idempotencyKey)
  )
    return actionFailure('invalid', context, 'rejectCandidate', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).rejectCandidate(
    readSessionCookie(context.cookies),
    { workspaceId, conversationId },
    values.candidateId,
    { expectedRevision: revision, idempotencyKey: values.idempotencyKey },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'rejectCandidate', values);
  redirect(303, inboxPath(workspaceId, conversationId));
}

export async function approveCandidateAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  conversationId: string,
) {
  if (!validOrigin(context.request))
    return actionFailure('forbidden', context, 'approveCandidate', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, [
      'candidateId',
      'expectedRevision',
      'destination',
      'confidence',
      'idempotencyKey',
    ]);
  } catch {
    return actionFailure('invalid', context, 'approveCandidate', {});
  }
  const destination = destinationFrom(values, workspaceId);
  const revision = Number(values.expectedRevision);
  const confidence = Number(values.confidence);
  if (
    !isConversationUuid(values.candidateId) ||
    !destination ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    !isCommandKey(values.idempotencyKey)
  )
    return actionFailure('invalid', context, 'approveCandidate', values);
  const conversation = await createConversationApiClient(context.fetch).get(
    readSessionCookie(context.cookies),
    workspaceId,
    conversationId,
    { limit: 1 },
  );
  if (conversation.status !== 'available')
    return actionFailure(conversation.status, context, 'approveCandidate', values);
  if (!sameOriginGroup(conversation.value.conversation.subject, destination))
    return actionFailure('invalid', context, 'approveCandidate', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).approveCandidate(
    readSessionCookie(context.cookies),
    { workspaceId, conversationId },
    values.candidateId,
    {
      expectedRevision: revision,
      destination,
      confidence,
      idempotencyKey: values.idempotencyKey,
    },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'approveCandidate', values);
  redirect(303, inboxPath(workspaceId, conversationId));
}

export async function previewCandidateAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  conversationId: string,
) {
  if (!validOrigin(context.request))
    return actionFailure('forbidden', context, 'previewCandidate', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, [
      'candidateId',
      'expectedRevision',
      'destination',
      'confidence',
    ]);
  } catch {
    return actionFailure('invalid', context, 'previewCandidate', {});
  }
  const destination = destinationFrom(values, workspaceId);
  const revision = Number(values.expectedRevision);
  const confidence = Number(values.confidence);
  if (
    !isConversationUuid(values.candidateId) ||
    !destination ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    return actionFailure('invalid', context, 'previewCandidate', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).previewCandidate(
    readSessionCookie(context.cookies),
    { workspaceId, conversationId },
    values.candidateId,
    { expectedRevision: revision, destination, confidence },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'previewCandidate', values);
  return {
    action: 'previewCandidate' as const,
    values,
    conflict: false,
    error: '',
    preview: result.value,
  };
}

export async function confirmCandidateAction(
  context: Context & Pick<RequestEvent, 'request'>,
  workspaceId: string,
  conversationId: string,
) {
  if (!validOrigin(context.request))
    return actionFailure('forbidden', context, 'confirmCandidate', {});
  let values: Record<string, string>;
  try {
    values = await formValues(context.request, ['candidateId', 'intentId', 'idempotencyKey']);
  } catch {
    return actionFailure('invalid', context, 'confirmCandidate', {});
  }
  if (
    !isConversationUuid(values.candidateId) ||
    !isConversationUuid(values.intentId) ||
    !isCommandKey(values.idempotencyKey)
  )
    return actionFailure('invalid', context, 'confirmCandidate', values);
  const result = await createMemoryApiClient(context.fetch, context.request.signal).confirmCandidate(
    readSessionCookie(context.cookies),
    { workspaceId, conversationId },
    values.candidateId,
    { intentId: values.intentId, idempotencyKey: values.idempotencyKey },
  );
  if (result.status !== 'available')
    return actionFailure(result.status, context, 'confirmCandidate', values);
  redirect(303, inboxPath(workspaceId, conversationId));
}

export function inboxPath(workspaceId: string, conversationId: string) {
  return `/app/workspaces/${workspaceId.toLowerCase()}/conversations/${conversationId.toLowerCase()}/memory-candidates`;
}

export type { MemoryCandidate };
