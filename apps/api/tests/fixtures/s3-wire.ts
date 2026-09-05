// Deterministic HTTP protocol fixture. This is not a real S3 service acceptance gate.
import { createServer } from 'node:http';
export async function s3WireFixture() {
  const objects = new Map<string, Buffer>();
  const calls: Array<{
    method: string;
    key: string;
    ifNoneMatch: string | undefined;
    acl: string | undefined;
  }> = [];
  const behavior = {
    errorStatus: 0,
    stall: '' as '' | 'headers' | 'body',
    chunked: false,
    endlessError: false,
    errorBytesSent: 0,
  };
  let bodyStartedResolve: () => void = () => undefined;
  const bodyStarted = new Promise<void>((resolve) => {
    bodyStartedResolve = resolve;
  });
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(
      new URL(request.url ?? '', 'http://fixture').pathname.split('/').slice(2).join('/'),
    );
    calls.push({
      method: request.method ?? '',
      key,
      ifNoneMatch: request.headers['if-none-match'] as string | undefined,
      acl: request.headers['x-amz-acl'] as string | undefined,
    });
    const failure = (status: number, code: string) => {
      response
        .writeHead(status, { 'content-type': 'application/xml' })
        .end(`<Error><Code>${code}</Code><Message>fixture credential secret</Message></Error>`);
    };
    if (behavior.stall === 'headers') return;
    if (behavior.endlessError) {
      response.writeHead(503, { 'content-type': 'application/xml' });
      const interval = setInterval(() => {
        behavior.errorBytesSent += 16_384;
        response.write(Buffer.alloc(16_384, 120));
      }, 5);
      response.once('close', () => clearInterval(interval));
      return;
    }
    if (behavior.errorStatus) {
      failure(behavior.errorStatus, 'AccessDenied');
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(key) && request.headers['if-none-match'] === '*') {
        failure(412, 'PreconditionFailed');
        return;
      }
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200, { etag: '"fixture-etag"' }).end();
    } else if (request.method === 'GET') {
      const value = objects.get(key);
      if (!value) {
        failure(404, 'NoSuchKey');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        ...(behavior.chunked || behavior.stall === 'body'
          ? {}
          : { 'content-length': value.length }),
      });
      if (behavior.stall === 'body') {
        response.write(value.subarray(0, 1));
        bodyStartedResolve();
        return;
      }
      response.end(value);
    } else if (request.method === 'DELETE') {
      objects.delete(key);
      response.writeHead(204).end();
    } else failure(405, 'MethodNotAllowed');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_bind_failed');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    calls,
    behavior,
    bodyStarted,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
