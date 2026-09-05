import { crc32 } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  AvatarImageDecoder,
  AvatarImageError,
  AvatarBusyError,
} from '../../src/bots/avatar-image.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
function chunk(type: string, bytes: Buffer) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(type, 4);
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, bytes.length + 8)), bytes.length + 8);
  return result;
}
it('rejects APNG control chunks even when a static PNG decoder would ignore animation', async () => {
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(1);
  const frame = Buffer.alloc(26);
  frame.writeUInt32BE(1, 4);
  frame.writeUInt32BE(1, 8);
  frame.writeUInt16BE(1, 20);
  frame.writeUInt16BE(1, 22);
  const apng = Buffer.concat([
    png.subarray(0, 33),
    chunk('acTL', animation),
    chunk('fcTL', frame),
    png.subarray(33),
  ]);
  await expect(new AvatarImageDecoder().decode(apng, 'image/png')).rejects.toBeInstanceOf(
    AvatarImageError,
  );
});
it('bounds active decodes and the queue while charging queue wait to the complete deadline', async () => {
  vi.useFakeTimers();
  let finish!: (value: { bytes: Buffer; width: number; height: number }) => void;
  const pending = new Promise<{ bytes: Buffer; width: number; height: number }>((resolve) => {
    finish = resolve;
  });
  const process = vi.fn(async () => pending);
  const decoder = new AvatarImageDecoder({
    process,
    maxConcurrent: 1,
    maxQueued: 1,
    timeoutMs: 100,
  });
  const first = decoder.decode(png, 'image/png');
  const second = decoder.decode(png, 'image/png');
  const firstCheck = first.catch((error) => error);
  const secondCheck = second.catch((error) => error);
  try {
    await expect(decoder.decode(png, 'image/png')).rejects.toBeInstanceOf(AvatarBusyError);
    expect(process).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(await firstCheck).toBeInstanceOf(AvatarBusyError);
    expect(await secondCheck).toBeInstanceOf(AvatarBusyError);
    finish({ bytes: png, width: 1, height: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(process).toHaveBeenCalledTimes(1);
  } finally {
    finish({ bytes: png, width: 1, height: 1 });
    vi.useRealTimers();
  }
});
it('fully decodes supported images, strips source metadata, orients and fits without enlargement', async () => {
  const jpeg = await sharp({
    create: { width: 800, height: 400, channels: 3, background: '#ff0000' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const output = await new AvatarImageDecoder().decode(jpeg, 'image/jpeg');
  expect(output).toMatchObject({ width: 256, height: 512 });
  const metadata = await sharp(output.bytes).metadata();
  expect(metadata).toMatchObject({ format: 'png', width: 256, height: 512 });
  expect(metadata.exif).toBeUndefined();
  expect(metadata.icc).toBeUndefined();
  expect(metadata.xmp).toBeUndefined();
  const tiny = await new AvatarImageDecoder().decode(png, 'image/png');
  expect(tiny).toMatchObject({ width: 1, height: 1 });
  expect(await sharp(tiny.bytes).removeAlpha().raw().toBuffer()).toEqual(Buffer.from([255, 0, 0]));
});
it('rejects byte, dimension, total-pixel, format, truncation and decoder-depth violations', async () => {
  const decoder = new AvatarImageDecoder();
  const tooWide = await sharp({
    create: { width: 4097, height: 1, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const tooManyPixels = await sharp({
    create: { width: 4096, height: 1025, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const png16 = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
    .toColourspace('rgb16')
    .png()
    .toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  for (const [bytes, type] of [
    [Buffer.alloc(0), 'image/png'],
    [Buffer.concat([png, Buffer.alloc(2097152)]), 'image/png'],
    [tooWide, 'image/png'],
    [tooManyPixels, 'image/png'],
    [png16, 'image/png'],
    [png, 'image/jpeg'],
    [jpeg.subarray(0, jpeg.length - 15), 'image/jpeg'],
    [png.subarray(0, png.length - 5), 'image/png'],
  ] as const)
    await expect(decoder.decode(bytes, type)).rejects.toBeInstanceOf(AvatarImageError);
});
