import { detectProviders } from '../engine/metro-reach.ts';

describe('provider detection', () => {
  test('explicit tailscale detects PATH or the macOS app binary without enabling auto selection', () => {
    for (const binary of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
      const onPath = (bin: string) => bin === binary;
      expect(detectProviders(onPath, 'tailscale')).toEqual(['tailscale']);
      expect(detectProviders(onPath)).toEqual([]);
    }
    expect(detectProviders(() => false, 'tailscale')).toEqual([]);
  });
});
