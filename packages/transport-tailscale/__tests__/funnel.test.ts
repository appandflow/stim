import { describe, expect, it } from 'vitest';
import { freeFunnelPort, funnelPorts, holdsFunnelRoute } from '../src/funnel.ts';

const HOST = 'mac.tail.ts.net';
const route = { port: 10000, target: 51234 };

function served(port: number, proxy: string, funnel = true, extra: Record<string, unknown> = {}) {
  return {
    TCP: { [port]: { HTTPS: true } },
    Web: { [`${HOST}:${port}`]: { Handlers: { '/': { Proxy: proxy }, ...extra } } },
    ...(funnel ? { AllowFunnel: { [`${HOST}:${port}`]: true } } : {}),
  };
}

describe('the share Funnel route', () => {
  it.each([
    ['exactly the route a share adds', served(10000, 'http://127.0.0.1:51234'), true],
    ['another target on the port', served(10000, 'http://127.0.0.1:7787'), false],
    ['the same target without Funnel', served(10000, 'http://127.0.0.1:51234', false), false],
    [
      'a second handler someone added on the port',
      served(10000, 'http://127.0.0.1:51234', true, { '/api': { Proxy: 'http://127.0.0.1:9' } }),
      false,
    ],
    [
      'a foreground session also using the port',
      { ...served(10000, 'http://127.0.0.1:51234'), Foreground: { s: { TCP: { 10000: { HTTPS: true } } } } },
      false,
    ],
    ['nothing served', {}, false],
  ])('is held only when the config holds %s', (_name, config, held) => {
    expect(holdsFunnelRoute(config, route)).toBe(held);
  });

  it('takes the first allowed Funnel port nothing uses, foreground sessions and Funnel-only entries included', () => {
    const config = {
      ...served(443, 'http://127.0.0.1:8788'),
      AllowFunnel: { [`${HOST}:443`]: true, [`${HOST}:8443`]: true },
      Foreground: { s: { TCP: { 10000: { HTTPS: true } } } },
    };
    expect(freeFunnelPort(config, [443, 8443, 10000])).toBeNull();
    expect(freeFunnelPort(served(443, 'http://127.0.0.1:8788'), [443, 8443, 10000])).toBe(8443);
  });

  it('reads the Funnel capability and its ports from the node status', () => {
    const status = (caps: string[]) => ({ Self: { CapMap: Object.fromEntries(caps.map((cap) => [cap, null])) } });
    expect(funnelPorts(status(['https']))).toBeNull();
    expect(funnelPorts(status(['funnel', 'https://tailscale.com/cap/funnel-ports?ports=8443,10000']))).toEqual([
      8443, 10000,
    ]);
  });
});
