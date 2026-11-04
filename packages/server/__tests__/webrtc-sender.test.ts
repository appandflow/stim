import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node-datachannel');
  vi.resetModules();
});

describe('the WebRTC sender without node-datachannel', () => {
  it('rejects an offer with a message that names the missing package, and cleans up without loading it', async () => {
    vi.resetModules();
    vi.doMock('node-datachannel', () => {
      throw new Error('Cannot find module node-datachannel');
    });
    const { cleanupRtc, openRtc } = await import('../src/webrtc-sender.ts');
    await expect(
      openRtc('offer-sdp', { subscribe: () => () => {}, keyframe: () => {}, congested: () => {} }, () => {}),
    ).rejects.toThrow(/WebRTC is unavailable here: node-datachannel could not be loaded/);
    await expect(cleanupRtc()).resolves.toBeUndefined();
  });
});
