import { describe, expect, it, vi } from 'vitest';
import { MemoryApiClient } from '../../src/lib/server/memory-api.js';
import { memory, command, group, workspace, token, grant } from '../fixtures/memories.js';
const scope = { workspaceId: workspace.id, groupId: group.id };
describe('Memory API client', () => {
  it('saves only the expected immutable source command and parses its scoped provenance', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ memory }, { status: 201 }));
    const client = new MemoryApiClient(request, 'http://api', 'http://localhost:3000');
    expect(await client.create(token, scope, command)).toEqual({
      status: 'available',
      value: memory,
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api/api/v1/workspaces/${workspace.id}/groups/${group.id}/memories`,
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(command);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      cookie: `openbot_session=${token}`,
      origin: 'http://localhost:3000',
    });
  });
  it('keeps search text in POST body and selects one exact grant without widening its scope', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ memories: [memory], nextAfter: null }),
    );
    const client = new MemoryApiClient(request, 'http://api', 'http://localhost:3000');
    expect(
      await client.search(token, { ...scope, grantId: grant.id }, { query: 'private search' }),
    ).toEqual({ status: 'available', value: { memories: [memory], nextAfter: null } });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api/api/v1/workspaces/${workspace.id}/groups/${group.id}/bots/${grant.id}/memories/search`,
    );
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'private search',
    });
  });
  it.each([
    { ...memory, scope: { ...memory.scope, groupId: memory.id } },
    { ...memory, confidence: 2 },
    { ...memory, version: 2 },
    { ...memory, confidenceSource: 'model' },
    { ...memory, source: { ...memory.source, secret: 'extra' } },
    { ...memory, source: { ...memory.source, version: 2 } },
    { ...memory, creator: { ...memory.creator, credential: 'extra' } },
    {
      ...memory,
      source: { ...memory.source, author: { ...memory.source.author, kind: 'system' } },
    },
  ])('rejects malformed or cross-scope memory provenance %#', async (value) => {
    const client = new MemoryApiClient(
      vi.fn(async () => Response.json({ memory: value })),
      'http://api',
      'http://localhost:3000',
    );
    expect(await client.get(token, scope, memory.id)).toEqual({ status: 'unavailable' });
  });
  it('rejects duplicate items, regressing cursors and a mismatched detail identity', async () => {
    for (const value of [
      { memories: [memory, memory], nextAfter: null },
      { memories: [memory], nextAfter: memory.versionId },
    ]) {
      const client = new MemoryApiClient(
        vi.fn(async () => Response.json(value)),
        'http://api',
        'http://localhost:3000',
      );
      expect(await client.list(token, scope)).toEqual({ status: 'unavailable' });
    }
    const client = new MemoryApiClient(
      vi.fn(async () => Response.json({ memory })),
      'http://api',
      'http://localhost:3000',
    );
    expect(await client.get(token, scope, memory.versionId)).toEqual({ status: 'unavailable' });
  });
  it('preserves typed permission, revision and idempotency failures', async () => {
    for (const [code, status, expected] of [
      ['memory_forbidden', 403, 'forbidden'],
      ['source_version_conflict', 409, 'version-conflict'],
      ['idempotency_conflict', 409, 'idempotency-conflict'],
    ] as const) {
      const client = new MemoryApiClient(
        vi.fn(async () => Response.json({ error: { code } }, { status })),
        'http://api',
        'http://localhost:3000',
      );
      expect(await client.create(token, scope, command)).toEqual({ status: expected });
    }
  });
});
