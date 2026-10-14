import type { VideoProgress } from 'react-native-stim-session';

export interface VideoStats {
  fps: number;
  kbps: number;
  /** Median of arrival time minus capture time over the window, in milliseconds. */
  latencyMs: number | null;
}

const WINDOW_MS = 2000;

/** Frame rate, bitrate and latency over the last two seconds of a stream's progress reports. */
export class VideoMeter {
  private samples: { at: number; frames: number; bytes: number; latency: number }[] = [];

  add(progress: Pick<VideoProgress, 'frames' | 'bytes' | 'latencyMs'>, at: number): void {
    this.samples.push({ at, frames: progress.frames, bytes: progress.bytes, latency: progress.latencyMs });
    const cutoff = at - WINDOW_MS;
    while (this.samples.length && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  stats(): VideoStats {
    const frames = this.samples.reduce((sum, sample) => sum + sample.frames, 0);
    if (!frames) return { fps: 0, kbps: 0, latencyMs: null };
    const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const latencies = this.samples
      .flatMap((sample) => Array<number>(sample.frames).fill(sample.latency))
      .sort((a, b) => a - b);
    return {
      fps: frames / (WINDOW_MS / 1000),
      kbps: (bytes * 8) / WINDOW_MS,
      latencyMs: latencies[Math.floor(frames / 2)]!,
    };
  }
}
