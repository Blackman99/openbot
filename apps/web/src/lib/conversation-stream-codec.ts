import {
  MAX_STREAM_FRAME_BYTES,
  parseConversationStreamEvent,
  type ConversationStreamControl,
  type ConversationStreamFrame,
  type ConversationStreamScope,
} from './conversation-stream-contract.js';
export class ConversationStreamDecodeError extends Error {
  constructor() {
    super('invalid_stream_frame');
  }
}
export class ConversationStreamDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private line = '';
  private frameBytes = 0;
  private pendingCR = false;
  private firstLine = true;
  private closed = false;
  private terminal = false;
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];
  constructor(private readonly scope: ConversationStreamScope) {}
  get atFrameBoundary(): boolean {
    return this.frameBytes === 0 && !this.pendingCR;
  }
  feed(bytes: Uint8Array): ConversationStreamFrame[] {
    try {
      if (this.closed || bytes.byteLength > 512 * 1024 || (this.terminal && bytes.byteLength))
        this.fail();
      const frames: ConversationStreamFrame[] = [];
      let start = 0;
      for (let i = 0; i < bytes.byteLength; i++) {
        const byte = bytes[i];
        if (this.pendingCR) {
          this.pendingCR = false;
          if (byte === 10) {
            this.countByte();
            this.completeLine(frames);
            start = i + 1;
            continue;
          }
          this.completeLine(frames);
          start = i;
        }
        if (this.terminal) this.fail();
        this.countByte();
        if (byte === 13 || byte === 10) {
          this.append(bytes.subarray(start, i));
          if (byte === 13) this.pendingCR = true;
          else this.completeLine(frames);
          start = i + 1;
        }
      }
      this.append(bytes.subarray(start));
      return frames;
    } catch {
      return this.fail();
    }
  }
  finish(): ConversationStreamFrame[] {
    try {
      if (this.closed) this.fail();
      const frames: ConversationStreamFrame[] = [];
      if (this.pendingCR) {
        this.pendingCR = false;
        this.completeLine(frames);
      }
      this.line += this.decoder.decode();
      if (
        this.line ||
        this.frameBytes ||
        this.id !== undefined ||
        this.event !== undefined ||
        this.data.length
      )
        this.fail();
      this.closed = true;
      return frames;
    } catch {
      return this.fail();
    }
  }
  private fail(): never {
    this.closed = true;
    this.line = '';
    this.data = [];
    this.id = this.event = undefined;
    throw new ConversationStreamDecodeError();
  }
  private countByte() {
    if (++this.frameBytes > MAX_STREAM_FRAME_BYTES) this.fail();
  }
  private append(bytes: Uint8Array) {
    this.line += this.decoder.decode(bytes, { stream: true });
  }
  private completeLine(frames: ConversationStreamFrame[]) {
    this.line += this.decoder.decode();
    let line = this.line;
    this.line = '';
    if (this.firstLine && line.startsWith('\ufeff')) line = line.slice(1);
    this.firstLine = false;
    if (!line) {
      if (this.data.length) frames.push(this.dispatch());
      else if (this.id !== undefined || this.event !== undefined) this.fail();
      this.frameBytes = 0;
      this.id = this.event = undefined;
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') {
      if (this.id !== undefined || !value || value.includes('\0')) this.fail();
      this.id = value;
    } else if (field === 'event') {
      if (this.event !== undefined || !value) this.fail();
      this.event = value;
    } else if (field === 'data') this.data.push(value);
  }
  private dispatch(): ConversationStreamFrame {
    const value: unknown = JSON.parse(this.data.join('\n'));
    if (this.event === 'stream.control') {
      if (
        this.id !== undefined ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'code,schemaVersion' ||
        !('schemaVersion' in value) ||
        value.schemaVersion !== 1 ||
        !('code' in value) ||
        !control(value.code)
      )
        return this.fail();
      this.terminal = true;
      return { kind: 'control', code: value.code };
    }
    const event = parseConversationStreamEvent(value, this.scope);
    if (!event || this.id !== event.cursor || this.event !== event.type) return this.fail();
    return { kind: 'event', event };
  }
}
function control(value: unknown): value is ConversationStreamControl {
  return (
    value === 'authentication_required' ||
    value === 'conversation_forbidden' ||
    value === 'cursor_expired' ||
    value === 'slow_consumer' ||
    value === 'conversation_stream_unavailable'
  );
}
