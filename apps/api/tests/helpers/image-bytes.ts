import { createHash } from 'node:crypto';

export const knowledgePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);

export function imageAttachmentMeta(
  bytes: Buffer,
  filename: string,
  mediaType: string,
  key: string,
) {
  return {
    idempotencyKey: key,
    body: 'Look at this photo',
    filename,
    mediaType,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
