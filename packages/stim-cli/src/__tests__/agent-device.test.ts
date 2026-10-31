import { daemonEnv, metroHintFrom, readRemoteSimulatorArch, remoteProfile } from '../engine/agent-device.ts';

const DAEMON = { baseUrl: 'https://sim-42.eas.dev/daemon', token: 'tok_secret' };

describe('the connection profile', () => {
  test('never contains the token', () => {
    const profile = remoteProfile({ daemon: DAEMON, platform: 'ios', label: 'wt' });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('tok_secret');
    expect(serialized).not.toContain('AuthToken');
  });
});

describe('the token travels as an environment variable', () => {
  test('daemonEnv uses the name agent-device and eas-cli both already use', () => {
    expect(daemonEnv(DAEMON)).toEqual({ AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_secret' });
  });
});

describe('the bare-RN Metro hint', () => {
  test('a portless origin takes its port from the scheme', () => {
    expect(metroHintFrom('https://abc.trycloudflare.com')).toEqual({ host: 'abc.trycloudflare.com', port: '443' });
    expect(metroHintFrom('http://abc.example.com')).toEqual({ host: 'abc.example.com', port: '80' });
  });
});

describe('the remote simulator arch', () => {
  function respond(body: unknown, ok = true): typeof fetch {
    return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  }

  test.each([
    ['no daemon', null, respond({ hostArch: 'x86_64' })],
    ['an absent field', { baseUrl: 'https://d' }, respond({ ok: true })],
    ['an error status', { baseUrl: 'https://d' }, respond({ hostArch: 'x86_64' }, false)],
    [
      'a refused connection',
      { baseUrl: 'https://d' },
      (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    ],
    [
      'a body that is not JSON',
      'https://d',
      (async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError('x')) })) as unknown as typeof fetch,
    ],
  ] as [string, { baseUrl: string } | null, typeof fetch][])('%s means arm64', async (_name, baseUrl, fetchImpl) => {
    expect(await readRemoteSimulatorArch(baseUrl, { fetch: fetchImpl })).toBe('arm64');
  });
});
