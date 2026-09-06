import sharp from 'sharp';

export class AvatarImageError extends Error {}
export class AvatarBusyError extends Error {}
export interface AvatarImage {
  bytes: Buffer;
  width: number;
  height: number;
}
export class AvatarImageDecoder {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly options: {
      process?: (bytes: Buffer, mediaType: string) => Promise<AvatarImage>;
      maxConcurrent?: number;
      maxQueued?: number;
      timeoutMs?: number;
    } = {},
  ) {}
  decode(bytes: Buffer, mediaType: string, signal?: AbortSignal): Promise<AvatarImage> {
    if (
      signal?.aborted ||
      (this.active >= (this.options.maxConcurrent ?? 2) &&
        this.queue.length >= (this.options.maxQueued ?? 8))
    )
      return Promise.reject(new AvatarBusyError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: unknown, value?: AvatarImage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        done(new AvatarBusyError());
      };
      const timer = setTimeout(abort, this.options.timeoutMs ?? 10_000);
      const start = () => {
        if (settled) return;
        this.active++;
        // A timed-out native job retains its slot until it really settles.
        // Otherwise queued requests could create unbounded background decodes.
        void (this.options.process ?? decodeImage)(bytes, mediaType)
          .then((value) => done(undefined, value), done)
          .finally(() => {
            this.active--;
            this.queue.shift()?.();
          });
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (this.active < (this.options.maxConcurrent ?? 2)) start();
      else this.queue.push(start);
    });
  }
}
async function decodeImage(bytes: Buffer, mediaType: string): Promise<AvatarImage> {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (
    !bytes.length ||
    bytes.length > 2097152 ||
    (!png && !jpeg) ||
    mediaType !== (png ? 'image/png' : 'image/jpeg')
  )
    throw new AvatarImageError();
  if (png) {
    let position = 8,
      ended = false;
    while (position + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(position),
        type = bytes.toString('ascii', position + 4, position + 8);
      if (size > bytes.length - position - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type))
        throw new AvatarImageError();
      position += size + 12;
      if (type === 'IEND') {
        ended = size === 0 && position === bytes.length;
        break;
      }
    }
    if (!ended) throw new AvatarImageError();
  }
  try {
    const image = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: 4194304,
      limitInputChannels: 4,
      unlimited: false,
    });
    const metadata = await image.metadata();
    if (
      !['png', 'jpeg'].includes(metadata.format ?? '') ||
      mediaType !== `image/${metadata.format}` ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      metadata.depth !== 'uchar'
    )
      throw new AvatarImageError();
    const result = await image
      .autoOrient()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .png()
      .timeout({ seconds: 3 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch {
    throw new AvatarImageError();
  }
}
