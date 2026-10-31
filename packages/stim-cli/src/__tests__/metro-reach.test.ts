import { detectProviders, planMetroReach } from '../engine/metro-reach.ts';

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
