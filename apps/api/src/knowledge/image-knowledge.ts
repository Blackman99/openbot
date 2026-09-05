import type { KnowledgeChunk, KnowledgeFileKind } from './text-extractor.js';
import { KnowledgeInputError } from './types.js';

export const IMAGE_KNOWLEDGE_EXTRACTOR_VERSION = 'image-description-v1';
export const IMAGE_MEDIA = ['image/png', 'image/jpeg'] as const;

export function classifyKnowledgeImage(
  filename: string,
  mediaType: string,
): Extract<KnowledgeFileKind, 'image'> | undefined {
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (
    (extension === 'png' && mediaType === 'image/png') ||
    ((extension === 'jpg' || extension === 'jpeg') && mediaType === 'image/jpeg')
  )
    return 'image';
  return undefined;
}

export function imageKnowledgeChunk(
  title: string,
  description: string,
  fileVersion: number,
): KnowledgeChunk {
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  if (
    !trimmedTitle ||
    !trimmedDescription ||
    trimmedTitle.length > 200 ||
    trimmedDescription.length > 4000
  )
    throw new KnowledgeInputError('image_description_required');
  return {
    text: `${trimmedTitle}\n${trimmedDescription}`,
    fileVersion,
    locator: { kind: 'line', start: 1, end: 1, ref: trimmedTitle },
  };
}
