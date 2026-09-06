import { inflateRawSync, crc32 } from 'node:zlib';
import { AttachmentInputError } from './types.js';

function utf8(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    throw new AttachmentInputError();
  return text;
}

export function readBoundedZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length < 22 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50)
    throw new AttachmentInputError();
  const end = bytes.length - 22;
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    throw new AttachmentInputError();
  const count = bytes.readUInt16LE(end + 10),
    directorySize = bytes.readUInt32LE(end + 12),
    directory = bytes.readUInt32LE(end + 16);
  if (
    !count ||
    count > 1000 ||
    count !== bytes.readUInt16LE(end + 8) ||
    directory + directorySize !== end
  )
    throw new AttachmentInputError();
  const files = new Map<string, Buffer>();
  let position = directory,
    expanded = 0;
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50)
      throw new AttachmentInputError();
    const flags = bytes.readUInt16LE(position + 8),
      method = bytes.readUInt16LE(position + 10),
      crc = bytes.readUInt32LE(position + 16),
      compressed = bytes.readUInt32LE(position + 20),
      size = bytes.readUInt32LE(position + 24),
      nameLength = bytes.readUInt16LE(position + 28),
      extra = bytes.readUInt16LE(position + 30),
      comment = bytes.readUInt16LE(position + 32),
      local = bytes.readUInt32LE(position + 42);
    if (
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(position + 34) !== 0 ||
      position + 46 + nameLength + extra + comment > end ||
      local + 30 > directory ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw new AttachmentInputError();
    const name = utf8(bytes.subarray(position + 46, position + 46 + nameLength));
    if (
      !name ||
      name.length > 250 ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      files.has(name) ||
      /(?:vbaProject|\.exe$|\.bin$|activeX\/)/iu.test(name)
    )
      throw new AttachmentInputError();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28),
      stop = start + compressed;
    if (
      stop > directory ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      utf8(bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26))) !== name ||
      spans.some(([left, right]) => local < right && stop > left)
    )
      throw new AttachmentInputError();
    spans.push([local, stop]);
    expanded += size;
    if (
      size > 16 * 1024 * 1024 ||
      expanded > 64 * 1024 * 1024 ||
      (size > 1024 * 1024 && size > compressed * 100)
    )
      throw new AttachmentInputError();
    const data =
      method === 0
        ? bytes.subarray(start, stop)
        : inflateRawSync(bytes.subarray(start, stop), { maxOutputLength: Math.max(1, size) });
    if (data.length !== size || crc32(data) !== crc) throw new AttachmentInputError();
    files.set(name, data);
    position += 46 + nameLength + extra + comment;
  }
  if (position !== end) throw new AttachmentInputError();
  return files;
}
