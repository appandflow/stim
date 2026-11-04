import { createKeepAwake, type KeepAwakeOptions } from '../src/keep-awake.ts';
import { FakeHolder } from './keep-awake-holder.ts';

function fixture(platform: NodeJS.Platform = 'darwin') {
  const state = { setting: true };
  const holders: FakeHolder[] = [];
  const options: KeepAwakeOptions & { loopbackOnly: boolean; remoteListening: () => boolean } = {
    setting: () => state.setting,
    platform,
    loopbackOnly: false,
    remoteListening: () => true,
    spawnHolder: () => {
      const holder = new FakeHolder(9000 + holders.length);
      holders.push(holder);
      return holder;
    },
  };
  return { state, holders, awake: createKeepAwake(options) };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('keep awake', () => {
  it('holds nothing on Linux and Windows and reports that it is unsupported', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { awake, holders } = fixture(platform);
      awake.sync();
      expect(holders).toEqual([]);
      expect(awake.status()).toEqual({ setting: true, held: false, reason: 'unsupported' });
    }
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('only macOS supports it'));
  });

  it('reports a holder that stops on its own and starts a new one only after the setting is turned off and on', () => {
    const { awake, holders, state } = fixture();
    awake.sync();
    holders[0]?.emit('exit', 1, null);
    expect(awake.status()).toEqual({ setting: true, held: false, reason: 'failed' });
    awake.sync();
    expect(holders).toHaveLength(1);
    state.setting = false;
    awake.sync();
    state.setting = true;
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

  it('reports a holder that cannot be spawned as failed, whatever error spawn throws', () => {
    const awake = createKeepAwake({
      setting: () => true,
      platform: 'darwin',
      loopbackOnly: false,
      remoteListening: () => true,
      spawnHolder: () => {
        throw Object.assign(new Error('spawn caffeinate EPERM'), { code: 'EPERM' });
      },
    });
    expect(() => awake.sync()).not.toThrow();
    expect(awake.status()).toEqual({ setting: true, held: false, reason: 'failed' });
  });
});
