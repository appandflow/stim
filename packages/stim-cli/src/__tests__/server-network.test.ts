import { describe, expect, it } from 'vitest';
import { parseServeProxies, serverNetworkFindings } from '../diagnostics/server-network.ts';
import { health, network, reading, service, setup } from './_server-setup.ts';

const web = (hostPort: string, proxy: string) => ({ [hostPort]: { Handlers: { '/': { Proxy: proxy } } } });

/** The `tailscale serve status --json` shape of this MacBook: a stim route, a Funnel port for another program. */
const SERVE = {
  TCP: { '443': { HTTPS: true }, '7443': { HTTPS: true }, '8443': { HTTPS: true } },
  Web: {
    'mac.tail1234.ts.net:443': { Handlers: { '/gmail-pubsub': { Proxy: 'http://127.0.0.1:8788' } } },
    ...web('mac.tail1234.ts.net:7443', 'http://127.0.0.1:7788'),
    ...web('mac.tail1234.ts.net:8443', 'http://localhost:4321'),
    ...web('mac.tail1234.ts.net:9443', 'http://192.168.1.20:5000'),
  },
  AllowFunnel: { 'mac.tail1234.ts.net:443': true },
  Foreground: [],
};

const serveSetup = (serve: unknown, over: Parameters<typeof setup>[0] = {}) =>
  setup({ network: network({ serve }), ...over });

const withRecorded = (port: number | null) =>
  service({ installed: { ...service().installed, serve: port === null ? null : { port, created: true } } });

describe('parseServeProxies', () => {
  it('lists loopback proxies per HTTPS port with their Funnel flag, and drops other targets', () => {
    expect(parseServeProxies(SERVE)).toEqual([
      { port: 443, target: 8788, funnel: true },
      { port: 7443, target: 7788, funnel: false },
      { port: 8443, target: 4321, funnel: false },
    ]);
  });

  it('reads foreground sessions and tolerates an empty config', () => {
    expect(
      parseServeProxies({
        Foreground: { abc: { Web: web('h:8443', 'http://127.0.0.1:7788'), AllowFunnel: { 'h:8443': true } } },
      }),
    ).toEqual([{ port: 8443, target: 7788, funnel: true }]);
    expect(parseServeProxies({})).toEqual([]);
    expect(parseServeProxies(null)).toEqual([]);
  });
});

describe('Tailscale and the serve route', () => {
  it('is quiet when the route reaches the server', () => {
    expect(serverNetworkFindings(serveSetup(SERVE, { services: [withRecorded(7443)] }))).toEqual([]);
  });

  it('says Tailscale is off when a service or approved clients depend on the tailnet', () => {
    const stopped = network({ tailscaleStatus: { BackendState: 'Stopped' } });
    const [finding] = serverNetworkFindings(setup({ network: stopped, services: [withRecorded(7443)] }));
    expect(finding).toMatchObject({ code: 'server-tailscale', level: 'cost' });
    expect(finding?.fix).toContain('Turn on Tailscale on Janics-Mac-mini');
    expect(serverNetworkFindings(setup({ network: stopped, services: [] }))).toEqual([]);
    expect(
      serverNetworkFindings(
        setup({ network: network({ tailscaleStatus: null }), clients: { build: 1, deviceHost: 0 } }),
      )[0]?.title,
    ).toContain('Tailscale is not running');
  });

  it('gives the serve command for a route that install recorded and is gone', () => {
    const [finding] = serverNetworkFindings(serveSetup({ TCP: {}, Web: {} }, { services: [withRecorded(7443)] }));
    expect(finding).toMatchObject({ code: 'server-tailscale-route', level: 'cost' });
    expect(finding?.fix).toBe('Run `tailscale serve --bg --https=7443 http://127.0.0.1:7788`.');
  });

  it('suggests the first free HTTPS port, as a note, for approved clients and no recorded route', () => {
    const [finding] = serverNetworkFindings(
      serveSetup(
        { Web: web('h:7443', 'http://127.0.0.1:9000'), TCP: { '7443': { HTTPS: true } } },
        { services: [withRecorded(null)], clients: { build: 1, deviceHost: 0 } },
      ),
    );
    expect(finding).toMatchObject({ code: 'server-tailscale-route', level: 'note' });
    expect(finding?.fix).toBe('Run `tailscale serve --bg --https=7444 http://127.0.0.1:7788`.');
  });

  it('reports the recorded route pointing at another port', () => {
    const [finding] = serverNetworkFindings(
      serveSetup(
        { Web: web('h:7443', 'http://127.0.0.1:7777') },
        { services: [withRecorded(7443)], servers: [reading({ port: 7788 })] },
      ),
    );
    expect(finding?.title).toContain('points at port 7777');
    expect(finding?.fix).toBe(
      'Run `tailscale serve --bg --https=7443 http://127.0.0.1:7788` to point the route at the server.',
    );
  });

  it('asks nothing of a loopback-only server or one with an unreadable serve config', () => {
    expect(
      serverNetworkFindings(
        serveSetup(
          {},
          {
            services: [withRecorded(7443)],
            servers: [reading({ health: health({ loopbackOnly: true }) })],
          },
        ),
      ),
    ).toEqual([]);
    expect(serverNetworkFindings(serveSetup(null, { services: [withRecorded(7443)] }))).toEqual([]);
  });
});

