import { mediaByExtension, safeFilename } from './attachment-contract.js';
import { createHash } from 'node:crypto';
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import {
  isCommandKey,
  isConversationUuid,
  type ConversationResult,
  type MessageReceipt,
} from './conversation-api.js';
import {
  clearSessionCookie,
  preventAuthenticationCaching,
  readSessionCookie,
} from './session-cookie.js';
type Context = Pick<RequestEvent, 'request' | 'cookies' | 'fetch' | 'setHeaders'>;
export function attachmentMaximum() {
  const value = process.env.ATTACHMENT_MAX_BYTES ?? '10485760';
  if (!/^[1-9][0-9]*$/u.test(value) || Number(value) > 67108864)
    throw new Error('Invalid attachment limit');
  return Number(value);
}
function base(workspaceId: string, conversationId: string) {
  return `${(process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/conversations/${conversationId.toLowerCase()}`;
}
async function boundedBody(response: Response, maximum: number, controller: AbortController) {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && (!/^[0-9]+$/u.test(advertised) || Number(advertised) > maximum))
    throw new Error('Invalid length');
  if (!response.body) throw new Error('Missing response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) {
        controller.abort();
        throw new Error('Response too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (advertised !== null && Number(advertised) !== size) throw new Error('Truncated response');
  return Buffer.concat(chunks, size);
}
export async function uploadAttachment(
  context: Context,
  workspaceId: string,
  conversationId: string,
  values: Record<string, string>,
  file: File,
): Promise<ConversationResult<MessageReceipt>> {
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  if (context.request.headers.get('origin') !== origin) return { status: 'forbidden' };
  const session = readSessionCookie(context.cookies);
  if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) return { status: 'anonymous' };
  const mediaType = file.type || mediaByExtension[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (
    !isConversationUuid(workspaceId) ||
    !isConversationUuid(conversationId) ||
    !isCommandKey(values.idempotencyKey) ||
    !values.body?.trim() ||
    values.body.length > 32000 ||
    !safeFilename(file.name) ||
    file.size < 1 ||
    file.size > attachmentMaximum() ||
    !mediaType ||
    !Object.values(mediaByExtension).includes(mediaType)
  )
    return { status: 'invalid' };
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  try {
    const content = Buffer.from(await file.arrayBuffer()),
      metadata = Buffer.from(
        JSON.stringify({
          body: values.body,
          idempotencyKey: values.idempotencyKey,
          filename: file.name,
          mediaType,
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        }),
      ),
      length = Buffer.alloc(4);
    length.writeUInt32BE(metadata.length);
    const response = await context.fetch(base(workspaceId, conversationId) + '/attachments', {
      method: 'POST',
      redirect: 'error',
      headers: {
        origin,
        cookie: `openbot_session=${session}`,
        'content-type': 'application/octet-stream',
      },
      body: Buffer.concat([length, metadata, content]),
      signal: AbortSignal.any([controller.signal, context.request.signal]),
    });
    if (response.status === 401) return { status: 'anonymous' };
    if (response.status === 403) return { status: 'forbidden' };
    if ([400, 413, 415].includes(response.status)) return { status: 'invalid' };
    if (response.status === 409) return { status: 'idempotency-conflict' };
    if (response.status !== 200) return { status: 'unavailable' };
    const payload: unknown = JSON.parse(
      (await boundedBody(response, 4096, controller)).toString('utf8'),
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      Object.keys(payload).join(',') !== 'receipt' ||
      !('receipt' in payload)
    )
      return { status: 'unavailable' };
    const receipt = payload.receipt;
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Object.keys(receipt).sort().join(',') !== 'eventId,messageId,sequence' ||
      !('messageId' in receipt) ||
      !isConversationUuid(receipt.messageId) ||
      !('eventId' in receipt) ||
      !isConversationUuid(receipt.eventId) ||
      !('sequence' in receipt) ||
      typeof receipt.sequence !== 'number' ||
      !Number.isSafeInteger(receipt.sequence) ||
      receipt.sequence < 1
    )
      return { status: 'unavailable' };
    return {
      status: 'available',
      value: {
        messageId: receipt.messageId.toLowerCase(),
        eventId: receipt.eventId.toLowerCase(),
        sequence: receipt.sequence,
      },
    };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
export async function readAttachment(
  context: Context & { params: { workspaceId: string; conversationId: string; messageId: string } },
): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
  const reject = (status: number) => new Response(null, { status, headers });
  const { workspaceId, conversationId, messageId } = context.params;
  if (![workspaceId, conversationId, messageId].every(isConversationUuid)) return reject(400);
  const session = readSessionCookie(context.cookies);
  if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) {
    clearSessionCookie(context.cookies);
    return reject(401);
  }
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await context.fetch(
      base(workspaceId, conversationId) + `/messages/${messageId.toLowerCase()}/attachment/content`,
      {
        redirect: 'error',
        headers: { cookie: `openbot_session=${session}` },
        signal: AbortSignal.any([controller.signal, context.request.signal]),
      },
    );
    if (response.status === 401) {
      clearSessionCookie(context.cookies);
      return reject(401);
    }
    if ([403, 404].includes(response.status)) return reject(response.status);
    const type = response.headers.get('content-type')?.replace(/; charset=utf-8$/u, ''),
      disposition = response.headers.get('content-disposition'),
      encoded = disposition?.match(/; filename\*=UTF-8''([^;]+)$/u)?.[1],
      filename = encoded ? decodeURIComponent(encoded) : '';
    if (
      response.status !== 200 ||
      !type ||
      !Object.values(mediaByExtension).includes(type) ||
      !safeFilename(filename)
    )
      return reject(503);
    const bytes = await boundedBody(response, 67108864, controller);
    if (!bytes.length) return reject(503);
    return new Response(context.request.method === 'HEAD' ? null : new Uint8Array(bytes), {
      headers: {
        ...headers,
        'content-type': type,
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._ -]/gu, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()]/gu, (v) => '%' + v.charCodeAt(0).toString(16).toUpperCase())}`,
      },
    });
  } catch {
    return reject(503);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
export async function purgeMessageAction(
  context: Context & { params: { workspaceId: string; conversationId: string } },
) {
  preventAuthenticationCaching(context.setHeaders);
  const failure = (status: number, error: string) =>
    fail(status, {
      action: 'purge',
      values: {} as Record<string, string>,
      conflict: false,
      error,
      message: undefined,
    });
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  if (context.request.headers.get('origin') !== origin)
    return failure(403, 'You cannot purge this message.');
  const session = readSessionCookie(context.cookies);
  if (!session) {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  const { workspaceId, conversationId } = context.params;
  let messageId: unknown;
  try {
    const form = await context.request.formData();
    messageId = form.get('messageId');
    if ([...form.keys()].join(',') !== 'messageId') return failure(400, 'Invalid message.');
  } catch {
    return failure(400, 'Invalid message.');
  }
  if (
    !isConversationUuid(workspaceId) ||
    !isConversationUuid(conversationId) ||
    !isConversationUuid(messageId)
  )
    return failure(400, 'Invalid message.');
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  let status = 503;
  try {
    const response = await context.fetch(
      base(workspaceId, conversationId) + `/messages/${messageId.toLowerCase()}/purge`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          origin,
          cookie: `openbot_session=${session}`,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.any([controller.signal, context.request.signal]),
      },
    );
    status = response.status;
    if (status === 200 || status === 202) {
      const payload: unknown = JSON.parse(
        (await boundedBody(response, 1024, controller)).toString(),
      );
      if (
        JSON.stringify(payload) ===
        JSON.stringify({ purge: { state: status === 200 ? 'complete' : 'purging' } })
      )
        return {
          action: 'purge',
          values: {} as Record<string, string>,
          conflict: false,
          error: undefined,
          message:
            status === 200
              ? 'Message and files permanently purged.'
              : 'Purge queued. Message access has stopped; file cleanup will retry until complete.',
        };
    }
  } catch {
    status = 503;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (status === 401) {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  return failure(
    status === 403 ? 403 : 503,
    status === 403
      ? 'You cannot purge this message.'
      : 'Purge could not be confirmed. Reload and retry.',
  );
}
