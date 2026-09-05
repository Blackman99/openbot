import { inflateSync } from 'node:zlib';
import { AttachmentInputError } from '../attachments/types.js';
import { readBoundedZip } from '../attachments/zip.js';
import {
  MAX_KNOWLEDGE_CHUNKS,
  extractTextKnowledgeChunks,
  type KnowledgeChunk,
  type KnowledgeExtraction,
  type KnowledgeExtractionInput,
  type KnowledgeFileKind,
} from './text-extractor.js';

export function extractKnowledgeChunks(input: KnowledgeExtractionInput): KnowledgeExtraction {
  const text = extractTextKnowledgeChunks(input);
  if (text.ok || text.error !== 'unsupported_file') return text;
  return extractDocumentKnowledgeChunks(input);
}

export const DOCUMENT_KNOWLEDGE_EXTRACTOR_VERSION = 'document-page-cell-v1';

const DOCUMENT_MEDIA: Record<
  Exclude<KnowledgeFileKind, 'txt' | 'markdown' | 'json' | 'csv' | 'tsv' | 'source' | 'image'>,
  string
> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function classifyDocumentKnowledgeFile(
  filename: string,
  mediaType: string,
): Extract<KnowledgeFileKind, 'pdf' | 'docx' | 'xlsx'> | undefined {
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (extension === 'pdf' && mediaType === DOCUMENT_MEDIA.pdf) return 'pdf';
  if (extension === 'docx' && mediaType === DOCUMENT_MEDIA.docx) return 'docx';
  if (extension === 'xlsx' && mediaType === DOCUMENT_MEDIA.xlsx) return 'xlsx';
  return undefined;
}

export function extractDocumentKnowledgeChunks(
  input: KnowledgeExtractionInput,
): KnowledgeExtraction {
  if (!Number.isSafeInteger(input.fileVersion) || input.fileVersion < 1)
    return { ok: false, error: 'extraction_limit' };
  const kind = classifyDocumentKnowledgeFile(input.filename, input.mediaType);
  if (!kind) return { ok: false, error: 'unsupported_file' };
  try {
    if (kind === 'pdf') return extractPdf(input.bytes, input.fileVersion);
    if (kind === 'docx') return extractDocx(input.bytes, input.fileVersion);
    return extractXlsx(input.bytes, input.fileVersion);
  } catch (error) {
    if (error instanceof DocumentExtractionError) return { ok: false, error: error.code };
    if (error instanceof AttachmentInputError) return { ok: false, error: 'corrupt_file' };
    return { ok: false, error: 'corrupt_file' };
  }
}

class DocumentExtractionError extends Error {
  constructor(readonly code: Exclude<KnowledgeExtraction, { ok: true }>['error']) {
    super(code);
  }
}

function fail(code: DocumentExtractionError['code']): never {
  throw new DocumentExtractionError(code);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractPdf(bytes: Buffer, fileVersion: number): KnowledgeExtraction {
  const source = bytes.toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.0)/u.test(source) || !/%%EOF\s*$/u.test(source)) fail('corrupt_file');
  const stripped = source.replace(/stream\r?\n[\s\S]*?endstream/gu, 'stream\nendstream');
  if (/\/Encrypt(?:[\s\/><]|$)/u.test(stripped)) fail('encrypted_file');
  const objects = new Map<number, { body: string; stream?: Buffer }>();
  const objectPattern = /(\d+)\s+0\s+obj\b/gu;
  let found: RegExpExecArray | null;
  while ((found = objectPattern.exec(source))) {
    const id = Number(found[1]);
    const start = found.index + found[0].length;
    const end = source.indexOf('endobj', start);
    if (end === -1) fail('corrupt_file');
    const body = source.slice(start, end);
    const streamAt = body.search(/\bstream\r?\n/u);
    if (streamAt === -1) {
      objects.set(id, { body });
      continue;
    }
    const header = body.slice(0, streamAt);
    const streamStart = start + streamAt + body.slice(streamAt).match(/^stream\r?\n/u)![0].length;
    const streamEnd = source.indexOf('endstream', streamStart);
    if (streamEnd === -1) fail('corrupt_file');
    let payload = Buffer.from(source.slice(streamStart, streamEnd), 'latin1');
    if (payload[payload.length - 1] === 10) payload = payload.subarray(0, -1);
    if (payload[payload.length - 1] === 13) payload = payload.subarray(0, -1);
    if (/\/Filter\s*\/FlateDecode\b/u.test(header)) {
      try {
        payload = inflateSync(payload);
      } catch {
        fail('corrupt_file');
      }
    } else if (/\/Filter\b/u.test(header)) fail('unsupported_file');
    objects.set(id, { body: header, stream: payload });
    objectPattern.lastIndex = end + 6;
  }
  if (!objects.size) fail('corrupt_file');
  const catalog = [...objects.values()].find((object) => /\/Type\s*\/Catalog\b/u.test(object.body));
  const pagesRef = catalog?.body.match(/\/Pages\s+(\d+)\s+0\s+R/u);
  if (!pagesRef) fail('corrupt_file');
  const pageIds: number[] = [];
  const visit = (id: number) => {
    const object = objects.get(id);
    if (!object) fail('corrupt_file');
    if (/\/Type\s*\/Pages\b/u.test(object.body)) {
      const kids = object.body.match(/\/Kids\s*\[([^\]]*)\]/u)?.[1] ?? '';
      for (const child of kids.matchAll(/(\d+)\s+0\s+R/gu)) visit(Number(child[1]));
      return;
    }
    if (/\/Type\s*\/Page\b/u.test(object.body)) {
      pageIds.push(id);
      return;
    }
    fail('corrupt_file');
  };
  visit(Number(pagesRef[1]));
  if (!pageIds.length) fail('corrupt_file');
  const chunks: KnowledgeChunk[] = [];
  for (const [index, pageId] of pageIds.entries()) {
    const page = objects.get(pageId);
    if (!page) fail('corrupt_file');
    const contentIds: number[] = [];
    const single = page.body.match(/\/Contents\s+(\d+)\s+0\s+R/u)?.[1];
    if (single) contentIds.push(Number(single));
    const array = page.body.match(/\/Contents\s*\[([^\]]*)\]/u)?.[1];
    if (array)
      contentIds.push(...[...array.matchAll(/(\d+)\s+0\s+R/gu)].map((match) => Number(match[1])));
    const text = contentIds
      .map((id) => pdfText(objects.get(id)?.stream?.toString('latin1') ?? ''))
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!text) continue;
    chunks.push({
      text,
      fileVersion,
      locator: { kind: 'page', start: index + 1, end: index + 1 },
    });
    if (chunks.length > MAX_KNOWLEDGE_CHUNKS) fail('extraction_limit');
  }
  if (!chunks.length) fail('unsupported_file');
  return { ok: true, kind: 'pdf', chunks };
}

