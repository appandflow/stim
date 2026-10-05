import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUpdateStart, ServerUpdates, type ServerUpdateOptions } from '../src/server-update.ts';

const LABEL = 'dev.stim.test';

const FAKE_UPDATER = `
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1];
const files = args.includes('--from')
  ? Object.fromEntries(readdirSync(from).map((name) => [name, readFileSync(join(from, name), 'utf8')]))
  : null;
writeFileSync(process.env.FAKE_UPDATER_OUT, JSON.stringify({ args, files }));
const root = join(process.env.HOME, 'Library', 'Application Support', 'Stim', 'services', args[args.indexOf('--label') + 1]);
mkdirSync(root, { recursive: true });
const ok = process.env.FAKE_UPDATER_FAIL !== '1';
writeFileSync(join(root, 'last-update.json'), JSON.stringify({
  at: new Date().toISOString(), target: 'x', ok, message: ok ? 'now runs the new server' : 'did not answer',
}));
console.log('Installing.');
process.exit(ok ? 0 : 1);
`;

let dir: string;
let home: string | undefined;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const by = { id: 'client-1', name: 'Laptop' };

function updates(overrides: Partial<ServerUpdateOptions> = {}) {
  const drains: (string | null)[] = [];
  const finished: { ok: boolean; message: string; target: string }[] = [];
  const started: string[] = [];
  const script = join(dir, 'updater.mjs');
  writeFileSync(script, FAKE_UPDATER);
  const instance = new ServerUpdates({
    label: LABEL,
    port: 7787,
    build: { version: '1.14.0', stimBuild: 'aaaaaaaaaaaaaaaa' },
    node: process.execPath,
    script,
    env: { ...process.env, FAKE_UPDATER_OUT: join(dir, 'ran.json') },
    acceptsClientBuilds: () => false,
    drain: (reason) => drains.push(reason),
    audit: ({ phase, ok, message, target }) => {
      if (phase === 'ended') finished.push({ ok, message, target });
      else started.push(target);
    },
    runsAsService: async () => true,
    ...overrides,
  });
  const settled = async () => {
    for (let i = 0; i < 500 && finished.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return finished;
  };
  return {
    instance,
    drains,
    finished,
    started,
    settled,
    ran: () => JSON.parse(readFileSync(join(dir, 'ran.json'), 'utf8')),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-server-update-'));
  home = process.env.HOME;
  process.env.HOME = dir;
});

afterEach(() => {
  process.env.HOME = home;
  rmSync(dir, { recursive: true, force: true });
});

describe('server update requests', () => {
  it('takes an exact release or a bounded list of .tgz packages', () => {
    expect(parseUpdateStart({ release: '1.15.0' })).toEqual({ release: '1.15.0' });
    expect(parseUpdateStart({ release: '^1.15.0' })).toContain('exact stim-server version');
    expect(parseUpdateStart({ release: '1.15.0', packages: [] })).toContain('exactly one');
    expect(parseUpdateStart({ packages: [{ name: '../stim.tgz', size: 1, sha256: sha('x') }] })).toContain('.tgz name');
    expect(parseUpdateStart({ packages: [{ name: 'stim.tgz', size: 1, sha256: 'x' }] })).toContain('sha256');
    const entry = { name: 'stim.tgz', size: 1, sha256: sha('x') };
    expect(parseUpdateStart({ packages: [entry, { ...entry, name: 'STIM.tgz' }] })).toContain('listed twice');
    expect(parseUpdateStart({ packages: [{ ...entry, size: 64 * 1024 ** 2 + 1 }] })).toContain('64 MiB');
    const many = Array.from({ length: 9 }, (_, index) => ({ ...entry, name: `p${index}.tgz` }));
    expect(parseUpdateStart({ packages: many })).toContain('1 to 8');
    const large = Array.from({ length: 3 }, (_, index) => ({ ...entry, name: `p${index}.tgz`, size: 50 * 1024 ** 2 }));
    expect(parseUpdateStart({ packages: large })).toContain('128 MiB');
  });

  it('runs the update of a release detached, draining new work until it ends', async () => {
    const { instance, drains, settled, ran, started: audited } = updates();
    const started = await instance.start(by, { release: '1.15.0' });
    expect(audited).toEqual(['release 1.15.0']);
    expect(started).toMatchObject({ result: { by, target: 'release 1.15.0', state: 'installing' } });
    expect(await instance.start(by, { release: '1.15.0' })).toMatchObject({ error: { code: 'action-busy' } });
    expect(await settled()).toEqual([{ ok: true, message: 'now runs the new server', target: 'release 1.15.0' }]);
    expect(ran().args).toEqual(['service', 'update', '--label', LABEL, '--release', '1.15.0']);
    expect(drains).toEqual(['stim-server is updating to release 1.15.0', null]);
    expect((await instance.status()).last).toMatchObject({ ok: true, message: 'now runs the new server' });
    expect((await instance.status()).running).toBeNull();
  });

  it('reports a failed update and takes new work again', async () => {
    const { instance, drains, settled } = updates({
      env: { ...process.env, FAKE_UPDATER_OUT: join(dir, 'ran.json'), FAKE_UPDATER_FAIL: '1' },
    });
    await instance.start(by, { release: '1.15.0' });
    expect(await settled()).toMatchObject([{ ok: false, message: 'did not answer' }]);
    expect(drains.at(-1)).toBeNull();
  });

  it('refuses when the server does not run as a service', async () => {
    const { instance, drains } = updates({ runsAsService: async () => false });
    expect(await instance.start(by, { release: '1.15.0' })).toMatchObject({
      error: { code: 'forbidden', message: expect.stringContaining('LaunchAgent') },
    });
    expect((await instance.status()).service).toBeNull();
    expect(drains).toEqual([]);
  });

  it("takes a client's own packages only while the Mac accepts client builds", async () => {
    const packages = [{ name: 'server.tgz', size: 6, sha256: sha('server') }];
    expect(await updates().instance.start(by, { packages })).toMatchObject({
      error: { code: 'forbidden', message: expect.stringContaining('server.acceptClientBuilds') },
    });

    const { instance, settled, ran } = updates({ acceptsClientBuilds: () => true });
    const started = await instance.start(by, {
      packages: [...packages, { name: 'stim.tgz', size: 4, sha256: sha('stim') }],
    });
    expect(started).toMatchObject({
      result: {
        state: 'uploading',
        missing: [
          { name: 'server.tgz', offset: 0 },
          { name: 'stim.tgz', offset: 0 },
        ],
      },
    });
    const id = (started as { result: { id: string } }).result.id;
    const chunk = (name: string, offset: number, text: string) =>
      instance.chunk(by.id, { id, name, offset, data: Buffer.from(text).toString('base64') });
    expect(instance.chunk('client-2', { id, name: 'stim.tgz', offset: 0, data: 'c3RpbQ==' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(chunk('server.tgz', 0, 'ser')).toMatchObject({ result: { state: 'uploading' } });
    expect(chunk('server.tgz', 0, 'ser')).toMatchObject({ error: { message: expect.stringContaining('offset 3') } });
    expect(chunk('server.tgz', 3, 'ver')).toMatchObject({ result: { missing: [{ name: 'stim.tgz', offset: 0 }] } });
    expect(chunk('stim.tgz', 0, 'stim')).toMatchObject({ result: { state: 'installing', missing: [] } });
    expect(chunk('stim.tgz', 0, 'stim')).toMatchObject({ error: { code: 'action-busy' } });
    expect(await settled()).toMatchObject([{ ok: true }]);
    const { args, files } = ran();
    expect(args.slice(0, 5)).toEqual(['service', 'update', '--label', LABEL, '--from']);
    expect(files).toEqual({ 'server.tgz': 'server', 'stim.tgz': 'stim' });
  });

  it('clears only uploads an earlier update already used or that sat for an hour', () => {
    const root = join(dir, 'Library', 'Application Support', 'Stim', 'services', LABEL);
    const age = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    for (const [name, minutes] of [
      ['used', 30],
      ['stale', 180],
      ['fresh', 5],
    ] as const) {
      mkdirSync(join(root, 'incoming', name), { recursive: true });
      utimesSync(join(root, 'incoming', name), age(minutes), age(minutes));
    }
    writeFileSync(
      join(root, 'last-update.json'),
      JSON.stringify({ at: age(10).toISOString(), target: 'x', ok: true, message: 'done' }),
    );
    updates();
    expect(['used', 'stale', 'fresh'].filter((name) => existsSync(join(root, 'incoming', name)))).toEqual(['fresh']);
  });

  it('drops an upload whose bytes do not match the sha256 it offered, without draining', async () => {
    const { instance, drains, finished, started: audited } = updates({ acceptsClientBuilds: () => true });
    const started = await instance.start(by, { packages: [{ name: 'server.tgz', size: 6, sha256: sha('server') }] });
    const id = (started as { result: { id: string } }).result.id;
    expect(
      instance.chunk(by.id, { id, name: 'server.tgz', offset: 0, data: Buffer.from('forged').toString('base64') }),
    ).toMatchObject({ error: { message: expect.stringContaining('sha256') } });
    expect(finished).toMatchObject([{ ok: false }]);
    expect(audited).toEqual([]);
    expect(drains).toEqual([]);
    expect((await instance.status()).running).toBeNull();
  });
});
