import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packStim } from '../src/machine-update.ts';
import { EngineUpdates } from '../src/server-update.ts';
import { serviceRoot } from '../src/service-manager.ts';

it('authorizes a package update, verifies uploaded bytes and drains until the detached updater exits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-engine-update-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('LOCALAPPDATA', home);
  vi.stubEnv('STIM_HOME', home);
  const script = join(home, 'updater.mjs');
  const output = join(home, 'received.json');
  writeFileSync(
    script,
    `
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1];
writeFileSync(process.env.UPDATE_OUTPUT, JSON.stringify({
  args, files: Object.fromEntries(readdirSync(from).map(name => [name, readFileSync(join(from, name)).toString('base64')]))
}));
`,
  );
  const drains: (string | null)[] = [];
  let finish!: (ok: boolean) => void;
  const ended = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let accepts = false;
  const updates = new EngineUpdates({
    label: 'dev.stim.test',
    port: 7787,
    build: { version: '1.40.0', stimBuild: 'aaaaaaaaaaaaaaaa' },
    node: process.execPath,
    script,
    env: { ...process.env, UPDATE_OUTPUT: output },
    acceptsClientBuilds: () => accepts,
    runsAsService: async () => true,
    detached: (file, args) => ({ file, args }),
    drain: (reason) => drains.push(reason),
    audit: ({ phase, ok }) => {
      if (phase === 'ended' && drains.length) finish(ok);
    },
  });
  try {
    const by = { id: 'approved-build-client', name: 'Laptop' };
    const source = join(home, 'source');
    mkdirSync(join(source, 'bin'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'stim', version: '1.42.0', files: ['bin'] }));
    writeFileSync(join(source, 'bin', 'stim.mjs'), 'console.log("1.42.0");');
    const { name, bytes, sha256 } = await packStim(source);
    const packages = [{ name, size: bytes.length, sha256 }];
    expect(await updates.start(by, { version: 'latest' })).toMatchObject({ error: { code: 'bad-request' } });
    expect(await updates.start(by, { packages })).toMatchObject({ error: { code: 'forbidden' } });
    accepts = true;
    const corrupt = await updates.start(by, { packages });
    if (!('result' in corrupt)) throw new Error(corrupt.error.message);
    expect(
      updates.chunk(by.id, {
        id: corrupt.result.id,
        name,
        offset: 0,
        data: Buffer.alloc(bytes.length).toString('base64'),
      }),
    ).toMatchObject({ error: { code: 'bad-request' } });
    const started = await updates.start(by, { packages });
    expect(started).toMatchObject({ result: { state: 'uploading', missing: [{ name, offset: 0 }] } });
    if (!('result' in started)) throw new Error(started.error.message);
    const chunk = { id: started.result.id, name, offset: 0, data: bytes.toString('base64') };
    expect(updates.chunk('another-client', chunk)).toMatchObject({ error: { code: 'bad-request' } });
    expect(updates.chunk(by.id, { ...chunk, offset: 1 })).toMatchObject({ error: { code: 'bad-request' } });
    expect(updates.chunk(by.id, chunk)).toMatchObject({ result: { state: 'installing', missing: [] } });
    expect(await ended).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      args: [
        'service',
        'update',
        '--label',
        'dev.stim.test',
        '--from',
        join(serviceRoot('dev.stim.test'), 'incoming', started.result.id),
      ],
      files: { [name]: bytes.toString('base64') },
    });
    expect(drains).toEqual(['stim-server is updating to packages from Laptop', null]);
    expect((await updates.status()).running).toBeNull();
  } finally {
    updates.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