function pdfText(content: string): string {
  const parts: string[] = [];
  for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/gu))
    parts.push(unescapePdf(match[1]!));
  for (const match of content.matchAll(/\[(.*?)\]\s*TJ/gsu)) {
    for (const item of match[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)/gu))
      parts.push(unescapePdf(item[1]!));
  }
  return parts.join(' ');
}

function unescapePdf(value: string): string {
  return value
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r')
    .replace(/\\t/gu, '\t')
    .replace(/\\([()\\])/gu, '$1');
}

function extractDocx(bytes: Buffer, fileVersion: number): KnowledgeExtraction {
  const files = readBoundedZip(bytes);
  const document = files.get('word/document.xml');
  if (!document) fail('corrupt_file');
  const xml = document.toString('utf8');
  const chunks: KnowledgeChunk[] = [];
  let heading: string | undefined;
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)];
  for (const [index, paragraph] of paragraphs.entries()) {
    const body = paragraph[1]!;
    const style = body.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/u)?.[1];
    const text = [...body.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
      .map((match) => decodeXml(match[1]!))
      .join('')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!text) continue;
    const isHeading = !!style && /^(?:Heading\d|Title)$/iu.test(style);
    if (isHeading) heading = text;
    const locator: KnowledgeChunk['locator'] = {
      kind: 'paragraph',
      start: index + 1,
      end: index + 1,
    };
    if (heading) locator.ref = heading;
    chunks.push({ text, fileVersion, locator });
    if (chunks.length > MAX_KNOWLEDGE_CHUNKS) fail('extraction_limit');
  }
  if (!chunks.length) fail('unsupported_file');
  return { ok: true, kind: 'docx', chunks };
}

function extractXlsx(bytes: Buffer, fileVersion: number): KnowledgeExtraction {
  const files = readBoundedZip(bytes);
  const workbook = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) fail('corrupt_file');
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
  const targets = new Map<string, string>();
  for (const match of rels
    .toString('utf8')
    .matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/gu))
    targets.set(match[1]!, match[2]!.replace(/^\//u, '').replace(/^xl\//u, 'xl/'));
  const chunks: KnowledgeChunk[] = [];
  for (const sheet of workbook
    .toString('utf8')
    .matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/gu)) {
    const name = decodeXml(sheet[1]!);
    const target = targets.get(sheet[2]!);
    if (!target) fail('corrupt_file');
    const path = target.startsWith('xl/') ? target : `xl/${target}`;
    const xml = files.get(path)?.toString('utf8');
    if (!xml) fail('corrupt_file');
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const ref = cell[1]!.match(/\br="([A-Z]+\d+)"/u)?.[1];
      const type = cell[1]!.match(/\bt="([^"]+)"/u)?.[1];
      if (!ref) continue;
      let text = '';
      if (type === 's') {
        const index = Number(cell[2]!.match(/<v>(\d+)<\/v>/u)?.[1]);
        text = shared[index] ?? '';
      } else if (type === 'inlineStr')
        text = [...cell[2]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
          .map((match) => decodeXml(match[1]!))
          .join('');
      else text = decodeXml(cell[2]!.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? '');
      text = text.replace(/\s+/gu, ' ').trim();
      if (!text) continue;
      const row = Number(ref.match(/\d+/u)?.[0]);
      chunks.push({
        text,
        fileVersion,
        locator: { kind: 'cells', start: row, end: row, ref: `${name}!${ref}:${ref}` },
      });
      if (chunks.length > MAX_KNOWLEDGE_CHUNKS) fail('extraction_limit');
    }
  }
  if (!chunks.length) fail('unsupported_file');
  return { ok: true, kind: 'xlsx', chunks };
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((item) =>
    [...item[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
      .map((match) => decodeXml(match[1]!))
      .join(''),
  );
}
