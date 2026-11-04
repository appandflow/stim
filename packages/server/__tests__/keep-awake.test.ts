import { createKeepAwake, keepAwakeReason, type KeepAwakeOptions } from '../src/keep-awake.ts';
import { FakeHolder } from './keep-awake-holder.ts';

function fixture(overrides: { platform?: NodeJS.Platform; loopbackOnly?: boolean } = {}) {
  const state = { setting: true, remote: true };
  const holders: FakeHolder[] = [];
  const spawned: number[] = [];
  const changes = new Set<() => void>();
  const options: KeepAwakeOptions & { loopbackOnly: boolean; remoteListening: () => boolean } = {
    setting: () => state.setting,
    onChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    platform: overrides.platform ?? 'darwin',
    loopbackOnly: overrides.loopbackOnly ?? false,
    remoteListening: () => state.remote,
    spawnHolder: (serverPid) => {
      spawned.push(serverPid);
      const holder = new FakeHolder(9000 + holders.length);
      holders.push(holder);
      return holder;
    },
  };
  return { state, holders, spawned, changes, awake: createKeepAwake(options) };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('keepAwakeReason', () => {
  const on = { platform: 'darwin' as const, setting: true, loopbackOnly: false, remoteListening: true };

  it('holds only when the setting is on, the platform is macOS, and the server accepts other machines', () => {
    expect(keepAwakeReason(on)).toBeNull();
    expect(keepAwakeReason({ ...on, setting: false })).toBe('off');
    expect(keepAwakeReason({ ...on, platform: 'linux' })).toBe('unsupported');
    expect(keepAwakeReason({ ...on, platform: 'win32' })).toBe('unsupported');
    expect(keepAwakeReason({ ...on, loopbackOnly: true })).toBe('loopback-only');
    expect(keepAwakeReason({ ...on, remoteListening: false })).toBe('not-listening');
  });
});

describe('keep awake', () => {
  it('holds one assertion for this server while on and listening, and releases it when the setting turns off', () => {
    const { awake, state, holders, spawned, changes } = fixture();
    awake.sync();
    awake.sync();
    expect(spawned).toEqual([process.pid]);
    expect(awake.status()).toEqual({ setting: true, held: true, pid: 9000 });
    state.setting = false;
    for (const listener of changes) listener();
    expect(holders[0]?.stopped).toBe(true);
    expect(awake.status()).toEqual({ setting: false, held: false, reason: 'off' });
    state.setting = true;
    for (const listener of changes) listener();
    expect(awake.status()).toMatchObject({ held: true, pid: 9001 });
  });

  it('releases when the last listener for other machines goes away and takes it again when one returns', () => {
    const { awake, state, holders } = fixture();
    awake.sync();
    state.remote = false;
    awake.sync();
    expect(holders[0]?.stopped).toBe(true);
    expect(awake.status()).toEqual({ setting: true, held: false, reason: 'not-listening' });
    state.remote = true;
    awake.sync();
    expect(awake.status()).toMatchObject({ held: true });
    expect(holders).toHaveLength(2);
  });

  it('releases on close and holds nothing afterward', () => {
    const { awake, holders, changes } = fixture();
    awake.sync();
    awake.close();
    expect(holders[0]?.stopped).toBe(true);
    expect(changes.size).toBe(0);
    awake.sync();
    expect(holders).toHaveLength(1);
    expect(awake.status().held).toBe(false);
  });

  it('never holds for a loopback-only server', () => {
    const { awake, spawned } = fixture({ loopbackOnly: true });
    awake.sync();
    expect(spawned).toEqual([]);
    expect(awake.status()).toEqual({ setting: true, held: false, reason: 'loopback-only' });
  });

  it('holds nothing on Linux and Windows and reports that it is unsupported', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { awake, spawned } = fixture({ platform });
      awake.sync();
      expect(spawned).toEqual([]);
      expect(awake.status()).toEqual({ setting: true, held: false, reason: 'unsupported' });
    }
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('only macOS supports it'));
  });

  it('reports a holder that stops on its own and does not restart it until the conditions change', () => {
    const { awake, holders, state } = fixture();
    awake.sync();
    holders[0]?.emit('exit', 1, null);
    expect(awake.status()).toEqual({ setting: true, held: false, reason: 'failed' });
    awake.sync();
    expect(holders).toHaveLength(1);
    state.remote = false;
    awake.sync();
    state.remote = true;
    awake.sync();
    expect(holders).toHaveLength(2);
    expect(awake.status().held).toBe(true);
  });

  it('reports a holder that could not start as failed', () => {
    const awake = createKeepAwake({
      setting: () => true,
      platform: 'darwin',
      loopbackOnly: false,
      remoteListening: () => true,
      spawnHolder: () => new FakeHolder(undefined),
    });
    awake.sync();
    expect(awake.status()).toEqual({ setting: true, held: false, reason: 'failed' });
  });
});
