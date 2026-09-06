import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { isBotUuid, parseBotConfiguration } from './bot-api.js';
import {
  readSessionCookie,
  clearSessionCookie,
  preventAuthenticationCaching,
} from './session-cookie.js';
import { SESSION_COOKIE_NAME } from './auth-api.js';
type Context = Pick<RequestEvent, 'request' | 'cookies' | 'fetch' | 'setHeaders'> & {
  params: { workspaceId: string; botId: string };
};
const messages: Record<number, string> = {
  400: 'Choose a static PNG or JPEG up to 2 MiB, with at most 4 million pixels and dimensions up to 4096.',
  403: 'You no longer have permission to change this Bot. Reload to see current access.',
  409: 'The Bot changed while you were editing. Reload before trying again.',
  413: 'The avatar is too large. Choose a file up to 2 MiB.',
  415: 'Choose a static PNG or JPEG image.',
  429: 'Image processing is busy. Try again shortly.',
  503: "We couldn't confirm the avatar change. Reload to check the current avatar before trying again.",
};
function failure(status: number) {
  return fail(status, { avatarError: messages[status] ?? messages[503]! });
}
function versionResponse(payload: unknown, workspaceId: string, remove: boolean) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Object.keys(payload).join(',') !== 'version' ||
    !('version' in payload)
  )
    return false;
  const v = payload.version;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'author,configuration,createdAt,id,number,rationale' ||
    !('id' in v) ||
    !isBotUuid(v.id) ||
    !('number' in v) ||
    !Number.isSafeInteger(v.number) ||
    Number(v.number) < 1 ||
    !('configuration' in v) ||
    !('createdAt' in v) ||
    typeof v.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !('rationale' in v) ||
    typeof v.rationale !== 'string' ||
    v.rationale.length > 500 ||
    !('author' in v)
  )
    return false;
  const author = v.author;
  if (
    !author ||
    typeof author !== 'object' ||
    Object.keys(author).sort().join(',') !== 'displayName,id' ||
    !('id' in author) ||
    !isBotUuid(author.id) ||
    !('displayName' in author) ||
    typeof author.displayName !== 'string' ||
    author.displayName.length < 1 ||
    author.displayName.length > 200
  )
    return false;
  const config = parseBotConfiguration(v.configuration, workspaceId);
  return config && (remove ? !config.avatarObjectId : !!config.avatarObjectId);
}
async function mutate(context: Context, remove: boolean) {
  preventAuthenticationCaching(context.setHeaders);
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  if (context.request.headers.get('origin') !== origin) return failure(403);
  const { workspaceId, botId } = context.params;
  if (!isBotUuid(workspaceId) || !isBotUuid(botId)) return failure(400);
  const session = readSessionCookie(context.cookies);
  if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return failure(400);
  }
  const expected = form.get('expectedCurrentVersionId');
  if (
    !isBotUuid(expected) ||
    form.getAll('expectedCurrentVersionId').length !== 1 ||
    [...form.keys()].some((key) => !['avatar', 'expectedCurrentVersionId'].includes(key))
  )
    return failure(400);
  const file = form.get('avatar');
  if (
    !remove &&
    (!(file instanceof File) ||
      form.getAll('avatar').length !== 1 ||
      file.size < 1 ||
      file.size > 2097152 ||
      !['image/png', 'image/jpeg'].includes(file.type))
  )
    return failure(400);
  if (remove && file !== null) return failure(400);
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.request.signal.addEventListener('abort', abort, { once: true });
  if (context.request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 30_000);
  let status = 503;
  try {
    controller.signal.throwIfAborted();
    const response = await context.fetch(
      `${(process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}/avatar?expectedCurrentVersionId=${expected.toLowerCase()}`,
      {
        method: remove ? 'DELETE' : 'PUT',
        redirect: 'error',
        headers: {
          origin,
          cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
          ...(!remove && file instanceof File ? { 'content-type': file.type } : {}),
        },
        ...(!remove && file instanceof File ? { body: await file.arrayBuffer() } : {}),
        signal: controller.signal,
      },
    );
    status = response.status;
    if (status === 200) {
      const payload: unknown = await response.json();
      if (versionResponse(payload, workspaceId.toLowerCase(), remove))
        return { avatarMessage: remove ? 'Avatar removed.' : 'Avatar updated.' };
      status = 503;
    }
  } catch {
    status = 503;
  } finally {
    clearTimeout(timer);
    context.request.signal.removeEventListener('abort', abort);
  }
  if (status === 401) {
    clearSessionCookie(context.cookies);
    redirect(303, '/sign-in');
  }
  return failure(status in messages ? status : 503);
}
export const uploadAvatarAction = (context: Context) => mutate(context, false);
export const removeAvatarAction = (context: Context) => mutate(context, true);

export async function readAvatar(context: Context): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
  const reject = (status: number) => new Response(null, { status, headers });
  const { workspaceId, botId } = context.params;
  const selected = new URL(context.request.url).searchParams.get('versionId');
  if (!isBotUuid(workspaceId) || !isBotUuid(botId) || (selected !== null && !isBotUuid(selected)))
    return reject(403);
  const session = readSessionCookie(context.cookies);
  if (!session || !/^[A-Za-z0-9_-]{43}$/u.test(session)) {
    clearSessionCookie(context.cookies);
    return reject(401);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    controller.signal.throwIfAborted();
    const response = await context.fetch(
      `${(process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/u, '')}/api/v1/workspaces/${workspaceId.toLowerCase()}/bots/${botId.toLowerCase()}/avatar${selected ? `?versionId=${selected.toLowerCase()}` : ''}`,
      {
        method: context.request.method === 'HEAD' ? 'HEAD' : 'GET',
        redirect: 'error',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` },
        signal: AbortSignal.any([controller.signal, context.request.signal]),
      },
    );
    if (response.status === 401) {
      clearSessionCookie(context.cookies);
      return reject(401);
    }
    if (response.status === 403 || response.status === 404) return reject(response.status);
    if (response.status !== 200 || response.headers.get('content-type') !== 'image/png')
      return reject(503);
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > 2097152))
      return reject(503);
    if (context.request.method === 'HEAD')
      return new Response(null, {
        headers: {
          ...headers,
          'content-type': 'image/png',
          ...(advertised ? { 'content-length': advertised } : {}),
        },
      });
    if (!response.body) return reject(503);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 2097152) {
          controller.abort();
          return reject(503);
        }
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!length || (advertised !== null && Number(advertised) !== length)) return reject(503);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new Response(body, {
      headers: { ...headers, 'content-type': 'image/png', 'content-length': String(length) },
    });
  } catch {
    return reject(503);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
