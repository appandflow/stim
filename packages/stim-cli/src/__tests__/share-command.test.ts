import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerShare, runShare, type ShareDeps } from '../commands/share.ts';
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
      error: { code: 'STIM_SERVER_NOT_RUNNING', remedy: expect.stringContaining('@stim-cli/server@9.9.9') },
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

  it('lists each share with its state, and says when it waits for its device', async () => {
    const deps = fake([
      () => ({
        result: {
          shares: [
            { ...ROW, state: 'live' },
            { ...ROW, id: 'w2', slot: 'beta', state: 'waiting' },
          ],
        },
      }),
    ]);
    const result = await runShare('list', {}, deps, '1.0.0');
    expect(result).toMatchObject({ ok: true, output: { shares: [{ state: 'live' }, { state: 'waiting' }] } });
    const lines = (result as { text: string }).text.split('\n');
    expect(lines[0]).not.toContain('waiting');
    expect(lines[1]).toContain('waiting for the device');
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
      error: { code: 'STIM_SHARE_REFUSED', remedy: expect.stringContaining('stim-server service update') },
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
});
