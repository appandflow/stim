import { VideoMeter } from '@/lib/video';

describe('VideoMeter', () => {
  it('reports frames, bits and the median latency of the last two seconds of progress reports', () => {
    const meter = new VideoMeter();
    meter.add({ frames: 1, bytes: 1000, latencyMs: 500 }, 500);
    meter.add({ frames: 1, bytes: 1000, latencyMs: 2010 }, 3010);
    meter.add({ frames: 2, bytes: 3000, latencyMs: 30 }, 3200);
    expect(meter.stats()).toEqual({ fps: 1.5, kbps: 16, latencyMs: 30 });
  });
});
