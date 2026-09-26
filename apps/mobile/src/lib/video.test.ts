import { parseVideoPacket, VideoMeter } from '@/lib/video';

function packet(subscription: string, flags: number, accessUnit: number[]): ArrayBuffer {
  const header = 21 + subscription.length;
  const buffer = new ArrayBuffer(header + accessUnit.length);
  const view = new DataView(buffer);
  view.setUint8(0, 1);
  view.setUint8(1, flags);
  view.setUint16(2, header);
  view.setUint32(4, 42);
  view.setFloat64(8, 1759000000123.5);
  view.setUint16(16, 588);
  view.setUint16(18, 1280);
  view.setUint8(20, subscription.length);
  new Uint8Array(buffer, 21).set([...subscription].map((c) => c.charCodeAt(0)));
  new Uint8Array(buffer, header).set(accessUnit);
  return buffer;
}

describe('parseVideoPacket', () => {
  it('reads the header stim-server writes and exposes the access unit without copying', () => {
    const buffer = packet('s12', 1, [0, 0, 0, 1, 0x65]);
    const parsed = parseVideoPacket(buffer)!;
    expect(parsed).toMatchObject({
      subscription: 's12',
      keyframe: true,
      sequence: 42,
      capturedAt: 1759000000123.5,
      width: 588,
      height: 1280,
    });
    expect([...parsed.accessUnit]).toEqual([0, 0, 0, 1, 0x65]);
    expect(parsed.accessUnit.buffer).toBe(buffer);
    expect(parsed).not.toHaveProperty('posture');
  });

  it("reads an iPhone Duo's posture from the flags", () => {
    expect(parseVideoPacket(packet('s1', 1 | 2, [1]))).toMatchObject({ keyframe: true, posture: 'folded' });
    expect(parseVideoPacket(packet('s1', 4, [1]))).toMatchObject({ keyframe: false, posture: 'unfolded' });
  });

  it('rejects another version and a header longer than the message', () => {
    const other = packet('s1', 0, [1]);
    new DataView(other).setUint8(0, 2);
    expect(parseVideoPacket(other)).toBeNull();
    const truncated = packet('s1', 0, []);
    new DataView(truncated).setUint16(2, 200);
    expect(parseVideoPacket(truncated)).toBeNull();
  });
});

describe('VideoMeter', () => {
  it('reports frames, bits and the median latency of the last two seconds', () => {
    const meter = new VideoMeter();
    const unit = (bytes: number) => new Uint8Array(bytes);
    meter.add({ capturedAt: 0, accessUnit: unit(1000) }, 500);
    meter.add({ capturedAt: 1000, accessUnit: unit(1000) }, 3010);
    meter.add({ capturedAt: 3000, accessUnit: unit(2000) }, 3020);
    meter.add({ capturedAt: 3010, accessUnit: unit(1000) }, 3040);
    expect(meter.stats()).toEqual({ fps: 1.5, kbps: 16, latencyMs: 30 });
  });
});
