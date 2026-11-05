import type { ServeRoute } from '@stim-cli/core/protocol';

export interface ServeRecord {
  port: number;
  /** Whether `service install` created the `tailscale serve` route, so `uninstall` removes it. */
  created: boolean;
}

/**
 * What `install --serve` does about the node's `tailscale serve` config: refuse a Funnel route or an unreadable
 * config, keep a route that already reaches the port (remembering whether an earlier install created it), or
 * create one.
 */
export function planServe(
  route: ServeRoute,
  target: number,
  previous: ServeRecord | null,
): { record: ServeRecord; create: boolean } | { refusal: string } {
  if (route.state === 'funneled') {
    return {
      refusal: `refusing to serve. Tailscale Funnel is on for port ${route.ports.join(', ')}, which proxies to port ${target}, so it is reachable from the public internet. Remove that handler (see \`tailscale serve status\`), then run install again.`,
    };
  }
  if (route.state === 'unknown') {
    return { refusal: `could not read \`tailscale serve status --json\` (${route.reason}); not changing the route.` };
  }
  if (route.state === 'routed') {
    return { record: { port: route.port, created: previous?.port === route.port && previous.created }, create: false };
  }
  return { record: { port: route.port, created: true }, create: true };
}
