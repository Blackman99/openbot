import { describe, expect, it } from 'vitest';
import { extractKnowledgeChunks } from '../../src/knowledge/document-extractor.js';
import { knowledgeDocx, knowledgeXlsx, textPdf } from '../helpers/document-bytes.js';

describe('document-page-cell-v1', () => {
  it('extracts searchable PDF pages with page-number locators', () => {
    expect(
      extractKnowledgeChunks({
        filename: 'notes.pdf',
        mediaType: 'application/pdf',
        bytes: textPdf(['Quarterly notes', 'Keep the cobalt key']),
        fileVersion: 1,
      }),
    ).toEqual({
      ok: true,
      kind: 'pdf',
      chunks: [
        { text: 'Quarterly notes', fileVersion: 1, locator: { kind: 'page', start: 1, end: 1 } },
        {
          text: 'Keep the cobalt key',
          fileVersion: 1,
          locator: { kind: 'page', start: 2, end: 2 },
        },
      ],
    });
  });

  it('extracts DOCX headings and paragraphs that name the heading path', () => {
    expect(
      extractKnowledgeChunks({
        filename: 'notes.docx',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: knowledgeDocx('Quarterly notes', 'Keep the cobalt key'),
        fileVersion: 1,
      }),
    ).toEqual({
      ok: true,
      kind: 'docx',
      chunks: [
        {
          text: 'Quarterly notes',
          fileVersion: 1,
          locator: { kind: 'paragraph', start: 1, end: 1, ref: 'Quarterly notes' },
        },
        {
          text: 'Keep the cobalt key',
          fileVersion: 1,
          locator: { kind: 'paragraph', start: 2, end: 2, ref: 'Quarterly notes' },
        },
      ],
    });
  });

  it('extracts XLSX cells with worksheet and cell-range locators', () => {
    expect(
      extractKnowledgeChunks({
        filename: 'keys.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: knowledgeXlsx('Keys', 'B2', 'Keep the cobalt key'),
        fileVersion: 1,
      }),
    ).toEqual({
      ok: true,
      kind: 'xlsx',
      chunks: [
        {
          text: 'Keep the cobalt key',
          fileVersion: 1,
          locator: { kind: 'cells', start: 2, end: 2, ref: 'Keys!B2:B2' },
        },
      ],
    });
  });

  it('fails encrypted, corrupt, unsupported, and over-limit documents without chunks', () => {
    expect(
      extractKnowledgeChunks({
        filename: 'secret.pdf',
        mediaType: 'application/pdf',
        bytes: textPdf(['hidden'], { encrypt: true }),
        fileVersion: 1,
      }),
    ).toEqual({ ok: false, error: 'encrypted_file' });
    expect(
      extractKnowledgeChunks({
        filename: 'broken.pdf',
        mediaType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4\nnot a document'),
        fileVersion: 1,
      }),
    ).toEqual({ ok: false, error: 'corrupt_file' });
    expect(
      extractKnowledgeChunks({
        filename: 'empty.pdf',
        mediaType: 'application/pdf',
        bytes: textPdf(['']),
        fileVersion: 1,
      }),
    ).toEqual({ ok: false, error: 'unsupported_file' });
    expect(
      extractKnowledgeChunks({
        filename: 'notes.pdf',
        mediaType: 'application/pdf',
        bytes: textPdf(['ok']),
        fileVersion: 0,
      }),
    ).toEqual({ ok: false, error: 'extraction_limit' });
  });
});
