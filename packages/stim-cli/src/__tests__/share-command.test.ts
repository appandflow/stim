import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerShare, runShare, type ShareDeps } from '../commands/share.ts';
import { workspaceShareLinksFile } from '@stim-cli/core/state';
import { LocalServerUnavailable, requestLocalServer, stopIdleShareServer } from '../local-server.ts';

const ROW = {
  id: 'w1',
  workspace: '/work/app',
  platform: 'android' as const,
  slot: 'default',
  physical: false,
  control: false,
  expiresAt: '2026-11-02T20:00:00.000Z',
  viewers: 0,
  url: 'https://mac.tail.ts.net:10000/s/token/',
};

interface Fake extends ShareDeps {
  sent: { method: string; params: unknown }[];
  notes: string[];
  starts: number;
}

function fake(answers: (() => unknown)[], start: Awaited<ReturnType<ShareDeps['startServer']>> = null): Fake {
  const deps: Fake = {
    sent: [],
    notes: [],
    starts: 0,
    findWorkspace: async () => '/work/app',
    request: async (method, params) => {
      deps.sent.push({ method, params });
      const next = answers.shift();
      if (!next) throw new Error('unexpected request');
      return next() as never;
    },
    startServer: async () => {
      deps.starts++;
      return start;
    },
    stopServer: async () => null,
    note: (line) => deps.notes.push(line),
    platform: 'darwin',
  };
  return deps;
}

