import { detectProviders, planMetroReach, tunnelStartRemedy } from '../engine/metro-reach.ts';

const BARE = { metroPort: 8085, isExpo: false } as const;

describe('an address the operator supplied', () => {
  test('is GATED, because Stim did not create it', () => {
    const plan = planMetroReach({ ...BARE, mode: 'auto', publicUrl: 'https://abc.example' });
    expect('gate' in plan && plan.gate).toBe(true);
  });
});

describe('a managed provider', () => {
  test('auto NEVER falls back to localhost', () => {
    for (const available of [[], ['ngrok'] as const, ['cloudflared'] as const]) {
      const plan = planMetroReach({ ...BARE, mode: 'auto', available });
      expect('origin' in plan).toBe(false);
    }
  });
});

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

describe('the tunnel start remedy', () => {
  test('ends the reason as a sentence before the advice, and gives none after a cancellation', () => {
    expect(tunnelStartRemedy('ngrok: Could not start ngrok: spawn ENOENT', false)).toBe(
      'ngrok: Could not start ngrok: spawn ENOENT. Set metro.tunnel to a provider that starts, or set metro.publicUrl to an existing endpoint.',
    );
    expect(tunnelStartRemedy('Metro tunnel startup was cancelled.', true)).toBe('Metro tunnel startup was cancelled.');
  });
});
