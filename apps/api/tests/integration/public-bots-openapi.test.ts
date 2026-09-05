import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { publicBotFixture } from '../helpers/public-bot-fixture.js';

interface Operation {
  operationId: string;
  security: Array<{ bearerAuth: never[] }>;
  'x-required-scope': 'bots:read' | 'bots:write';
  requestBody?: { content: { 'application/json': { schema: object } } };
  responses: Record<string, { content: { 'application/json': { schema: object } } }>;
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

it('documents every public Bot operation in OpenAPI 3.1 with explicit Bearer scope and validates real responses', async () => {
  const document: OpenApiDocument = JSON.parse(
    await readFile(new URL('../../../../docs/openapi/bots.openapi.json', import.meta.url), 'utf8'),
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
  const f = await publicBotFixture(cleanup);
  const headers = await f.bearer(['bots:read', 'bots:write']);
  const configuration = (
    await f.app.inject({ url: `${f.path}/${f.bot.id}`, headers: f.headers })
  ).json().bot.currentVersion.configuration;
  const requests = [
    { method: 'GET' as const, path: '/v1/bots', url: '/v1/bots?limit=1', status: 200 },
    {
      method: 'POST' as const,
      path: '/v1/bots',
      url: '/v1/bots',
      payload: configuration,
      status: 201,
    },
    { method: 'GET' as const, path: '/v1/bots/{botId}', url: `/v1/bots/${f.bot.id}`, status: 200 },
    {
      method: 'PATCH' as const,
      path: '/v1/bots/{botId}',
      url: `/v1/bots/${f.bot.id}`,
      payload: {
        expectedCurrentVersionId: f.bot.currentVersion.id,
        changes: { description: 'OpenAPI edit' },
      },
      status: 200,
    },
    {
      method: 'GET' as const,
      path: '/v1/bots/{botId}/versions',
      url: `/v1/bots/${f.bot.id}/versions?limit=1`,
      status: 200,
    },
    {
      method: 'GET' as const,
      path: '/v1/bots/{botId}/versions/{versionId}',
      url: `/v1/bots/${f.bot.id}/versions/${f.bot.currentVersion.id}`,
      status: 200,
    },
    {
      method: 'POST' as const,
      path: '/v1/bots/{botId}/archive',
      url: `/v1/bots/${f.bot.id}/archive`,
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
      request.method === 'GET' ? 'bots:read' : 'bots:write',
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
    validateSchema(
      operation.responses[String(response.statusCode)]!.content['application/json'].schema,
      response.json(),
    );
    for (const deniedHeaders of [
      {},
      await f.bearer(request.method === 'GET' ? ['bots:write'] : ['bots:read']),
    ]) {
      const denied = await f.publicApp.inject({ ...input, headers: deniedHeaders });
      expect(denied.statusCode).toBe('authorization' in deniedHeaders ? 403 : 401);
      validateSchema(
        operation.responses[String(denied.statusCode)]!.content['application/json'].schema,
        denied.json(),
      );
    }
  }
  const stale = await f.publicApp.inject({
    method: 'PATCH',
    url: `/v1/bots/${f.bot.id}`,
    headers,
    payload: { expectedCurrentVersionId: f.bot.currentVersion.id, changes: { name: 'Stale name' } },
  });
  expect(stale.statusCode).toBe(409);
  validateSchema(
    document.paths['/v1/bots/{botId}']!.patch!.responses['409']!.content['application/json'].schema,
    stale.json(),
  );
  const malformed = await f.publicApp.inject({ url: '/v1/bots?limit=101', headers });
  expect(malformed.statusCode).toBe(400);
  validateSchema(
    document.paths['/v1/bots']!.get!.responses['400']!.content['application/json'].schema,
    malformed.json(),
  );
  const outsider = await f.addUser();
  const resourceDenied = await f.publicApp.inject({
    url: `/v1/bots/${f.bot.id}`,
    headers: await f.bearer(['bots:read'], outsider.id),
  });
  expect(resourceDenied.statusCode).toBe(403);
  validateSchema(
    document.paths['/v1/bots/{botId}']!.get!.responses['403']!.content['application/json'].schema,
    resourceDenied.json(),
  );
  const invalidInput = ajv.compile({
    ...document.paths['/v1/bots']!.post!.requestBody!.content['application/json'].schema,
    components: document.components,
  });
  for (const invalid of [
    { ...configuration, ownerUserId: f.owner.user.id },
    { ...configuration, limits: { maxTurns: 101 } },
    { ...configuration, instructions: '  ' },
  ])
    expect(invalidInput(invalid)).toBe(false);
});
