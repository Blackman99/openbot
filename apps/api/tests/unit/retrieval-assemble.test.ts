import { describe, expect, it } from 'vitest';
import { assembleRunContext, CONTEXT_PRIORITY } from '../../src/retrieval/assemble.js';

const system = {
  kind: 'system' as const,
  id: 'system-1',
  role: 'system' as const,
  content: 'Never replace these rules.',
};

describe('RET-01 context assembler', () => {
  it('filters nothing after admission and keeps a deterministic kind-then-collection order', () => {
    const ledger = {
      kind: 'ledger' as const,
      id: 'm-2',
      role: 'user' as const,
      content: 'later ledger',
    };
    const memoryB = {
      kind: 'memory' as const,
      id: 'mem-b',
      role: 'user' as const,
      content: 'memory b',
      sourceId: 'src-b',
      scope: 'group:1',
      version: 1,
      locator: 'event:b',
    };
    const memoryA = {
      kind: 'memory' as const,
      id: 'mem-a',
      role: 'user' as const,
      content: 'memory a',
      sourceId: 'src-a',
      scope: 'group:1',
      version: 2,
      locator: 'event:a',
    };
    const knowledge = {
      kind: 'knowledge' as const,
      id: 'knw-1',
      role: 'user' as const,
      content: 'chunk',
      sourceId: 'att-1',
      scope: 'group:1',
      version: 1,
      locator: 'lines:1-2',
    };
    const first = assembleRunContext([ledger, knowledge, memoryB, system, memoryA]);
    const second = assembleRunContext([ledger, knowledge, memoryB, system, memoryA]);
    expect(CONTEXT_PRIORITY).toEqual(['system', 'memory', 'knowledge', 'ledger']);
    expect(first.items.map((item) => item.id)).toEqual([
      'system-1',
      'mem-b',
      'mem-a',
      'knw-1',
      'm-2',
    ]);
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(first.items[1]).toMatchObject({
      sourceId: 'src-b',
      scope: 'group:1',
      version: 1,
      locator: 'event:b',
    });
  });

  it('keeps complete system rules when the budget is exceeded and drops lower-priority kinds', () => {
    const assembled = assembleRunContext(
      [
        system,
        {
          kind: 'memory',
          id: 'mem-1',
          role: 'user',
          content: 'x'.repeat(40),
          sourceId: 'src',
          scope: 'group:1',
          version: 1,
          locator: 'event:1',
        },
        {
          kind: 'knowledge',
          id: 'knw-1',
          role: 'user',
          content: 'y'.repeat(40),
          sourceId: 'att',
          scope: 'group:1',
          version: 1,
          locator: 'lines:1-1',
        },
        { kind: 'ledger', id: 'led-1', role: 'user', content: 'z'.repeat(40) },
      ],
      Buffer.byteLength(system.content) + 50,
    );
    expect(assembled.messages[0]).toEqual({
      role: 'system',
      content: 'Never replace these rules.',
    });
    expect(assembled.items.map((item) => item.kind)).toEqual(['system', 'memory']);
    expect(assembled.dropped).toEqual(['knowledge', 'ledger']);
  });
});
