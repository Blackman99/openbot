import { describe, expect, it } from 'vitest';
import {
  extractLocalMarkedLines,
  normalizeCandidateText,
} from '../../src/memories/local-extractor.js';

describe('local-marked-lines-v1', () => {
  it('extracts Remember, Preference, Decision and Chinese single-line markers', () => {
    const result = extractLocalMarkedLines(
      [
        'Remember: keep the cobalt key',
        'Preference: dark theme',
        'Decision: use Postgres',
        '记住：保存证据',
        '偏好：简体',
        '决定：继续',
      ].join('\n'),
    );
    expect(result).toEqual({
      ok: true,
      candidates: [
        'keep the cobalt key',
        'dark theme',
        'use Postgres',
        '保存证据',
        '简体',
        '继续',
      ].map((text) => ({ text, fingerprint: expect.any(String) })),
    });
    if (result.ok) expect(new Set(result.candidates.map((item) => item.fingerprint)).size).toBe(6);
  });

  it('takes bullets immediately under Memory candidates headings and ignores fenced code', () => {
    const result = extractLocalMarkedLines(
      [
        '```',
        'Remember: inside fence',
        '```',
        'Memory candidates',
        '- first fact',
        '* second fact',
        '记忆候选',
        '- 第三条',
        '',
        'Remember: after the section',
      ].join('\n'),
    );
    expect(result).toEqual({
      ok: true,
      candidates: ['first fact', 'second fact', '第三条', 'after the section'].map((text) => ({
        text,
        fingerprint: expect.any(String),
      })),
    });
  });

  it('returns zero candidates when no supported marker exists', () => {
    expect(extractLocalMarkedLines('The evidence is complete.')).toEqual({
      ok: true,
      candidates: [],
    });
  });

  it('preserves case in fingerprints so US and us stay distinct', () => {
    const result = extractLocalMarkedLines('Remember: US\nRemember: us');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates.map((item) => item.text)).toEqual(['US', 'us']);
      expect(result.candidates[0]!.fingerprint).not.toBe(result.candidates[1]!.fingerprint);
    }
  });

  it('normalizes NFC, newlines and ASCII space runs without case folding', () => {
    expect(normalizeCandidateText('  Cafe\u0301\r\nkeep\t\tid  ')).toBe('Café\nkeep id');
  });

  it('fails atomically at eleven distinct eligible candidates or oversize input/entry', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `Remember: fact ${index}`).join('\n');
    expect(extractLocalMarkedLines(eleven)).toEqual({ ok: false, error: 'extraction_limit' });
    expect(extractLocalMarkedLines('Remember: ' + 'x'.repeat(1001))).toEqual({
      ok: false,
      error: 'extraction_limit',
    });
    expect(extractLocalMarkedLines('y'.repeat(32001))).toEqual({
      ok: false,
      error: 'extraction_limit',
    });
  });
});
