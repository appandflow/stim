import type { TunnelMode } from '@stim-cli/core/state';

export { TUNNEL_MODES, type TunnelMode } from '@stim-cli/core/state';

export const PUBLIC_METRO_ENV = 'STIM_METRO_PUBLIC_URL';

// Prefer ngrok because Cloudflare quick tunnels can take minutes to become routable.
const MANAGED_PROVIDERS = ['ngrok', 'cloudflared'] as const;
export type ManagedProvider = (typeof MANAGED_PROVIDERS)[number] | 'tailscale';

export type ReachPlan =
  | { origin: string; gate: boolean }
  | { expoTunnel: true }
  | { start: ManagedProvider }
  | { failed: string; remedy: string };

export interface ReachInputs {
  mode: TunnelMode;
  metroPort: number | string;
  publicUrl?: string | null;
  isExpo: boolean;
  available?: readonly ManagedProvider[];
}

const NAMED: Record<string, string> = {
  cloudflared: '`cloudflared` (brew install cloudflared)',
  ngrok: '`ngrok` (brew install ngrok, then `ngrok config add-authtoken <token>`)',
  tailscale: 'Tailscale and sign in to your tailnet',
};

export function planMetroReach({ mode, metroPort, publicUrl = null, isExpo, available = [] }: ReachInputs): ReachPlan {
  const named = publicUrl?.trim().replace(/\/+$/, '') || null;

  if (mode === 'off') {
    return { origin: `http://localhost:${metroPort}`, gate: false };
  }

  if (named) return { origin: named, gate: true };

  if (mode === 'expo') {
    if (!isExpo) {
      return {
        failed: 'metro.tunnel is "expo", but this workspace does not run an Expo dev server.',
        remedy: 'Use "auto" to let stim start a tunnel, or "off" if the device shares this machine.',
      };
    }
    return { expoTunnel: true };
  }

  if (mode === 'cloudflared' || mode === 'ngrok' || mode === 'tailscale') {
    if (!available.includes(mode)) {
      return {
        failed: `metro.tunnel is "${mode}", but ${mode} is not on PATH.`,
        remedy: `Install ${NAMED[mode] ?? mode}, or set metro.tunnel to "auto".`,
      };
    }
    return { start: mode };
  }

  const provider = available.find((candidate) => candidate !== 'tailscale');
  if (provider) return { start: provider };
  return {
    failed: `A remote device cannot reach this workspace's Metro on port ${metroPort}, and no tunnel is available to give it one.`,
    remedy:
      `Install ${NAMED.ngrok} or ${NAMED.cloudflared} and Stim will manage the tunnel for you. ` +
      'If you already have one, set metro.publicUrl to its URL. ' +
      'If the device shares this machine (a local `agent-device proxy`), set metro.tunnel to "off".',
  };
}

export function resolveTailscaleBinary(findExecutable: (bin: string) => string | null): string | null {
  return findExecutable('tailscale') ?? findExecutable('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
}

export function detectProviders(onPath: (bin: string) => boolean, mode: TunnelMode = 'auto'): ManagedProvider[] {
  if (mode === 'tailscale') {
    return resolveTailscaleBinary((bin) => (onPath(bin) ? bin : null)) ? ['tailscale'] : [];
  }
  return MANAGED_PROVIDERS.filter((p) => onPath(p));
}
