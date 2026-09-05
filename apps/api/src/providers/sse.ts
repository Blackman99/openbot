type SseFrame = { event: string; data: string };

export class SseDecoder {
  private line = '';
  private data: string[] = [];
  private event = '';
  private skipLf = false;

  feed(chunk: string): SseFrame[] {
    const frames: SseFrame[] = [];
    for (const character of chunk) {
      if (this.skipLf) {
        this.skipLf = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        const frame = this.consumeLine();
        if (frame) frames.push(frame);
        this.skipLf = character === '\r';
      } else this.line += character;
    }
    return frames;
  }

  private consumeLine(): SseFrame | undefined {
    const line = this.line;
    this.line = '';
    if (!line) {
      const frame = this.data.length
        ? { event: this.event, data: this.data.join('\n') }
        : undefined;
      this.data = [];
      this.event = '';
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.event = value;
    return undefined;
  }

  get hasPendingData(): boolean {
    return this.data.length > 0 || this.line === 'data' || this.line.startsWith('data:');
  }
}
