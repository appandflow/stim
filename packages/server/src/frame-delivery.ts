export const FRAME_RETRY_MS = 50;
const FRAME_BUFFER_FRAMES = 2;

export class LatestFrames<T extends { data: string }> {
  private pending: T | null = null;
  private retry: NodeJS.Timeout | null = null;
  private sentAt = 0;
  private stopped = false;
  private readonly fps: number;
  private readonly buffered: () => number;
  private readonly send: (frame: T) => void;

  constructor(fps: number, buffered: () => number, send: (frame: T) => void) {
    this.fps = fps;
    this.buffered = buffered;
    this.send = send;
  }

  push(frame: T): void {
    if (this.stopped) return;
    this.pending = frame;
    if (!this.retry) this.flush();
  }

  private flush(): void {
    this.retry = null;
    if (!this.pending || this.stopped) return;
    const wait = this.sentAt + 1000 / this.fps - Date.now();
    if (wait > 0) {
      this.retry = setTimeout(() => this.flush(), wait);
      return;
    }
    if (this.buffered() > FRAME_BUFFER_FRAMES * this.pending.data.length) {
      this.retry = setTimeout(() => this.flush(), FRAME_RETRY_MS);
      return;
    }
    const frame = this.pending;
    this.pending = null;
    this.sentAt = Date.now();
    this.send(frame);
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}
