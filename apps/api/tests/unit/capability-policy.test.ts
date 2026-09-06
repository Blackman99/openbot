import { describe, expect, it } from 'vitest';
import { currentPolicy, emptyPolicy } from '../../src/providers/capability-policy.js';

describe('currentPolicy', () => {
  it('treats a SQL null policy the same as a missing policy', () => {
    expect(currentPolicy(null)).toEqual(emptyPolicy());
    expect(currentPolicy(undefined)).toEqual(emptyPolicy());
  });
});
