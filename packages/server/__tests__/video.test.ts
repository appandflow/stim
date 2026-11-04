import { accessUnitOf, Bitrate, DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate } from '../src/video.ts';

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

  it('stops rising at a ceiling, drops to it at once, and rises again when it is lifted', () => {
    const bitrate = new Bitrate(limits, 0);
    bitrate.limit(1_100_000);
    expect(bitrate.current).toBe(1_000_000);
    expect(bitrate.tick(limits.recoverMs)).toBe(1_100_000);
    expect(bitrate.tick(2 * limits.recoverMs)).toBeNull();
    bitrate.limit(600_000);
    expect(bitrate.current).toBe(600_000);
    bitrate.limit(Infinity);
    expect(bitrate.tick(3 * limits.recoverMs)).toBe(750_000);
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

it('reads back the access unit a video packet carries, whatever subscription it names', () => {
  const unit = {
    keyframe: true,
    capturedAt: 1_762_000_000_123.5,
    width: 590,
    height: 1280,
    posture: 'folded' as const,
    artworkTurns: 3,
    data: Buffer.from([0, 0, 0, 1, 0x67, 0x4d]),
  };
  expect(accessUnitOf(videoPacket('host-subscription-7', 42, unit))).toEqual(unit);
  const later = { keyframe: false, capturedAt: unit.capturedAt, width: 590, height: 1280, data: unit.data };
  expect(accessUnitOf(videoPacket('s', 0, later))).toEqual(later);
  expect(accessUnitOf(Buffer.from([2, 0, 0, 21]))).toBeNull();
});
