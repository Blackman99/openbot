import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { publicGroupFixture } from '../helpers/public-group-fixture.js';

interface Operation {
  operationId: string;
  security: Array<{ bearerAuth: never[] }>;
  'x-required-scope': 'groups:read' | 'groups:write';
  requestBody?: { content: { 'application/json': { schema: object } } };
  responses: Record<string, { content?: { 'application/json': { schema: object } } }>;
}
interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, object>; securitySchemes: object };
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('documents every public Group operation in OpenAPI 3.1 with explicit Bearer scope', async () => {
  const document: OpenApiDocument = JSON.parse(
    await readFile(
      new URL('../../../../docs/openapi/groups.openapi.json', import.meta.url),
      'utf8',
    ),
  );
  expect(document.openapi).toBe('3.1.1');
  expect(document.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(document.components.securitySchemes).toEqual({
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'ob_<43 base64url characters>' },
  });
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validateSchema = (schema: object, body: unknown) => {
    const validate = ajv.compile({ ...schema, components: document.components });
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  };
  const f = await publicGroupFixture(cleanup);
  const headers = await f.bearer(['groups:read', 'groups:write']);
  const created = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers,
    payload: { name: 'OpenAPI group', maxConcurrentRuns: 3 },
  });
  const groupId = created.json().group.id;
  const member = await f.addUser();
  const invited = await f.publicApp.inject({
    method: 'POST',
    url: `/v1/groups/${groupId}/bots`,
    headers,
    payload: { botId: f.bot.id, idempotencyKey: 'openapi-bot' },
  });
  const grantId = invited.json().grant.id;
  const second = await f.publicApp.inject({
    method: 'POST',
    url: '/v1/groups',
    headers,
    payload: { name: 'OpenAPI bot target' },
  });
  const requests = [
    { method: 'GET' as const, path: '/v1/groups', url: '/v1/groups?limit=1', status: 200 },
    {
      method: 'POST' as const,
      path: '/v1/groups',
      url: '/v1/groups',
      payload: { name: 'Second OpenAPI group' },
      status: 201,
    },
    {
      method: 'GET' as const,
      path: '/v1/groups/{groupId}',
      url: `/v1/groups/${groupId}`,
      status: 200,
    },
    {
      method: 'PATCH' as const,
      path: '/v1/groups/{groupId}',
      url: `/v1/groups/${groupId}`,
      payload: { description: 'OpenAPI edit' },
      status: 200,
    },
    {
      method: 'GET' as const,
      path: '/v1/groups/{groupId}/members',
      url: `/v1/groups/${groupId}/members`,
      status: 200,
    },
    {
      method: 'POST' as const,
      path: '/v1/groups/{groupId}/members',
      url: `/v1/groups/${groupId}/members`,
      payload: { userId: member.id },
      status: 201,
    },
    {
      method: 'POST' as const,
      path: '/v1/groups/{groupId}/bots',
      url: `/v1/groups/${second.json().group.id}/bots`,
      payload: { botId: f.bot.id, idempotencyKey: 'openapi-bot-two' },
      status: 201,
    },
    {
      method: 'GET' as const,
      path: '/v1/groups/{groupId}/bots',
      url: `/v1/groups/${groupId}/bots`,
      status: 200,
    },
    {
      method: 'PATCH' as const,
      path: '/v1/groups/{groupId}/routing',
      url: `/v1/groups/${groupId}/routing`,
      payload: { expectedRevision: 0, defaultGrantId: grantId },
      status: 200,
    },
    {
      method: 'POST' as const,
      path: '/v1/groups/{groupId}/bots/{grantId}/remove',
      url: `/v1/groups/${groupId}/bots/${grantId}/remove`,
      payload: { idempotencyKey: 'openapi-remove' },
      status: 200,
    },
    {
      method: 'DELETE' as const,
      path: '/v1/groups/{groupId}/members/{userId}',
      url: `/v1/groups/${groupId}/members/${member.id}`,
      status: 204,
    },
    {
      method: 'POST' as const,
      path: '/v1/groups/{groupId}/archive',
      url: `/v1/groups/${groupId}/archive`,
      status: 200,
    },
  ];
  expect(
    Object.entries(document.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort(),
  ).toEqual(requests.map(({ method, path }) => `${method} ${path}`).sort());
  for (const request of requests) {
    const operation = document.paths[request.path]![request.method.toLowerCase()]!;
    expect(operation.operationId).toBeTruthy();
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation['x-required-scope']).toBe(
      request.method === 'GET' ? 'groups:read' : 'groups:write',
    );
    if (request.payload)
      validateSchema(operation.requestBody!.content['application/json'].schema, request.payload);
    const input = {
      method: request.method,
      url: request.url,
      ...(request.payload ? { payload: request.payload } : {}),
    };
    const response = await f.publicApp.inject({ ...input, headers });
    expect(response.statusCode).toBe(request.status);
    if (response.statusCode !== 204)
      validateSchema(
        operation.responses[String(response.statusCode)]!.content!['application/json'].schema,
        response.json(),
      );
    for (const deniedHeaders of [
      {},
      await f.bearer(request.method === 'GET' ? ['groups:write'] : ['groups:read']),
    ]) {
      const denied = await f.publicApp.inject({ ...input, headers: deniedHeaders });
      expect(denied.statusCode).toBe('authorization' in deniedHeaders ? 403 : 401);
      validateSchema(
        operation.responses[String(denied.statusCode)]!.content!['application/json'].schema,
        denied.json(),
      );
    }
  }
});
