import { Bitrate, DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate } from '../src/video.ts';

describe('videoPacket', () => {
  it('writes the header the mobile app parses, then the access unit', () => {
    const data = Buffer.from([0, 0, 0, 1, 0x65, 0xaa]);
    const packet = videoPacket('s12', 7, {
      keyframe: true,
      capturedAt: 1759000000123.5,
      width: 588,
      height: 1280,
      data,
    });
    expect(packet.readUInt8(0)).toBe(1);
    expect(packet.readUInt8(1)).toBe(1);
    expect(packet.readUInt16BE(2)).toBe(24);
    expect(packet.readUInt32BE(4)).toBe(7);
    expect(packet.readDoubleBE(8)).toBe(1759000000123.5);
    expect([packet.readUInt16BE(16), packet.readUInt16BE(18)]).toEqual([588, 1280]);
    expect(packet.toString('ascii', 21, 21 + packet.readUInt8(20))).toBe('s12');
    expect(packet.subarray(24)).toEqual(data);
  });
});

describe('VideoGate', () => {
  const key = { keyframe: true };
  const delta = { keyframe: false };

  it('waits for a keyframe before sending anything', () => {
    const gate = new VideoGate(100);
    expect(gate.admit(delta, 0)).toBe('drop');
    expect(gate.admit(key, 0)).toBe('send');
    expect(gate.admit(delta, 0)).toBe('send');
  });

  it('reports congestion once, then drops until a keyframe arrives on a drained socket', () => {
    const gate = new VideoGate(100);
    gate.admit(key, 0);
    expect(gate.admit(delta, 101)).toBe('congested');
    expect(gate.admit(delta, 500)).toBe('drop');
    expect(gate.admit(key, 500)).toBe('drop');
    expect(gate.admit(delta, 0)).toBe('drop');
    expect(gate.admit(key, 0)).toBe('send');
  });

  it('drops until the next keyframe after a reset', () => {
    const gate = new VideoGate(100);
    gate.admit(key, 0);
    gate.reset();
    expect(gate.admit(delta, 0)).toBe('drop');
    expect(gate.admit(key, 0)).toBe('send');
  });
});

describe('Bitrate', () => {
  const limits = { ...DEFAULT_VIDEO_LIMITS, startBitrate: 1_000_000, minBitrate: 300_000, maxBitrate: 1_500_000 };

  it('halves once per recovery period while congestion lasts, down to the minimum', () => {
    const bitrate = new Bitrate(limits, 0);
    expect(bitrate.congested(10)).toBe(500_000);
    expect(bitrate.congested(20)).toBeNull();
    expect(bitrate.tick(10 + limits.recoverMs - 1)).toBeNull();
    expect(bitrate.congested(10 + limits.recoverMs)).toBe(300_000);
    expect(bitrate.congested(10 + 2 * limits.recoverMs)).toBeNull();
  });

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
