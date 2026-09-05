export const TEXT_KNOWLEDGE_EXTRACTOR_VERSION = 'text-line-row-v1';
export const DEFAULT_SOURCE_EXTENSIONS = Object.freeze([
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'java',
  'js',
  'jsx',
  'kt',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsx',
  'yaml',
  'yml',
]);
const MAX_CHUNKS = 10_000;
const KIND_MEDIA: Record<Exclude<KnowledgeFileKind, 'source'>, readonly string[]> = {
  txt: ['text/plain'],
  markdown: ['text/markdown'],
  json: ['application/json'],
  csv: ['text/csv'],
  tsv: ['text/tab-separated-values'],
};

export type KnowledgeFileKind = 'txt' | 'markdown' | 'json' | 'csv' | 'tsv' | 'source';
export type KnowledgeLocatorKind = 'line' | 'row';
export interface KnowledgeChunk {
  text: string;
  fileVersion: number;
  locator: { kind: KnowledgeLocatorKind; start: number; end: number };
}
export type KnowledgeExtraction =
  | { ok: true; kind: KnowledgeFileKind; chunks: KnowledgeChunk[] }
  | { ok: false; error: 'unsupported_file' | 'invalid_text' | 'extraction_limit' };

export interface KnowledgeExtractionInput {
  filename: string;
  mediaType: string;
  bytes: Buffer;
  fileVersion: number;
  sourceExtensions?: readonly string[];
}

export function classifyTextKnowledgeFile(
  filename: string,
  mediaType: string,
  sourceExtensions: readonly string[] = DEFAULT_SOURCE_EXTENSIONS,
): KnowledgeFileKind | undefined {
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (!extension) return undefined;
  if (extension === 'txt' && KIND_MEDIA.txt.includes(mediaType)) return 'txt';
  if ((extension === 'md' || extension === 'markdown') && KIND_MEDIA.markdown.includes(mediaType))
    return 'markdown';
  if (extension === 'json' && KIND_MEDIA.json.includes(mediaType)) return 'json';
  if (extension === 'csv' && KIND_MEDIA.csv.includes(mediaType)) return 'csv';
  if (extension === 'tsv' && KIND_MEDIA.tsv.includes(mediaType)) return 'tsv';
  if (
    sourceExtensions.includes(extension) &&
    (mediaType === 'text/plain' || mediaType.startsWith('text/x-'))
  )
    return 'source';
  return undefined;
}

export function extractTextKnowledgeChunks(input: KnowledgeExtractionInput): KnowledgeExtraction {
  if (!Number.isSafeInteger(input.fileVersion) || input.fileVersion < 1)
    return { ok: false, error: 'extraction_limit' };
  const kind = classifyTextKnowledgeFile(
    input.filename,
    input.mediaType,
    input.sourceExtensions ?? DEFAULT_SOURCE_EXTENSIONS,
  );
  if (!kind) return { ok: false, error: 'unsupported_file' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return { ok: false, error: 'invalid_text' };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    return { ok: false, error: 'invalid_text' };
  const locatorKind: KnowledgeLocatorKind = kind === 'csv' || kind === 'tsv' ? 'row' : 'line';
  const chunks: KnowledgeChunk[] = [];
  const rows = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < rows.length; index++) {
    const line = rows[index]!;
    if (!line) continue;
    chunks.push({
      text: line,
      fileVersion: input.fileVersion,
      locator: { kind: locatorKind, start: index + 1, end: index + 1 },
    });
    if (chunks.length > MAX_CHUNKS) return { ok: false, error: 'extraction_limit' };
  }
  return { ok: true, kind, chunks };
}
