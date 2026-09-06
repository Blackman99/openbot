import { readAttachment } from '../../src/lib/server/attachment-page.js';
import { expect, it, vi } from 'vitest';
import { conversationAction } from '../../src/lib/server/conversation-page.js';
const workspaceId = '9a11a103-0000-4000-8000-000000000001',
  conversationId = '9a11a103-0000-4000-8000-000000000002',
  messageId = '9a11a103-0000-4000-8000-000000000003',
  eventId = '9a11a103-0000-4000-8000-000000000004';
const token = Buffer.alloc(32, 23).toString('base64url');
function context(origin = 'http://localhost:3000') {
  const form = new FormData();
  form.set('body', 'A file');
  form.set('idempotencyKey', 'upload-1');
  form.set('attachment', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
  return {
    request: new Request('http://localhost:3000/app/conversation', {
      method: 'POST',
      headers: { origin },
      body: form,
    }),
    url: new URL('http://localhost:3000/app/conversation'),
    params: { workspaceId, conversationId, messageId },
    cookies: {
      get: vi.fn(() => token),
      getAll: vi.fn(() => []),
      set: vi.fn(),
      delete: vi.fn(),
      serialize: vi.fn(),
    },
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json({ receipt: { messageId, eventId, sequence: 1 } }),
    ),
    setHeaders: vi.fn(),
  };
}
it('publishes one multipart compose action as one bounded API attachment command', async () => {
  const ctx = context();
  await expect(
    conversationAction(ctx, workspaceId, conversationId, 'append'),
  ).rejects.toMatchObject({ status: 303 });
  expect(ctx.fetch).toHaveBeenCalledOnce();
  const [url, request] = ctx.fetch.mock.calls[0]!;
  expect(String(url)).toBe(
    `http://localhost:3001/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/attachments`,
  );
  expect(request).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost:3000' },
  });
  const bytes = Buffer.from(request!.body as Uint8Array),
    size = bytes.readUInt32BE(0);
  expect(JSON.parse(bytes.subarray(4, 4 + size).toString())).toMatchObject({
    body: 'A file',
    idempotencyKey: 'upload-1',
    filename: 'hello.txt',
    mediaType: 'text/plain',
    bytes: 5,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  });
  expect(bytes.subarray(4 + size).toString()).toBe('hello');
});
it('rejects an untrusted browser Origin before manufacturing an API Origin', async () => {
  const ctx = context('https://other.invalid');
  const result = await conversationAction(ctx, workspaceId, conversationId, 'append');
  expect(result).toMatchObject({ status: 403 });
  expect(ctx.fetch).not.toHaveBeenCalled();
});
it('bounds download bytes and emits safe private disposition', async () => {
  const ctx = context();
  ctx.request = new Request('http://localhost:3000/app/download');
  ctx.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array([104, 105]), {
      headers: {
        'content-type': 'text/plain',
        'content-length': '2',
        'content-disposition': 'attachment; filename="hello.txt"; filename*=UTF-8\'\'hello.txt',
      },
    }),
  );
  const response = await readAttachment(ctx);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('hi');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('rejects active MIME, unsafe disposition, and oversized or truncated download responses', async () => {
  const rejectedHeaders: Array<Record<string, string>> = [
    {
      'content-type': 'text/html',
      'content-disposition': "attachment; filename*=UTF-8''file.html",
    },
    {
      'content-type': 'text/plain',
      'content-disposition': "attachment; filename*=UTF-8''bad%0D%0A.txt",
    },
    {
      'content-type': 'text/plain',
      'content-disposition': "attachment; filename*=UTF-8''file.txt",
      'content-length': '67108865',
    },
    {
      'content-type': 'text/plain',
      'content-disposition': "attachment; filename*=UTF-8''file.txt",
      'content-length': '3',
    },
  ];
  for (const headers of rejectedHeaders) {
    const ctx = context();
    ctx.request = new Request('http://localhost:3000/app/download');
    ctx.fetch.mockResolvedValueOnce(new Response(new Uint8Array([104, 105]), { headers }));
    expect((await readAttachment(ctx)).status).toBe(503);
  }
});
