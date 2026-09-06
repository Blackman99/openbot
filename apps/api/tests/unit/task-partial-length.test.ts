import { afterAll, describe, expect, it } from 'vitest';
import { DataType, newDb } from 'pg-mem';
import { TASK_PARTIAL_LENGTH_SQL } from '../../src/tasks/cancellation-postgres.js';

// Execute the production SQL expression with explicit PostgreSQL text semantics.
// pg-mem's own length counts JS units, which would conceal this native guard bug.
// This checks expression composition and boundaries, not real PG trigger execution.
const database = newDb();
database.public.registerFunction({
  name: 'length',
  args: [DataType.text],
  returns: DataType.integer,
  implementation: (text: string) => Array.from(text).length,
});
database.public.registerFunction({
  name: 'regexp_replace',
  args: [DataType.text, DataType.text, DataType.text, DataType.text],
  returns: DataType.text,
  implementation: (text: string, pattern: string, replacement: string, flags: string) =>
    text.replace(new RegExp(pattern, flags + 'u'), replacement),
});
const pool = new (database.adapters.createPg().Pool)();
afterAll(() => pool.end());
// The emulator does not parse COLLATE. Its explicit Unicode regex implementation
// above supplies the fixed code-point ordering; native cases execute the full SQL.
const expression = TASK_PARTIAL_LENGTH_SQL.replaceAll(' COLLATE "C"', '');

describe('native Run partial UTF-16 length expression', () => {
  it.each([
    { name: 'BMP boundary', text: '界'.repeat(32000), allowed: true },
    { name: 'BMP overflow', text: '界'.repeat(32001), allowed: false },
    { name: 'astral boundary', text: '🌱'.repeat(16000), allowed: true },
    { name: 'astral overflow', text: '🌱'.repeat(16001), allowed: false },
    { name: 'mixed boundary', text: '界'.repeat(31998) + '🌱', allowed: true },
    { name: 'mixed overflow', text: '界'.repeat(31999) + '🌱', allowed: false },
  ])('matches the public 32,000-unit limit at $name', async ({ text, allowed }) => {
    const result = await pool.query(
      `SELECT ${expression} AS units, (${expression})<=32000 AS allowed FROM (SELECT $1::text AS body) AS NEW`,
      [text],
    );
    expect(result.rows).toEqual([{ units: text.length, allowed }]);
  });
});
