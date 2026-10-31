import { Bitrate, DEFAULT_VIDEO_LIMITS } from '../src/video.ts';

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
