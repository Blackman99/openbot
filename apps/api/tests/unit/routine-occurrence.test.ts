import { describe, expect, it } from 'vitest';
import { oneTimeOccurrenceKey } from '../../src/routines/service.js';

describe('ROUT-01 one-time occurrence keys', () => {
  it('derives a stable key from the scheduled execute_at instant', () => {
    expect(oneTimeOccurrenceKey(new Date('2026-09-07T01:00:00.000Z'))).toBe(
      '2026-09-07T01:00:00.000Z',
    );
  });
});
