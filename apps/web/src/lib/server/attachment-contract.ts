export const mediaByExtension: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export function parseAttachment(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'bytes,filename,id,mediaType'
  )
    return undefined;
  const item = value as Record<string, unknown>;
  if (
    !(
      typeof item.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id)
    ) ||
    typeof item.filename !== 'string' ||
    !safeFilename(item.filename) ||
    typeof item.mediaType !== 'string' ||
    !Object.values(mediaByExtension).includes(item.mediaType) ||
    typeof item.bytes !== 'number' ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes < 1 ||
    item.bytes > 67108864
  )
    return undefined;
  return {
    id: item.id.toLowerCase(),
    filename: item.filename,
    mediaType: item.mediaType,
    bytes: item.bytes,
  };
}
export function safeFilename(value: string) {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 180 &&
    value.normalize('NFC') === value &&
    !/[\p{C}<>:"/\\|?*]/u.test(value) &&
    !/^[. ]|[. ]$/u.test(value)
  );
}
