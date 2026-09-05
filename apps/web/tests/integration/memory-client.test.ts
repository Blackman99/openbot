import { describe, expect, it, vi } from 'vitest';
import { MemoryApiClient } from '../../src/lib/server/memory-api.js';
import {
  memory,
  command,
  group,
  workspace,
  token,
  grant,
  candidate,
  approvedFact,
  conversation,
} from '../fixtures/memories.js';
import {
  REVIEW_DISCLOSURE_VERSION,
  WORKSPACE_FACT_VISIBILITY_SUMMARY,
} from '../../src/lib/server/memory-api.js';
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
  it('lists conversation candidates and approves only the reviewed destination payload', async () => {
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/memory-candidates'))
        return Response.json({ candidates: [candidate], nextAfter: null });
      return Response.json(
        { candidate: { ...candidate, status: 'approved' }, fact: approvedFact, replayed: false },
        { status: 201 },
      );
    });
    const client = new MemoryApiClient(request, 'http://api', 'http://localhost:3000');
    const inbox = { workspaceId: workspace.id, conversationId: conversation.id };
    expect(await client.listCandidates(token, inbox)).toEqual({
      status: 'available',
      value: { candidates: [candidate], nextAfter: null },
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      `http://api/api/v1/workspaces/${workspace.id}/conversations/${conversation.id}/memory-candidates`,
    );
    expect(
      await client.approveCandidate(token, inbox, candidate.id, {
        expectedRevision: 1,
        destination: candidate.proposedScope,
        confidence: 0.8,
        idempotencyKey: 'approve-group',
      }),
    ).toEqual({
      status: 'available',
      value: { candidate: { ...candidate, status: 'approved' }, fact: approvedFact },
    });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 1,
      destination: candidate.proposedScope,
      confidence: 0.8,
      idempotencyKey: 'approve-group',
    });
  });
  it('parses a workspace preview and keeps confirmation from changing the destination', async () => {
    const preview = {
      id: '4d661304-a1bc-4767-9a87-c47de763f749',
      expiresAt: candidate.createdAt,
      content: candidate.body,
      destination: { kind: 'workspace' as const, id: workspace.id },
      visibility: {
        kind: 'workspace' as const,
        id: workspace.id,
        summary: WORKSPACE_FACT_VISIBILITY_SUMMARY,
      },
      disclosureVersion: REVIEW_DISCLOSURE_VERSION,
    };
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/approval-previews')) return Response.json({ preview });
      return Response.json(
        {
          candidate: { ...candidate, status: 'approved' },
          fact: {
            ...approvedFact,
            scope: { kind: 'workspace', workspaceId: workspace.id, id: workspace.id },
          },
          replayed: false,
        },
        { status: 201 },
      );
    });
    const client = new MemoryApiClient(request, 'http://api', 'http://localhost:3000');
    const inbox = { workspaceId: workspace.id, conversationId: conversation.id };
    expect(
      await client.previewCandidate(token, inbox, candidate.id, {
        expectedRevision: 1,
        destination: { kind: 'workspace', id: workspace.id },
        confidence: 0.7,
      }),
    ).toEqual({ status: 'available', value: preview });
    expect(
      await client.confirmCandidate(token, inbox, candidate.id, {
        intentId: preview.id,
        idempotencyKey: 'confirm-workspace',
      }),
    ).toMatchObject({
      status: 'available',
      value: {
        fact: { scope: { kind: 'workspace', id: workspace.id } },
      },
    });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      intentId: preview.id,
      idempotencyKey: 'confirm-workspace',
      acknowledged: true,
    });
  });
});