const unavailable = () => {
  throw new LocalServerUnavailable('no stim-server socket');
};

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

  it('refuses with the install remedy when no stim-server runs and none of this version is installed', async () => {
    const deps = fake([]);
    deps.request = (method, params) => requestLocalServer(method, params, { version: '9.9.9' });
    expect(await runShare('ios', { control: true }, deps, '9.9.9')).toMatchObject({
      ok: false,
      error: { code: 'STIM_SERVER_NOT_RUNNING', remedy: expect.stringContaining('stim@9.9.9') },
    });
  });

  it.each(['ios', 'android', 'list', 'stop'])(
    'refuses stim share %s on Windows before it asks for or starts a stim-server',
    async (action) => {
      const deps = fake([]);
      deps.platform = 'win32';
      expect(await runShare(action, {}, deps, '1.0.0')).toMatchObject({
        ok: false,
        error: {
          code: 'STIM_SHARE_REFUSED',
          message: expect.stringContaining('not available on Windows'),
          remedy: expect.stringContaining('macOS'),
        },
      });
      expect(deps.sent).toEqual([]);
      expect(deps.starts).toBe(0);
    },
  );

  it('refuses on the host platform without starting or asking a server, as one JSON payload', async () => {
    const startServer = vi.fn<ShareDeps['startServer']>(async () => null);
    const request = vi.fn<ShareDeps['request']>();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = new Command();
      registerShare(program, '1.0.0', { findWorkspace: async () => '/work/app', startServer, request });
      await program.parseAsync(['node', 'stim', 'share', 'ios', '--json']);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 'STIM_SHARE_REFUSED' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(startServer).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      process.exitCode = undefined;
      platform.mockRestore();
      log.mockRestore();
    }
  });

  it('starts a stim-server when none runs, says how to stop it, then shares through it', async () => {
    const deps = fake([unavailable, () => ({ result: { ...ROW, auth: 'generated', password: 'abcdefghjkmnpqrs' } })], {
      started: true,
      pid: 4242,
      log: '/home/server/share-server.log',
    });
    const result = await runShare('android', {}, deps, '1.0.0');
    expect(result).toMatchObject({ ok: true, output: { url: ROW.url } });
    expect(deps.starts).toBe(1);
    expect(deps.notes).toEqual([expect.stringMatching(/pid 4242.*share-server\.log.*stim share stop/)]);
    expect(deps.sent.map((each) => each.method)).toEqual(['share.start', 'share.start']);
  });

  it('uses the server that won the socket instead of the one it started, and reports a start that failed', async () => {
    const joined = fake([unavailable, () => ({ result: { ...ROW, auth: 'generated', password: 'x' } })], {
      started: false,
      reason: 'joined',
    });
    expect(await runShare('android', {}, joined, '1.0.0')).toMatchObject({ ok: true });
    expect(joined.notes).toEqual([]);

    const failed = fake([unavailable], {
      started: false,
      reason: 'failed',
      message: 'stim-server did not start: it exited with code 1.',
      log: '/home/server/share-server.log',
    });
    expect(await runShare('android', {}, failed, '1.0.0')).toMatchObject({
      ok: false,
      error: { code: 'STIM_SERVER_NOT_RUNNING', message: expect.stringContaining('share-server.log') },
    });
  });

  it('never starts a server to list or stop shares', async () => {
    const deps = fake([unavailable, unavailable]);
    expect(await runShare('list', {}, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_SERVER_NOT_RUNNING' } });
    expect(await runShare('stop', {}, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_SERVER_NOT_RUNNING' } });
    expect(deps.starts).toBe(0);
  });

  it('validates the expiry and the password before asking the server', async () => {
    const deps = fake([]);
    for (const opts of [
      { expires: '0' },
      { expires: '481' },
      { password: 'short' },
      { password: 'long enough', bothPasswords: true },
    ]) {
      expect(await runShare('android', opts, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_BAD_ARG' } });
    }
    expect(deps.sent).toEqual([]);
  });

  it('refuses a view password that has no separate control password to go with, before asking the server', async () => {
    const deps = fake([]);
    for (const opts of [
      { viewPassword: true as const },
      { viewPassword: true as const, control: true, password: false as const },
      { viewPassword: 'short', control: true },
      { viewPassword: 'same password', password: 'same password', control: true },
    ]) {
      expect(await runShare('android', opts, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_BAD_ARG' } });
    }
    expect(deps.sent).toEqual([]);
  });

  it('refuses a slug that is malformed, reserved or without a password, before asking the server', async () => {
    const deps = fake([]);
    for (const opts of [
      { slug: 'ab' },
      { slug: 'Pokedex' },
      { slug: '-pokedex' },
      { slug: 'a'.repeat(33) },
      { slug: 'assets' },
      { slug: 'pokedex', password: false as const },
    ]) {
      expect(await runShare('ios', opts, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_BAD_ARG' } });
    }
    expect(deps.sent).toEqual([]);
  });

  it('asks for a slug link, shows it on the row and says the password is its only secret', async () => {
    const deps = fake([
      () => ({ result: { ...ROW, auth: 'generated', slug: 'pokedex', url: 'https://demo.example.com/s/pokedex/' } }),
    ]);
    const result = await runShare('android', { slug: 'pokedex' }, deps, '1.0.0');
    expect(deps.sent[0]?.params).toMatchObject({ slug: 'pokedex' });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('link /s/pokedex/') });
    expect(result).toMatchObject({ text: expect.stringMatching(/only the password keeps the share private/) });
  });

  it('names an outdated stim-server when it does not take a slug', async () => {
    const deps = fake([() => ({ error: { code: 'bad-request', message: 'share.start does not take slug.' } })]);
    expect(await runShare('ios', { slug: 'pokedex' }, deps, '1.0.0')).toMatchObject({
      error: { code: 'STIM_SHARE_REFUSED', remedy: expect.stringContaining('stim service update') },
    });
  });

  it('asks for a generated or a chosen view password and prints both passwords once', async () => {
    const deps = fake([
      () => ({
        result: {
          ...ROW,
          control: true,
          auth: 'generated',
          viewAuth: 'generated',
          password: 'ctrlpass1',
          viewPassword: 'viewpass2',
        },
      }),
      () => ({ result: { ...ROW, control: true, auth: 'generated', viewAuth: 'set', password: 'ctrlpass1' } }),
    ]);
    const generated = await runShare('android', { control: true, viewPassword: true }, deps, '1.0.0');
    expect(deps.sent[0]?.params).toMatchObject({ control: true, view: {} });
    expect(generated).toMatchObject({ ok: true, text: expect.stringContaining('Control password: ctrlpass1') });
    expect(generated).toMatchObject({ text: expect.stringContaining('View password:    viewpass2') });
    const chosen = await runShare('android', { control: true, viewPassword: 'watch only!' }, deps, '1.0.0');
    expect(deps.sent[1]?.params).toMatchObject({ view: { password: 'watch only!' } });
    expect(JSON.stringify(chosen)).not.toContain('watch only!');
  });

  it('sends a password the person set without ever printing it back', async () => {
    const deps = fake([() => ({ result: { ...ROW, auth: 'set' } })]);
    const result = await runShare('android', { password: 'correct horse', expires: '30' }, deps, '1.0.0');
    expect(deps.sent[0]!.params).toMatchObject({ password: 'correct horse', expiresMinutes: 30 });
    expect(JSON.stringify(result)).not.toContain('correct horse');
  });

  it('warns on stderr that anyone with the link can control a passwordless share', async () => {
    const deps = fake([() => ({ result: { ...ROW, control: true, auth: 'none' } })]);
    await runShare('android', { password: false, control: true }, deps, '1.0.0');
    expect(deps.sent[0]!.params).toMatchObject({ passwordless: true, control: true });
    expect(deps.notes).toEqual([expect.stringMatching(/no password.*watch and control/)]);
  });

  it('relays the server warning about a link that only works on this machine, and keeps it in the JSON payload', async () => {
    const warning = 'Proxy mode has no share.publicUrl.';
    const deps = fake([() => ({ result: { ...ROW, auth: 'none', url: 'http://127.0.0.1:7790/s/token/', warning } })]);
    const result = await runShare('android', { password: false }, deps, '1.0.0');
    expect(deps.notes).toContain(`Warning: ${warning}`);
    expect(result).toMatchObject({ ok: true, output: { warning } });
  });

  it('never stops a stim-server that stim share did not start', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await stopIdleShareServer('1.0.0')).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  describe('saved links and --reuse', () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const URL_OF = `https://mac.tail.ts.net:10000/s/${TOKEN}/`;
    const FUTURE = new Date(Date.now() + 40 * 60_000).toISOString();
    const started =
      (overrides: Record<string, unknown> = {}) =>
      () => ({
        result: {
          ...ROW,
          url: URL_OF,
          expiresAt: FUTURE,
          auth: 'generated',
          viewAuth: null,
          password: 'generated-pw-1',
          ...overrides,
        },
      });
    const links = () => JSON.parse(readFileSync(workspaceShareLinksFile('/work/app'), 'utf8')).links;

    it('saves the link and the passwords of a started share, privately, and replaces the entry of the same target', async () => {
      const deps = fake([started(), started({ url: URL_OF.replace('abc', 'xyz') })]);
      await runShare('android', { expires: '40' }, deps, '1.0.0');
      expect(links()).toEqual({
        android: expect.objectContaining({
          token: TOKEN,
          password: 'generated-pw-1',
          auth: 'generated',
          expiresAt: FUTURE,
        }),
      });
      expect(statSync(workspaceShareLinksFile('/work/app')).mode & 0o777).toBe(
        process.platform === 'win32' ? 0o666 : 0o600,
      );
      await runShare('android', {}, deps, '1.0.0');
      expect(Object.keys(links())).toEqual(['android']);
      expect(links().android.token).toBe(TOKEN.replace('abc', 'xyz'));
    });

    it('leaves the file to a server that saved the share, and does not print its saved flag', async () => {
      const deps = fake([started({ saved: true }), started({ saved: true, expiresAt: FUTURE })]);
      const first = await runShare('android', { json: true }, deps, '1.0.0');
      expect(first).toMatchObject({ ok: true });
      expect(first.ok && first.output).not.toHaveProperty('saved');
      expect(existsSync(workspaceShareLinksFile('/work/app'))).toBe(false);
      mkdirSync(dirname(workspaceShareLinksFile('/work/app')), { recursive: true });
      writeFileSync(
        workspaceShareLinksFile('/work/app'),
        JSON.stringify({
          version: 1,
          links: {
            android: {
              platform: 'android',
              slot: 'default',
              physical: false,
              token: TOKEN,
              control: false,
              password: 'generated-pw-1',
              auth: 'generated',
              viewAuth: null,
              state: 'stopped',
              createdAt: FUTURE,
              expiresAt: FUTURE,
            },
          },
        }),
      );
      const reused = await runShare('android', { reuse: true, json: true }, deps, '1.0.0');
      expect(reused).toMatchObject({ ok: true, output: { reused: true } });
      expect(reused.ok && reused.output).not.toHaveProperty('saved');
      expect(links().android.state).toBe('stopped');
    });

    it('keeps one link per platform, slot and physical device, with the password the person set and none for an open share', async () => {
      const deps = fake([
        started({ auth: 'set', password: undefined }),
        started({ slot: 'tablet', auth: 'none', password: undefined, control: true }),
        started({ physical: true }),
      ]);
      await runShare('android', { password: 'my own password' }, deps, '1.0.0');
      await runShare('android', { slot: 'tablet', password: false, control: true }, deps, '1.0.0');
      await runShare('android', { device: true }, deps, '1.0.0');
      expect(Object.keys(links()).toSorted()).toEqual(['android', 'android:device', 'android@tablet']);
      expect(links().android.password).toBe('my own password');
      expect(links()['android@tablet']).not.toHaveProperty('password');
    });

    it('starts the saved link again with its passwords and expiry, says it was reused, and prints no password the person set', async () => {
      const deps = fake([
        started({ control: true, viewAuth: 'generated', viewPassword: 'generated-view-1' }),
        started({ control: true, viewAuth: 'generated' }),
      ]);
      await runShare('android', { control: true, viewPassword: true }, deps, '1.0.0');
      const again = await runShare('android', { reuse: true }, deps, '1.0.0');
      expect(deps.sent[1]!.params).toEqual({
        workspace: '/work/app',
        platform: 'android',
        control: true,
        token: TOKEN,
        expiresAt: FUTURE,
        password: 'generated-pw-1',
        view: { password: 'generated-view-1' },
      });
      expect(again).toMatchObject({
        ok: true,
        output: { reused: true, url: URL_OF, password: 'generated-pw-1', viewPassword: 'generated-view-1' },
        text: expect.stringContaining('Control password: generated-pw-1'),
      });

      const chosen = fake([started({ auth: 'set', password: undefined }), started()]);
      await runShare('android', { password: 'my own password' }, chosen, '1.0.0');
      const reused = await runShare('android', { reuse: true }, chosen, '1.0.0');
      expect(chosen.sent[1]!.params).toMatchObject({ password: 'my own password' });
      expect(JSON.stringify(reused)).not.toContain('my own password');
    });

    it('with --expires, starts it with that many minutes from now and saves the new expiry', async () => {
      const later = new Date(Date.now() + 90 * 60_000).toISOString();
      const deps = fake([started(), started({ expiresAt: later })]);
      await runShare('android', {}, deps, '1.0.0');
      await runShare('android', { reuse: true, expires: '90' }, deps, '1.0.0');
      expect(deps.sent[1]!.params).toMatchObject({ expiresMinutes: 90 });
      expect(deps.sent[1]!.params).not.toHaveProperty('expiresAt');
      expect(links().android.expiresAt).toBe(later);
    });

    it('refuses flags that the saved setup already decides, before asking the server', async () => {
      const deps = fake([started()]);
      await runShare('android', {}, deps, '1.0.0');
      for (const opts of [
        { control: true },
        { password: 'another password' },
        { password: false as const },
        { viewPassword: true as const },
      ]) {
        expect(await runShare('android', { reuse: true, ...opts }, deps, '1.0.0')).toMatchObject({
          ok: false,
          error: { code: 'STIM_BAD_ARG', message: expect.stringContaining('--reuse') },
        });
      }
      expect(await runShare('stop', { reuse: true }, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_BAD_ARG' } });
      expect(await runShare('android', { forget: true }, deps, '1.0.0')).toMatchObject({
        error: { code: 'STIM_BAD_ARG' },
      });
      expect(deps.sent).toHaveLength(1);
    });

    describe('with nothing to reuse', () => {
      const file = () => workspaceShareLinksFile('/work/app');
      const entry = {
        platform: 'android',
        slot: 'default',
        physical: false,
        token: TOKEN,
        control: false,
        password: 'generated-pw-1',
        auth: 'generated',
        viewAuth: null,
        createdAt: FUTURE,
        expiresAt: FUTURE,
      };
      const plant = (overrides: Record<string, unknown> = {}) => {
        mkdirSync(dirname(file()), { recursive: true });
        writeFileSync(file(), JSON.stringify({ version: 1, links: { android: { ...entry, ...overrides } } }));
      };
      const fallsBack = async (opts: Record<string, unknown> = {}) => {
        const deps = fake([started()]);
        const result = await runShare('android', { reuse: true, ...opts }, deps, '1.0.0');
        expect(deps.sent).toHaveLength(1);
        expect(deps.sent[0]?.params).not.toHaveProperty('token');
        expect(deps.notes[0]).toMatch(/^Warning: No saved link to reuse.*Starting a new share instead\.$/);
        expect(result).toMatchObject({
          ok: true,
          output: { reused: false, reuseWarning: expect.stringContaining('No saved link to reuse'), url: URL_OF },
        });
        return { deps, result };
      };

      it('starts a new share and warns, in text and in JSON, when no share was saved', async () => {
        const { deps } = await fallsBack();
        expect(deps.starts).toBe(0);
      });

      it.each([
        ['an expired link', () => plant({ expiresAt: '2020-01-01T00:00:00.000Z' }), {}],
        ['an invalid link', () => plant({ token: 'short' }), {}],
        [
          'a link that expires within seconds',
          () => plant({ expiresAt: new Date(Date.now() + 2000).toISOString() }),
          {},
        ],
        ['a link saved for another slot', () => plant(), { slot: 'tablet' }],
        ['a link saved for the simulator when the device is asked for', () => plant(), { device: true }],
      ])('does the same for %s', async (_name, arrange, opts) => {
        arrange();
        const { result } = await fallsBack(opts);
        expect(result).toMatchObject({ ok: true });
      });

      it('honors the flags given with it, since there is no saved setup to conflict with, and saves the new link', async () => {
        const deps = fake([started({ control: true, auth: 'set', password: undefined })]);
        await runShare(
          'android',
          { reuse: true, control: true, expires: '30', password: 'my own password' },
          deps,
          '1.0.0',
        );
        expect(deps.sent[0]?.params).toMatchObject({ control: true, expiresMinutes: 30, password: 'my own password' });
        expect(links().android).toMatchObject({ token: TOKEN, control: true, password: 'my own password' });
      });

      it('still refuses flags that conflict with a saved share, including --slug', async () => {
        plant();
        const deps = fake([]);
        expect(await runShare('android', { reuse: true, slug: 'pokedex' }, deps, '1.0.0')).toMatchObject({
          ok: false,
          error: { code: 'STIM_BAD_ARG', message: expect.stringContaining('--slug') },
        });
        expect(deps.sent).toEqual([]);
      });
    });

    it('does not say the password was saved when saving the link failed', async () => {
      mkdirSync(workspaceShareLinksFile('/work/app'), { recursive: true });
      const deps = fake([started()]);
      const result = await runShare('android', {}, deps, '1.0.0');
      expect(deps.notes).toEqual([expect.stringContaining('could not save the link')]);
      expect(result).toMatchObject({
        ok: true,
        text: expect.stringContaining('Password: generated-pw-1'),
      });
      expect(result).toMatchObject({ text: expect.stringContaining('shown only now') });
      expect(JSON.stringify(result)).not.toMatch(/--reuse|--forget/);
    });

    it('keeps the saved links when stop --forget could not stop the shares', async () => {
      const deps = fake([started(), () => ({ error: { code: 'bad-request', message: 'stim-server refused.' } })]);
      await runShare('android', {}, deps, '1.0.0');
      expect(await runShare('stop', { forget: true }, deps, '1.0.0')).toMatchObject({
        ok: false,
        error: { code: 'STIM_SHARE_REFUSED' },
      });
      expect(links()).toHaveProperty('android');
    });

    it('says a stopped share can be reused only when its link was saved', async () => {
      const deps = fake([started(), () => ({ result: { stopped: [{ ...ROW, platform: 'ios' }] } })]);
      await runShare('android', {}, deps, '1.0.0');
      const result = await runShare('stop', {}, deps, '1.0.0');
      expect(result).toMatchObject({ ok: true, text: expect.stringContaining('Reusable until') });
      expect(JSON.stringify(result)).not.toContain('until reused');
    });

    it('says when the stim-server it stopped has not exited yet', async () => {
      const deps = fake([() => ({ result: { stopped: [ROW] } })]);
      deps.stopServer = async () => ({ pid: 4242, exited: false });
      expect(await runShare('stop', {}, deps, '1.0.0')).toMatchObject({
        ok: true,
        output: { stoppedServer: 4242, stillStopping: true },
        text: expect.stringContaining('has not exited yet'),
      });
    });

    it('says the stim-server was left running when a share start is in flight', async () => {
      const deps = fake([() => ({ result: { stopped: [] } })]);
      deps.stopServer = async () => ({ pid: 4242, starting: 1 });
      const result = await runShare('stop', {}, deps, '1.0.0');
      expect(result).toMatchObject({
        ok: true,
        output: { keptServer: 4242, startingShares: 1 },
        text: expect.stringContaining('Left the stim-server stim share started (pid 4242) running'),
      });
      expect(JSON.stringify(result)).not.toContain('stoppedServer');
    });

    it('tells the person to update an older stim-server that does not take a saved link', async () => {
      const deps = fake([
        started(),
        () => ({ error: { code: 'bad-request', message: 'share.start does not take token, expiresAt.' } }),
      ]);
      await runShare('android', {}, deps, '1.0.0');
      expect(await runShare('android', { reuse: true }, deps, '1.0.0')).toMatchObject({
        ok: false,
        error: { code: 'STIM_SHARE_REFUSED', remedy: expect.stringContaining('stim service update') },
      });
    });

    it('stop keeps the saved links reusable and lists them without any secret, and stop --forget deletes them', async () => {
      const deps = fake([started(), () => ({ result: { stopped: [ROW] } }), () => ({ result: { stopped: [] } })]);
      await runShare('android', {}, deps, '1.0.0');
      const stopped = await runShare('stop', {}, deps, '1.0.0');
      expect(stopped).toMatchObject({
        ok: true,
        output: { reusable: [{ platform: 'android', slot: 'default', physical: false, expiresAt: FUTURE }] },
        text: expect.stringContaining('stim share android --reuse'),
      });
      expect(JSON.stringify(stopped)).not.toContain(TOKEN);
      expect(JSON.stringify(stopped)).not.toContain('generated-pw-1');
      expect(existsSync(workspaceShareLinksFile('/work/app'))).toBe(true);

      const forgotten = await runShare('stop', { forget: true }, deps, '1.0.0');
      expect(forgotten).toMatchObject({ ok: true, output: { forgot: 1 } });
      expect(existsSync(workspaceShareLinksFile('/work/app'))).toBe(false);
    });

    it('saves a share with a chosen slug by its slug, with no token, and reuses it under the same slug', async () => {
      const slugUrl = 'https://mac.tail.ts.net:10000/s/pokedex/';
      const deps = fake([started({ url: slugUrl, slug: 'pokedex' }), started({ url: slugUrl, slug: 'pokedex' })]);
      await runShare('android', { slug: 'pokedex' }, deps, '1.0.0');
      expect(links().android).toMatchObject({ slug: 'pokedex', password: 'generated-pw-1', state: 'live' });
      expect(links().android).not.toHaveProperty('token');
      await runShare('android', { reuse: true }, deps, '1.0.0');
      expect(deps.sent[1]?.params).toMatchObject({ slug: 'pokedex', password: 'generated-pw-1', expiresAt: FUTURE });
      expect(deps.sent[1]?.params).not.toHaveProperty('token');
    });

    it('still sends share.stop when the saved links cannot be marked stopped', async () => {
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const deps = fake([started(), () => ({ result: { stopped: [ROW] } })]);
      await runShare('android', {}, deps, '1.0.0');
      const dir = dirname(workspaceShareLinksFile('/work/app'));
      chmodSync(dir, 0o500);
      try {
        const stopped = await runShare('stop', {}, deps, '1.0.0');
        expect(deps.sent.map((sent) => sent.method)).toEqual(['share.start', 'share.stop']);
        expect(stopped).toMatchObject({ ok: true, output: { stopped: [ROW] } });
        expect(deps.notes.join('\n')).toContain('could not mark the saved links stopped');
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it('keeps a saved share live while it runs, stopped after a stop, and live again when reused', async () => {
      const deps = fake([started(), () => ({ result: { stopped: [ROW] } }), started()]);
      await runShare('android', {}, deps, '1.0.0');
      expect(links().android.state).toBe('live');
      await runShare('stop', {}, deps, '1.0.0');
      expect(links().android.state).toBe('stopped');
      await runShare('android', { reuse: true }, deps, '1.0.0');
      expect(links().android.state).toBe('live');
    });

    it('stop --forget still forgets when no stim-server runs, and stop alone then reports the missing server', async () => {
      const deps = fake([started(), unavailable, unavailable]);
      await runShare('android', {}, deps, '1.0.0');
      expect(await runShare('stop', { forget: true }, deps, '1.0.0')).toMatchObject({
        ok: true,
        output: { forgot: 1 },
      });
      expect(existsSync(workspaceShareLinksFile('/work/app'))).toBe(false);
      expect(await runShare('stop', {}, deps, '1.0.0')).toMatchObject({ error: { code: 'STIM_SERVER_NOT_RUNNING' } });
    });
  });
});
