import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('COL-10 next-attempt writer', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/tasks/next-attempt.ts', import.meta.url)),
    'utf8',
  );

  it('does not let queued delivery append undo a written successor', () => {
    expect(source).toContain("UPDATE tasks SET status='queued'");
    expect(source).toContain('SAVEPOINT col10_queued_delivery');
    expect(source).toContain('ROLLBACK TO SAVEPOINT col10_queued_delivery');
  });
});
