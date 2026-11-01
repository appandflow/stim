import {
  classifyTransport,
  diagnoseUnreachable,
  parsePeerStartup,
  readTailscale,
  type Transport,
} from '../offload/diagnosis.ts';

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
    expect(diagnose({ kind: 'other', message: 'socket hang up' })).toMatchObject({ code: 'connect-failed' });
  });

  it('reads a 503 cause from the peer health and says what to check', () => {
    const unready = (startup?: { state: 'pending' | 'degraded'; cause?: 'home-unreadable' | 'start-failed' }) =>
      diagnose({ kind: 'http', status: 503 }, { startup });
    const outcomes = [
      unready({ state: 'degraded', cause: 'home-unreadable' }),
      unready({ state: 'degraded', cause: 'start-failed' }),
      unready({ state: 'pending' }),
      unready(),
    ];
    expect(outcomes.map((each) => each.code)).toEqual(Array(4).fill('server-not-ready'));
    expect(new Set(outcomes.map((each) => each.message)).size).toBe(4);
    expect(new Set(outcomes.map((each) => each.remedy)).size).toBeGreaterThanOrEqual(3);
  });

  it('tells a silent route behind a pingable Mac from a Mac that does not answer at all', () => {
    const silent = { kind: 'silent' } as const;
    expect(diagnose(silent, { pinged: true })).toMatchObject({ layer: 'server', code: 'server-no-answer' });
    expect(diagnose(silent, { pinged: true, peer: { ...peer, online: false } })).toMatchObject({
      code: 'server-no-answer',
    });
    expect(diagnose(silent, { pinged: false })).toMatchObject({ layer: 'peer', code: 'peer-no-answer' });
    expect(diagnose(silent, { pinged: false, peer: { ...peer, online: false } })).toMatchObject({
      code: 'peer-offline',
    });
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
  it('classifies socket errors', () => {
    expect(classifyTransport(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))).toEqual({ kind: 'silent' });
    expect(classifyTransport(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toEqual({ kind: 'refused' });
    expect(classifyTransport(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toMatchObject({ kind: 'other' });
    expect(classifyTransport(Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' }))).toMatchObject({
      kind: 'tls',
    });
  });
});
