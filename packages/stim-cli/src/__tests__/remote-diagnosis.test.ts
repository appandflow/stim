import { createServer, type Server } from 'node:http';
import { findPeer } from '@stim-cli/core/state';
import {
  ago,
  classifyTransport,
  diagnoseUnreachable,
  parsePeerStartup,
  readTailscale,
  type Transport,
} from '../offload/diagnosis.ts';
import { openAuthenticated } from '../offload/tailnet.ts';

function listenPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server is not listening');
  return address.port;
}

const peer = {
  nodeId: 'nMini',
  dnsName: 'mini.tail1.ts.net',
  address: '100.64.0.7',
};
const diagnose = (transport: Transport | undefined, extra: Partial<Parameters<typeof diagnoseUnreachable>[0]> = {}) =>
  diagnoseUnreachable({
    entry: 'mini',
    peer,
    port: 7443,
    reason: 'it did not answer',
    transport,
    ...extra,
  });

describe('diagnoseUnreachable', () => {
  it('maps each transport outcome to the layer that failed', () => {
    expect(diagnose({ kind: 'refused' })).toMatchObject({
      layer: 'route',
      code: 'route-missing',
    });
    expect(diagnose({ kind: 'silent' })).toMatchObject({
      layer: 'peer',
      code: 'peer-no-answer',
    });
    expect(diagnose({ kind: 'http', status: 502 })).toMatchObject({
      layer: 'server',
      code: 'server-not-running',
    });
    expect(diagnose({ kind: 'http', status: 503 })).toMatchObject({
      layer: 'server',
      code: 'server-not-ready',
    });
    expect(diagnose({ kind: 'http', status: 404 })).toMatchObject({
      layer: 'route',
      code: 'route-http-error',
    });
    expect(diagnose({ kind: 'tls', message: 'certificate has expired' })).toMatchObject({ code: 'route-tls' });
    expect(diagnose({ kind: 'other', message: 'socket hang up' })).toMatchObject({
      code: 'connect-failed',
      message: expect.stringContaining('it did not answer'),
    });
  });

  it('reads a 503 cause from the peer health and says what to check', () => {
    expect(
      diagnose({ kind: 'http', status: 503 }, { startup: { state: 'degraded', cause: 'home-unreadable' } }),
    ).toMatchObject({
      message: expect.stringContaining('cannot read its Stim home'),
      remedy: expect.stringContaining('disk that holds the Stim home'),
    });
    expect(diagnose({ kind: 'http', status: 503 }, { startup: { state: 'pending' } }).message).toContain(
      'still starting',
    );
  });

  it('names an offline peer, with its last seen time, when nothing on it answered', () => {
    const now = Date.parse('2026-10-22T20:00:00Z');
    const offline = { ...peer, online: false, lastSeen: '2026-10-22T08:00:00Z' };
    expect(diagnose({ kind: 'silent' }, { peer: offline, now })).toMatchObject({
      layer: 'peer',
      code: 'peer-offline',
      message: 'mini is offline on Tailscale (last seen 12 h ago).',
    });
    expect(diagnose(undefined, { peer: offline, now })).toMatchObject({ code: 'peer-offline' });
  });

  it('trusts an answer over Tailscale reporting the peer offline, which lags a reachable Mac', () => {
    const offline = { ...peer, online: false };
    expect(diagnose({ kind: 'http', status: 503 }, { peer: offline })).toMatchObject({ code: 'server-not-ready' });
    expect(diagnose({ kind: 'refused' }, { peer: offline })).toMatchObject({ code: 'route-missing' });
  });

  it('says a silent peer is only reachable through a relay', () => {
    expect(
      diagnose({ kind: 'silent' }, { peer: { ...peer, online: true, direct: false, relay: 'nyc' } }).message,
    ).toContain('through the nyc relay');
  });
});

describe('Tailscale and peer readings', () => {
  it('tells a signed out, stopped and missing Tailscale apart', () => {
    expect(readTailscale({ BackendState: 'Running' })).toEqual({
      running: true,
    });
    expect(readTailscale({ BackendState: 'NeedsLogin' })).toEqual({
      running: false,
      code: 'tailscale-logged-out',
    });
    expect(readTailscale({ BackendState: 'Stopped' })).toEqual({
      running: false,
      code: 'tailscale-stopped',
    });
    expect(readTailscale(null)).toEqual({
      running: false,
      code: 'tailscale-unavailable',
    });
  });

  it('keeps a peer online state, last seen time and path from tailscale status', () => {
    const status = {
      Peer: {
        a: {
          ID: 'nMini',
          DNSName: 'mini.tail1.ts.net.',
          TailscaleIPs: ['100.64.0.7'],
          Online: false,
          LastSeen: '2026-10-22T08:00:00Z',
          CurAddr: '',
          Relay: 'nyc',
        },
        b: {
          ID: 'nZero',
          DNSName: 'zero.tail1.ts.net.',
          TailscaleIPs: ['100.64.0.8'],
          LastSeen: '0001-01-01T00:00:00Z',
        },
      },
    };
    expect(findPeer(status, 'mini')).toMatchObject({
      online: false,
      lastSeen: '2026-10-22T08:00:00Z',
      relay: 'nyc',
      direct: false,
    });
    expect(findPeer(status, 'zero')).not.toHaveProperty('lastSeen');
  });

  it('formats elapsed time and ignores an unusable timestamp', () => {
    const now = Date.parse('2026-10-22T20:00:00Z');
    expect(ago('2026-10-22T19:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-10-19T20:00:00Z', now)).toBe('3 days ago');
    expect(ago('0001-01-01T00:00:00Z', now)).toBeNull();
    expect(ago(undefined, now)).toBeNull();
  });

  it('accepts only the startup stim-server sends', () => {
    expect(
      parsePeerStartup({
        version: '1',
        startup: { state: 'degraded', cause: 'home-unreadable' },
      }),
    ).toEqual({
      state: 'degraded',
      cause: 'home-unreadable',
    });
    expect(
      parsePeerStartup({
        startup: { state: 'degraded', cause: 'something else' },
      }),
    ).toEqual({ state: 'degraded' });
    expect(parsePeerStartup({ version: '1' })).toBeNull();
    expect(parsePeerStartup('nope')).toBeNull();
  });
});

describe('what a real connection reports below the handshake', () => {
  const connect = (port: number) =>
    openAuthenticated(
      {
        url: `ws://127.0.0.1:${port}`,
        servername: 'mini',
        host: `127.0.0.1:${port}`,
      },
      { access: 'build', serverKey: 'S'.repeat(43) },
      3000,
    );

  it.each([502, 503, 404])('reports the HTTP status %i a serve route answers the upgrade with', async (status) => {
    const server = createServer();
    server.on('upgrade', (_request, socket) =>
      socket.end(`HTTP/1.1 ${status} X\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const result = await connect(listenPort(server));
      expect(result).toMatchObject({ transport: { kind: 'http', status } });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('reports a port nothing listens on as refused', async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = listenPort(server);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await connect(port)).toMatchObject({
      transport: { kind: 'refused' },
    });
  });

  it('classifies socket errors', () => {
    expect(classifyTransport(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))).toEqual({ kind: 'silent' });
    expect(classifyTransport(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({ kind: 'refused' });
    expect(classifyTransport(Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' }))).toMatchObject({
      kind: 'tls',
    });
  });
});
