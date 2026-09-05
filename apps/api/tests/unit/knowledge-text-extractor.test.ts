import { describe, expect, it } from 'vitest';
import {
  classifyTextKnowledgeFile,
  extractTextKnowledgeChunks,
} from '../../src/knowledge/text-extractor.js';

describe('text-line-row-v1', () => {
  it('classifies TXT, Markdown, JSON, CSV, TSV and configured source files', () => {
    expect(classifyTextKnowledgeFile('notes.txt', 'text/plain')).toBe('txt');
    expect(classifyTextKnowledgeFile('readme.md', 'text/markdown')).toBe('markdown');
    expect(classifyTextKnowledgeFile('payload.json', 'application/json')).toBe('json');
    expect(classifyTextKnowledgeFile('table.csv', 'text/csv')).toBe('csv');
    expect(classifyTextKnowledgeFile('table.tsv', 'text/tab-separated-values')).toBe('tsv');
    expect(classifyTextKnowledgeFile('worker.ts', 'text/plain')).toBe('source');
    expect(classifyTextKnowledgeFile('notes.txt', 'text/markdown')).toBeUndefined();
    expect(classifyTextKnowledgeFile('image.png', 'image/png')).toBeUndefined();
  });

  it('extracts TXT lines with file version and line locators', () => {
    expect(
      extractTextKnowledgeChunks({
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('alpha\n\nbeta\n'),
        fileVersion: 1,
      }),
    ).toEqual({
      ok: true,
      kind: 'txt',
      chunks: [
        { text: 'alpha', fileVersion: 1, locator: { kind: 'line', start: 1, end: 1 } },
        { text: 'beta', fileVersion: 1, locator: { kind: 'line', start: 3, end: 3 } },
      ],
    });
  });

  it('extracts Markdown, JSON and source files with line locators', () => {
    expect(
      extractTextKnowledgeChunks({
        filename: 'readme.md',
        mediaType: 'text/markdown',
        bytes: Buffer.from('# Title'),
        fileVersion: 2,
      }),
    ).toMatchObject({
      ok: true,
      kind: 'markdown',
      chunks: [{ text: '# Title', fileVersion: 2, locator: { kind: 'line', start: 1, end: 1 } }],
    });
    expect(
      extractTextKnowledgeChunks({
        filename: 'payload.json',
        mediaType: 'application/json',
        bytes: Buffer.from('{\n  "ok": true\n}'),
        fileVersion: 1,
      }),
    ).toMatchObject({
      ok: true,
      kind: 'json',
      chunks: [
        { locator: { kind: 'line', start: 1, end: 1 } },
        { locator: { kind: 'line', start: 2, end: 2 } },
        { locator: { kind: 'line', start: 3, end: 3 } },
      ],
    });
    expect(
      extractTextKnowledgeChunks({
        filename: 'main.py',
        mediaType: 'text/plain',
        bytes: Buffer.from('print("hi")'),
        fileVersion: 1,
      }),
    ).toMatchObject({ ok: true, kind: 'source' });
  });

  it('extracts CSV and TSV rows with row locators', () => {
    expect(
      extractTextKnowledgeChunks({
        filename: 'table.csv',
        mediaType: 'text/csv',
        bytes: Buffer.from('name,qty\nbolt,2'),
        fileVersion: 1,
      }),
    ).toEqual({
      ok: true,
      kind: 'csv',
      chunks: [
        { text: 'name,qty', fileVersion: 1, locator: { kind: 'row', start: 1, end: 1 } },
        { text: 'bolt,2', fileVersion: 1, locator: { kind: 'row', start: 2, end: 2 } },
      ],
    });
    expect(
      extractTextKnowledgeChunks({
        filename: 'table.tsv',
        mediaType: 'text/tab-separated-values',
        bytes: Buffer.from('name\tqty'),
        fileVersion: 1,
      }),
    ).toMatchObject({
      ok: true,
      kind: 'tsv',
      chunks: [{ text: 'name\tqty', locator: { kind: 'row', start: 1, end: 1 } }],
    });
  });

  it('rejects unsupported files, invalid UTF-8 and oversize chunk counts', () => {
    expect(
      extractTextKnowledgeChunks({
        filename: 'photo.png',
        mediaType: 'image/png',
        bytes: Buffer.from('not-an-image'),
        fileVersion: 1,
      }),
    ).toEqual({ ok: false, error: 'unsupported_file' });
    expect(
      extractTextKnowledgeChunks({
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from([0xff, 0xfe, 0x00]),
        fileVersion: 1,
      }),
    ).toEqual({ ok: false, error: 'invalid_text' });
    expect(
      extractTextKnowledgeChunks({
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('ok'),
        fileVersion: 0,
      }),
    ).toEqual({ ok: false, error: 'extraction_limit' });
  });
});
