import { Bitrate, DEFAULT_VIDEO_LIMITS, VideoGate } from '../src/video.ts';

describe('Bitrate', () => {
  const limits = { ...DEFAULT_VIDEO_LIMITS, startBitrate: 1_000_000, minBitrate: 300_000, maxBitrate: 1_500_000 };

  it('rises by a quarter only after a calm period, up to the maximum', () => {
    const bitrate = new Bitrate(limits, 0);
    bitrate.congested(0);
    expect(bitrate.tick(limits.recoverMs - 1)).toBeNull();
    expect(bitrate.tick(limits.recoverMs)).toBe(625_000);
    expect(bitrate.tick(limits.recoverMs + 1)).toBeNull();
    let now = limits.recoverMs;
    let value = 625_000;
    while (value < limits.maxBitrate) {
      now += limits.recoverMs;
      value = bitrate.tick(now) ?? value;
    }
    expect(value).toBe(1_500_000);
    expect(bitrate.tick(now + limits.recoverMs)).toBeNull();
  });
});

const key = { keyframe: true };
const delta = { keyframe: false };

it('reports congestion once, then drops until a keyframe arrives on a drained socket', () => {
  const gate = new VideoGate(100);
  gate.admit(key, 0);
  expect(gate.admit(delta, 101)).toBe('congested');
  expect(gate.admit(delta, 500)).toBe('drop');
  expect(gate.admit(key, 500)).toBe('drop');
  expect(gate.admit(delta, 0)).toBe('drop');
  expect(gate.admit(key, 0)).toBe('send');
});
