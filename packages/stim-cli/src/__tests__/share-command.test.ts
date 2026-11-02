import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShare } from '../commands/share.ts';
import { requestLocalServer } from '../local-server.ts';

describe('stim share', () => {
  let home: string;
  const previous = process.env.STIM_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-share-cli-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses with the start-the-server remedy when no stim-server runs for this Stim home', async () => {
    const result = await runShare(
      'ios',
      { control: true },
      {
        findWorkspace: async () => '/work/app',
        request: (method, params) => requestLocalServer(method, params, { version: 'test' }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'STIM_SERVER_NOT_RUNNING', remedy: expect.stringContaining('stim-server service install') },
    });
  });

  it('requires an expiry within the limit and sends the share request to the server', async () => {
    const sent: unknown[] = [];
    const deps = {
      findWorkspace: async () => '/work/app',
      request: async (method: string, params: unknown) => {
        sent.push({ method, params });
        return { error: { code: 'action-failed', message: 'not now' } };
      },
    };
    expect(await runShare('android', { expires: '0' }, deps)).toMatchObject({ error: { code: 'STIM_BAD_ARG' } });
    expect(await runShare('android', { expires: '481' }, deps)).toMatchObject({ error: { code: 'STIM_BAD_ARG' } });
    expect(sent).toEqual([]);
    expect(await runShare('android', { expires: '30', slot: 'b', device: true }, deps)).toMatchObject({
      error: { code: 'STIM_SHARE_REFUSED', message: 'not now' },
    });
    expect(sent).toEqual([
      {
        method: 'share.start',
        params: {
          workspace: '/work/app',
          platform: 'android',
          slot: 'b',
          physical: true,
          control: false,
          expiresMinutes: 30,
        },
      },
    ]);
  });
});
