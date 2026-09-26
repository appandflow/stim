export interface VideoPacket {
  subscription: string;
  keyframe: boolean;
  sequence: number;
  /** Milliseconds since the epoch on the Mac's clock. */
  capturedAt: number;
  width: number;
  height: number;
  /** An iPhone Duo's posture, from the panel the server streams. */
  posture?: 'folded' | 'unfolded';
  /** One Annex-B H.264 access unit, a view into the message's buffer. */
  accessUnit: Uint8Array;
}

const VERSION = 1;
const KEYFRAME = 1;
const FOLDED = 2;
const UNFOLDED = 4;
const FIXED_HEADER_BYTES = 21;

/** Reads the binary message stim-server sends for a video subscription, or null for anything else. */
export function parseVideoPacket(buffer: ArrayBuffer): VideoPacket | null {
  if (buffer.byteLength < FIXED_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== VERSION) return null;
  const headerLength = view.getUint16(2);
  const idLength = view.getUint8(20);
  if (headerLength < FIXED_HEADER_BYTES + idLength || headerLength > buffer.byteLength) return null;
  const id = new Uint8Array(buffer, FIXED_HEADER_BYTES, idLength);
  const flags = view.getUint8(1);
  const posture = flags & FOLDED ? 'folded' : flags & UNFOLDED ? 'unfolded' : undefined;
  return {
    subscription: String.fromCharCode(...id),
    keyframe: (flags & KEYFRAME) !== 0,
    ...(posture ? { posture } : {}),
    sequence: view.getUint32(4),
    capturedAt: view.getFloat64(8),
    width: view.getUint16(16),
    height: view.getUint16(18),
    accessUnit: new Uint8Array(buffer, headerLength),
  };
}

export interface VideoStats {
  fps: number;
  kbps: number;
  /** Median of arrival time minus capture time over the window, in milliseconds. */
  latencyMs: number | null;
}

const WINDOW_MS = 2000;

/** Frame rate, bitrate and latency over the last two seconds of packets. */
export class VideoMeter {
  private samples: { at: number; bytes: number; latency: number }[] = [];

  add(packet: Pick<VideoPacket, 'capturedAt' | 'accessUnit'>, at: number): void {
    this.samples.push({ at, bytes: packet.accessUnit.byteLength, latency: at - packet.capturedAt });
    const cutoff = at - WINDOW_MS;
    while (this.samples.length && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  stats(): VideoStats {
    const count = this.samples.length;
    if (!count) return { fps: 0, kbps: 0, latencyMs: null };
    const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const latencies = this.samples.map((sample) => sample.latency).sort((a, b) => a - b);
    return {
      fps: count / (WINDOW_MS / 1000),
      kbps: (bytes * 8) / WINDOW_MS,
      latencyMs: latencies[Math.floor(count / 2)]!,
    };
  }
}
