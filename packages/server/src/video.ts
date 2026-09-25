import { VIDEO_HEADER_VERSION, VIDEO_KEYFRAME } from './protocol.ts';

/** One H.264 access unit from the helper, in Annex-B form; a keyframe starts with its SPS and PPS. */
export interface AccessUnit {
  keyframe: boolean;
  /** Milliseconds since the epoch, on the Mac's clock. */
  capturedAt: number;
  width: number;
  height: number;
  data: Buffer;
}

const FIXED_HEADER_BYTES = 21;

/** The binary WebSocket message for `unit` on `subscription`; see `VideoPacket` in protocol.ts for the layout. */
export function videoPacket(subscription: string, sequence: number, unit: AccessUnit): Buffer {
  const id = Buffer.from(subscription, 'ascii');
  const header = Buffer.alloc(FIXED_HEADER_BYTES + id.length);
  header.writeUInt8(VIDEO_HEADER_VERSION, 0);
  header.writeUInt8(unit.keyframe ? VIDEO_KEYFRAME : 0, 1);
  header.writeUInt16BE(header.length, 2);
  header.writeUInt32BE(sequence >>> 0, 4);
  header.writeDoubleBE(unit.capturedAt, 8);
  header.writeUInt16BE(unit.width, 16);
  header.writeUInt16BE(unit.height, 18);
  header.writeUInt8(id.length, 20);
  id.copy(header, FIXED_HEADER_BYTES);
  return Buffer.concat([header, unit.data]);
}

export interface VideoLimits {
  /** A subscriber whose socket holds more than this drops frames until the next keyframe. */
  congestedBytes: number;
  startBitrate: number;
  minBitrate: number;
  maxBitrate: number;
  /** How long the encoder must go without congestion before the bitrate rises by a quarter. */
  recoverMs: number;
}

export const DEFAULT_VIDEO_LIMITS: VideoLimits = {
  congestedBytes: 256 * 1024,
  startBitrate: 3_000_000,
  minBitrate: 250_000,
  maxBitrate: 8_000_000,
  recoverMs: 2000,
};

/**
 * Decides, for one subscriber, whether each access unit goes out. A subscriber starts waiting for a keyframe.
 * When its socket backs up it drops everything until the next keyframe, because a P-frame is useless without
 * the frames before it; `congested` is reported once per episode.
 */
export class VideoGate {
  private waiting = true;
  private readonly congestedBytes: number;

  constructor(congestedBytes: number) {
    this.congestedBytes = congestedBytes;
  }

  admit(unit: Pick<AccessUnit, 'keyframe'>, bufferedBytes: number): 'send' | 'drop' | 'congested' {
    if (bufferedBytes > this.congestedBytes) {
      if (this.waiting) return 'drop';
      this.waiting = true;
      return 'congested';
    }
    if (this.waiting && !unit.keyframe) return 'drop';
    this.waiting = false;
    return 'send';
  }

  /** The client lost its decoder state; drop until the keyframe it asked for. */
  reset(): void {
    this.waiting = true;
  }
}

/**
 * One encoder's bitrate, shared by all subscribers of a device: halved on congestion at most once per `recoverMs`,
 * and raised by a quarter after `recoverMs` without congestion.
 */
export class Bitrate {
  private value: number;
  private calmSince: number;
  private cutAt = -Infinity;
  private readonly limits: VideoLimits;

  constructor(limits: VideoLimits, now: number) {
    this.limits = limits;
    this.value = limits.startBitrate;
    this.calmSince = now;
  }

  get current(): number {
    return this.value;
  }

  /** Called while any subscriber is congested. Returns the new bitrate when it changed. */
  congested(now: number): number | null {
    this.calmSince = now;
    if (now - this.cutAt < this.limits.recoverMs) return null;
    this.cutAt = now;
    return this.set(Math.max(this.limits.minBitrate, Math.round(this.value / 2)));
  }

  /** Returns the new bitrate when it changed. */
  tick(now: number): number | null {
    if (now - this.calmSince < this.limits.recoverMs) return null;
    this.calmSince = now;
    return this.set(Math.min(this.limits.maxBitrate, Math.round(this.value * 1.25)));
  }

  private set(next: number): number | null {
    if (next === this.value) return null;
    this.value = next;
    return next;
  }
}
