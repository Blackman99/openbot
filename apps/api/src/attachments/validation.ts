import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AvatarImageDecoder } from '../bots/avatar-image.js';
import { AttachmentInputError, type AttachmentCommand } from './types.js';
import { validateOfficeFamily } from './office-family.js';
import { readBoundedZip } from './zip.js';
const media = new Map([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);
const images = new AvatarImageDecoder({
  process: async (bytes, mediaType) => {
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if ((!png && !jpeg) || mediaType !== (png ? 'image/png' : 'image/jpeg'))
      throw new AttachmentInputError();
    if (png) {
      let offset = 8,
        ended = false;
      while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset),
          type = bytes.toString('ascii', offset + 4, offset + 8);
        if (size > bytes.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type))
          throw new AttachmentInputError();
        offset += size + 12;
        if (type === 'IEND') {
          ended = size === 0 && offset === bytes.length;
          break;
        }
      }
      if (!ended) throw new AttachmentInputError();
    } else if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new AttachmentInputError();
    const image = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: 16777216,
      limitInputChannels: 4,
    });
    const info = await image.metadata();
    if (
      info.format !== (png ? 'png' : 'jpeg') ||
      info.depth !== 'uchar' ||
      !info.width ||
      !info.height ||
      info.width > 8192 ||
      info.height > 8192 ||
      (info.pages ?? 1) !== 1
    )
      throw new AttachmentInputError();
    await image.raw().timeout({ seconds: 3 }).toBuffer();
    return { bytes: Buffer.alloc(0), width: info.width, height: info.height };
  },
});
function utf8(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    throw new AttachmentInputError();
  return text;
}
// Inspect the bounded ZIP container and declared OOXML family; never execute macros.
function office(bytes: Buffer, extension: string) {
  validateOfficeFamily(readBoundedZip(bytes), extension);
}
export async function validateAttachment(
  bytes: Buffer,
  command: AttachmentCommand,
  signal?: AbortSignal,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    const extension = command.filename.split('.').at(-1)!.toLowerCase();
    if (
      media.get(extension) !== command.mediaType ||
      bytes.length !== command.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== command.sha256
    )
      throw new AttachmentInputError();
    if (['txt', 'md', 'csv'].includes(extension)) {
      const text = utf8(bytes);
      if (/^\s*(?:<!doctype\s+html|<html\b|<svg\b|#!|<\?xml)/iu.test(text))
        throw new AttachmentInputError();
    } else if (['png', 'jpg', 'jpeg'].includes(extension))
      await images.decode(bytes, command.mediaType, signal);
    else if (extension === 'pdf') {
      if (
        !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u.test(bytes.subarray(0, 20).toString('latin1')) ||
        !/%%EOF\s*$/u.test(bytes.subarray(-1024).toString('latin1')) ||
        !/\d+\s+\d+\s+obj\b/u.test(bytes.toString('latin1'))
      )
        throw new AttachmentInputError();
    } else office(bytes, extension);
    signal?.throwIfAborted();
  } catch {
    throw new AttachmentInputError();
  }
}