describe('Funnel', () => {
  const funnel = (target: number) => ({
    Web: web('mac.tail1234.ts.net:443', `http://127.0.0.1:${target}`),
    AllowFunnel: { 'mac.tail1234.ts.net:443': true },
  });

  it('warns loudly when a public route reaches stim-server', () => {
    const finding = serverNetworkFindings(serveSetup(funnel(7788))).find((each) => each.code === 'server-funnel');
    expect(finding).toMatchObject({ level: 'cost' });
    expect(finding?.title).toMatch(/^PUBLIC/);
    expect(finding?.fix).toContain('tailscale funnel --https=443 off');
  });

  it('warns when a public route is open while a share has no password, and not otherwise', () => {
    const open = serverNetworkFindings(
      serveSetup(funnel(54011), {
        network: network({ serve: funnel(54011), shares: [{ id: 'ab12', workspace: '/w', auth: 'none' }] }),
      }),
    );
    expect(open[0]?.title).toContain('a share has no password');
    expect(open[0]?.detail).toContain('ab12 (/w)');
    const protectedShare = network({
      serve: funnel(54011),
      shares: [{ id: 'ab12', workspace: '/w', auth: 'generated' }],
    });
    expect(serverNetworkFindings(setup({ network: protectedShare }))).toEqual([]);
  });
});

describe('share exposure', () => {
  it('notes proxy mode without share.publicUrl, chosen or fallen back to while sharing', () => {
    const chosen = serverNetworkFindings(
      setup({ network: network({ share: { exposure: 'proxy', publicUrl: null } }) }),
    );
    expect(chosen[0]).toMatchObject({ code: 'server-share-proxy', level: 'note' });
    expect(chosen[0]?.fix).toContain('stim settings set share.publicUrl');
    const fallback = serverNetworkFindings(
      setup({
        network: network({ tailscaleStatus: { BackendState: 'Stopped' } }),
        servers: [reading({ kind: 'share', label: undefined })],
      }),
    );
    expect(fallback.find((each) => each.code === 'server-share-proxy')?.detail).toContain('auto chose proxy mode');
  });

  it.each([
    ['a public URL set', { exposure: 'proxy' as const, publicUrl: 'https://demo.example.com' }],
    ['tailscale exposure', { exposure: 'tailscale' as const, publicUrl: null }],
    ['auto with Tailscale signed in', { exposure: 'auto' as const, publicUrl: null }],
  ])('is quiet with %s', (_name, share) => {
    expect(
      serverNetworkFindings(setup({ network: network({ share }) })).filter(
        (each) => each.code === 'server-share-proxy',
      ),
    ).toEqual([]);
  });
});

describe('tcp_notsent_lowat', () => {
  const sharing = (lowat: number | null, platform: 'linux' | 'darwin' = 'linux') =>
    setup({
      platform,
      servers: [reading({ kind: 'share', label: undefined })],
      network: network({ notsentLowat: lowat }),
    });

  it('recommends 16384 on a Linux share host that leaves it unlimited, as advice', () => {
    const [finding] = serverNetworkFindings(sharing(4294967295));
    expect(finding).toMatchObject({ code: 'server-tcp-lowat', level: 'note' });
    expect(finding?.fix).toContain('sudo sysctl -w net.ipv4.tcp_notsent_lowat=16384');
  });

  it.each([
    ['already limited', sharing(16384)],
    ['unreadable', sharing(null)],
    ['not a share host', setup({ platform: 'linux', network: network({ notsentLowat: 4294967295 }) })],
  ])('is quiet when %s', (_name, value) => {
    expect(serverNetworkFindings(value)).toEqual([]);
  });
});
