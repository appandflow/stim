import type { LiveShareLink } from '@stim-cli/core/state';
import { restoreSavedShares, savedShareParams, type ShareRestoreDeps } from '../src/share-restore.ts';

const link = (share: Partial<LiveShareLink['share']> = {}): LiveShareLink => ({
  workspace: '/work/app',
  key: 'ios',
  share: {
    platform: 'ios',
    slot: 'default',
    physical: false,
    token: 'a'.repeat(43),
    control: false,
    password: 'generated-password',
    auth: 'generated',
    viewAuth: null,
    state: 'live',
    createdAt: '2026-11-04T00:00:00.000Z',
    expiresAt: '2026-11-04T05:00:00.000Z',
    ...share,
  },
});

describe('the share.start params of a saved share', () => {
  it('carry its token, password and exact expiry, and leave a default slot out', () => {
    expect(savedShareParams(link())).toEqual({
      workspace: '/work/app',
      platform: 'ios',
      control: false,
      token: 'a'.repeat(43),
      expiresAt: '2026-11-04T05:00:00.000Z',
      password: 'generated-password',
    });
  });

  it('carry a slug instead of a token, a slot, a device, a view password, or no login at all', () => {
    expect(
      savedShareParams(
        link({
          token: undefined,
          slug: 'demo',
          slot: 'tablet',
          physical: true,
          platform: 'android',
          control: true,
          viewPassword: 'view-password',
        }),
      ),
    ).toEqual({
      workspace: '/work/app',
      platform: 'android',
      slot: 'tablet',
      physical: true,
      control: true,
      slug: 'demo',
      expiresAt: '2026-11-04T05:00:00.000Z',
      password: 'generated-password',
      view: { password: 'view-password' },
    });
    expect(savedShareParams(link({ password: undefined, auth: 'none' }))).toMatchObject({ passwordless: true });
  });
});

describe('restoring saved shares', () => {
  function deps(answers: Array<Awaited<ReturnType<ShareRestoreDeps['start']>>>) {
    const lines: string[] = [];
    const waits: number[] = [];
    const calls: Record<string, unknown>[] = [];
    let closed = false;
    const d: ShareRestoreDeps = {
      start: async (params) => {
        calls.push(params);
        return answers.shift() ?? { code: 'action-failed', message: 'out of answers' };
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      closed: () => closed,
      log: (line) => lines.push(line),
    };
    return {
      d,
      lines,
      waits,
      calls,
      close: () => {
        closed = true;
      },
    };
  }

  it('starts each live share once and says so', async () => {
    const f = deps([{ started: true }, { started: true }]);
    await restoreSavedShares(f.d, [link(), link({ platform: 'android' })]);
    expect(f.calls).toHaveLength(2);
    expect(f.lines).toEqual([
      'restored the web share of ios of /work/app',
      'restored the web share of android of /work/app',
    ]);
  });

  it('tries again with a growing wait while the server cannot start it yet, then restores it', async () => {
    const f = deps([
      { code: 'action-failed', message: 'Tailscale is not running.' },
      { code: 'action-failed', message: 'Tailscale is not running.' },
      { started: true },
    ]);
    await restoreSavedShares(f.d, [link()]);
    expect(f.waits).toEqual([5000, 10_000]);
    expect(f.lines).toEqual(['restored the web share of ios of /work/app']);
  });

  it('gives up after five waits and leaves a refused share alone', async () => {
    const forever = deps([]);
    await restoreSavedShares(forever.d, [link()]);
    expect(forever.waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000]);
    expect(forever.lines).toEqual(['did not restore the web share of ios of /work/app: out of answers']);

    const refused = deps([{ code: 'bad-request', message: 'That link is live now.' }]);
    await restoreSavedShares(refused.d, [link()]);
    expect(refused.waits).toEqual([]);
    expect(refused.lines).toEqual(['did not restore the web share of ios of /work/app: That link is live now.']);
  });

  it('stops when the server is closing', async () => {
    const f = deps([{ code: 'action-failed', message: 'later' }]);
    f.d.wait = async () => {
      f.close();
    };
    await restoreSavedShares(f.d, [link()]);
    expect(f.calls).toHaveLength(1);
  });
});
