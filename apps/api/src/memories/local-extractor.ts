import { createHash } from 'node:crypto';

const LINE_MARKERS = [
  'Remember:',
  'Preference:',
  'Decision:',
  '记住：',
  '偏好：',
  '决定：',
] as const;
const SECTION_HEADINGS = new Set(['Memory candidates', '记忆候选']);
const MAX_INPUT_CODE_POINTS = 32000;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_CANDIDATE_CODE_POINTS = 1000;
const MAX_CANDIDATE_BYTES = 4 * 1024;
const MAX_CANDIDATES = 10;

export type LocalExtraction =
  | { ok: true; candidates: Array<{ text: string; fingerprint: string }> }
  | { ok: false; error: 'extraction_limit' };

export function normalizeCandidateText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .replace(/[ \t]+/g, ' ');
}

export function candidateFingerprint(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function codePoints(text: string): number {
  return [...text].length;
}

function stripMarker(line: string): string | undefined {
  for (const marker of LINE_MARKERS) {
    if (line.startsWith(marker)) return line.slice(marker.length).trim();
  }
  return undefined;
}

function stripBullet(line: string): string | undefined {
  const match = /^[-*•]\s+(.+)$/.exec(line);
  return match?.[1]?.trim();
}

export function extractLocalMarkedLines(output: string): LocalExtraction {
  if (
    codePoints(output) > MAX_INPUT_CODE_POINTS ||
    Buffer.byteLength(output, 'utf8') > MAX_INPUT_BYTES
  )
    return { ok: false, error: 'extraction_limit' };
  const texts: string[] = [];
  let inFence = false;
  let inSection = false;
  for (const raw of output.split(/\r\n|\n|\r/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      inSection = false;
      continue;
    }
    if (inFence) continue;
    if (SECTION_HEADINGS.has(trimmed)) {
      inSection = true;
      continue;
    }
    const marked = stripMarker(trimmed);
    if (marked !== undefined) {
      inSection = false;
      if (!marked) continue;
      texts.push(marked);
      continue;
    }
    if (inSection) {
      if (!trimmed) {
        inSection = false;
        continue;
      }
      const bullet = stripBullet(trimmed);
      if (bullet) texts.push(bullet);
      else inSection = false;
    }
  }
  const candidates = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const normalized = normalizeCandidateText(text);
    if (!normalized) continue;
    if (
      codePoints(normalized) > MAX_CANDIDATE_CODE_POINTS ||
      Buffer.byteLength(normalized, 'utf8') > MAX_CANDIDATE_BYTES
    )
      return { ok: false, error: 'extraction_limit' };
    const fingerprint = candidateFingerprint(normalized);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    if (seen.size > MAX_CANDIDATES) return { ok: false, error: 'extraction_limit' };
    candidates.push({ text: normalized, fingerprint });
  }
  return { ok: true, candidates };
}
