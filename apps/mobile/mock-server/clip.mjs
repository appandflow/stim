import { readFileSync } from 'node:fs';

import { packet } from './replay.mjs';

/** Splits an Annex-B stream into access units at its access unit delimiters (NAL type 9). */
export function loadClip(path, { width, height, fps }) {
  const bytes = readFileSync(path);
  const starts = [];
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 9) {
      starts.push(i > 0 && bytes[i - 1] === 0 ? i - 1 : i);
    }
  }
  const units = starts.map((start, index) => {
    const data = bytes.subarray(start, starts[index + 1] ?? bytes.length);
    let keyframe = false;
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 5) keyframe = true;
    }
    return { flags: keyframe ? 1 : 0, keyframe, width, height, data };
  });
  return { units, intervalMs: 1000 / fps };
}

/** Loops the clip at its frame rate with capture times of now, to a sink; `restart` begins again at a keyframe. */
export class ClipFeed {
  constructor(clip, subscription, sink) {
    this.clip = clip;
    this.subscription = subscription;
    this.sink = sink;
    this.sequence = 0;
    this.timer = null;
    this.archived = false;
    this.index = 0;
    this.start = 0;
    this.begin = 0;
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  live() {
    this.stop();
    this.index = 0;
    this.begin = performance.now();
    this.step();
  }

  step() {
    const { units, intervalMs } = this.clip;
    this.sink(units[this.index % units.length], Date.now(), this.sequence++);
    this.index++;
    this.timer = setTimeout(
      () => this.step(),
      Math.max(0, this.begin + (this.index - this.start) * intervalMs - performance.now()),
    );
  }

  /** Jumps to the next keyframe, as an encoder asked for one would. */
  restart() {
    if (!this.timer) return;
    const { units } = this.clip;
    let next = this.index;
    while (!units[next % units.length].keyframe) next++;
    this.stop();
    this.index = next;
    this.begin = performance.now();
    this.start = this.index;
    this.step();
  }

  seek() {
    return Date.now();
  }
}

export const wsSink = (subscription, socket) => (unit, capturedAt, sequence) => {
  if (socket.readyState === socket.OPEN) socket.send(packet(subscription, sequence, unit, capturedAt));
};
