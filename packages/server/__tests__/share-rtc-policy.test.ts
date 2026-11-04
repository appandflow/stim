import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { videoPacket, type AccessUnit } from '../src/video.ts';

interface Policy {
  wanted: (offered: boolean, supported: boolean, query: string | null, cookie: string | null) => string;
  usableKeyframe: (buffer: ArrayBuffer) => boolean;
  createLossMonitor: (
    windowMs?: number,
    maxGaps?: number,
    maxAsks?: number,
  ) => { gap: (now: number) => string | null; ask: (now: number) => string | null; reset: () => void };
  retryDelay: (never: number, fellBack: number, forced: boolean) => number | null;
}

const policy: Policy = runInNewContext(
  `${readFileSync(new URL('../share-viewer/rtcpolicy.js', import.meta.url), 'utf8')}\nglobalThis.stimRtcPolicy`,
  {},
);

const START = [0, 0, 0, 1];
const SPS = Buffer.from([...START, 0x67, 0x4d, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x50]);
const PPS = Buffer.from([...START, 0x68, 0xee, 0x3c, 0x80]);
const IDR = Buffer.from([...START, 0x65, 0x88, 0x84, 0x00, 0x10]);
const DELTA = Buffer.from([...START, 0x41, 0x9a, 0x24, 0x6c]);

function packet(keyframe: boolean, ...parts: Buffer[]): ArrayBuffer {
  const unit: AccessUnit = { keyframe, capturedAt: 1, width: 590, height: 1280, data: Buffer.concat(parts) };
  const bytes = videoPacket('share', 0, unit);
  return new Uint8Array(bytes).buffer;
}

describe('the viewer WebRTC policy', () => {
  it.each([
    [true, true, null, null, 'try'],
    [true, true, null, 'webrtc', 'try'],
    [true, true, 'ws', null, 'off'],
    [true, true, null, 'ws', 'off'],
    [true, true, 'webrtc', 'ws', 'force'],
    [false, true, 'webrtc', null, 'off'],
    [true, false, null, null, 'off'],
  ] as const)('offered %s, supported %s, query %s, cookie %s: %s', (offered, supported, query, cookie, expected) => {
    expect(policy.wanted(offered, supported, query, cookie)).toBe(expected);
  });

  describe('which packet may start the data channel', () => {
    it('takes a keyframe with an SPS, a PPS and an IDR slice', () => {
      expect(policy.usableKeyframe(packet(true, SPS, PPS, IDR))).toBe(true);
    });

    it.each([
      ['a delta frame', packet(false, DELTA)],
      ['a keyframe without parameter sets', packet(true, IDR)],
      ['a keyframe without a PPS', packet(true, SPS, IDR)],
      ['a keyframe without a slice', packet(true, SPS, PPS)],
      ['a keyframe with a truncated SPS', packet(true, Buffer.from([...START, 0x67, 0x4d]), PPS, IDR)],
      ['a packet flagged as a keyframe that carries a delta slice', packet(true, SPS, PPS, DELTA)],
      ['a packet too short for its header', new ArrayBuffer(10)],
    ])('refuses %s', (_name, buffer) => {
      expect(policy.usableKeyframe(buffer)).toBe(false);
    });
  });

  describe('when the channel has lost too much video', () => {
    it('answers once the gaps inside the window reach the limit, and forgets older ones', () => {
      const monitor = policy.createLossMonitor(5000, 3, 99);
      expect(monitor.gap(0)).toBeNull();
      expect(monitor.gap(1000)).toBeNull();
      expect(monitor.gap(6000)).toBeNull();
      expect(monitor.gap(6100)).toBeNull();
      expect(monitor.gap(6200)).toBe('gaps');
    });

    it('counts keyframe asks separately and clears on reset', () => {
      const monitor = policy.createLossMonitor(5000, 99, 2);
      expect(monitor.ask(0)).toBeNull();
      expect(monitor.ask(100)).toBe('asks');
      monitor.reset();
      expect(monitor.ask(200)).toBeNull();
    });
  });

  describe('when to try again', () => {
    it('waits 5 s then 30 s after a path that never carried video, and then stops', () => {
      expect([1, 2, 3].map((never) => policy.retryDelay(never, 0, false))).toEqual([5000, 30000, null]);
    });

    it('never stops on a forced page', () => {
      expect(policy.retryDelay(9, 0, true)).toBe(120000);
    });

    it('doubles after each fallback of a channel that had carried video, up to ten minutes', () => {
      expect([1, 2, 3, 4, 5, 6, 7].map((fellBack) => policy.retryDelay(0, fellBack, false))).toEqual([
        30000, 60000, 120000, 240000, 480000, 600000, 600000,
      ]);
    });
  });
});
