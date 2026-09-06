import { STREAM_LIMITS } from '../conversations/stream-protocol.js';

// One outstanding publication plus one <=4KiB pending segment. The provider's
// awaited callback supplies backpressure; a terminal rebuild never calls push.
export class TaskDeltaPublication {
  private pending = '';
  private pendingBytes = 0;
  private published = false;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  constructor(
    private readonly publish: (text: string) => Promise<void>,
    private readonly failed: () => void,
  ) {}
  async push(text: string) {
    await this.inFlight;
    if (this.failure) throw this.failure;
    for (const character of text) {
      const bytes = Buffer.byteLength(character);
      if (this.pendingBytes + bytes > STREAM_LIMITS.deltaBytes) await this.flush();
      this.pending += character;
      this.pendingBytes += bytes;
      if (this.pendingBytes === STREAM_LIMITS.deltaBytes) await this.flush();
    }
    if (!this.published) await this.flush();
    else if (this.pending && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => this.failed());
      }, STREAM_LIMITS.coalesceMs);
    }
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    if (this.failure) throw this.failure;
    if (!this.pending) return;
    const text = this.pending;
    this.pending = '';
    this.pendingBytes = 0;
    this.published = true;
    const operation = this.publish(text).catch((error: unknown) => {
      this.failure = error;
      throw error;
    });
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = undefined;
    }
  }
  async discard() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
    this.pendingBytes = 0;
    await this.inFlight?.catch(() => undefined);
  }
}
