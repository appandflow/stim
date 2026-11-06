import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packWorkspace, workspacePackages } from '../src/machine-update.ts';
import { EngineUpdates } from '../src/server-update.ts';
import { serviceRoot } from '../src/service-manager.ts';

it('authorizes a package update, verifies uploaded bytes and drains until the detached engine-select exits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-engine-update-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('LOCALAPPDATA', home);
  vi.stubEnv('STIM_HOME', home);
  const root = join(home, 'engine');
  const script = join(root, '0123456789ab', 'dist', 'cli.mjs');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, '');
  const select = join(home, 'select.mjs');
  const output = join(home, 'received.json');
  writeFileSync(
    select,
    `
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1];
writeFileSync(process.env.UPDATE_OUTPUT, JSON.stringify({
  args, files: Object.fromEntries(readdirSync(from).map(name => [name, readFileSync(join(from, name)).toString('base64')]))
}));
console.log(JSON.stringify({ staged: 'ba9876543210' }));
`,
  );
  const drains: (string | null)[] = [];
  let finish!: (ok: boolean) => void;
  const ended = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let accepts = false;
  const updater = (fields: { script: string }) =>
    new EngineUpdates({
      label: 'dev.stim.test',
      port: 7787,
      build: { version: '1.40.0', stimBuild: 'aaaaaaaaaaaaaaaa' },
      node: process.execPath,
      env: { ...process.env, UPDATE_OUTPUT: output, STIM_ENGINE_ROOT: root },
      acceptsClientBuilds: () => accepts,
      runsAsService: async () => true,
      detached: (file, args) => ({ file, args: [select, ...args] }),
      drain: (reason) => drains.push(reason),
      audit: ({ phase, ok }) => {
        if (phase === 'ended' && drains.length) finish(ok);
      },
      ...fields,
    });
  const updates = updater({ script });
  try {
    const outside = updater({ script: join(home, 'stim.mjs') });
    expect(await outside.start({ id: 'a', name: 'A' }, { version: '9.0.0' })).toMatchObject({
      error: { code: 'forbidden', message: expect.stringContaining('does not run the Stim engine') },
    });
    const by = { id: 'approved-build-client', name: 'Laptop' };
    const source = join(home, 'source');
    mkdirSync(join(source, 'bin'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'stim', version: '1.42.0', files: ['bin'] }));
    writeFileSync(join(source, 'bin', 'stim.mjs'), 'console.log("1.42.0");');
    const file = (await packWorkspace(new Map([['stim', source]])))[0];
    assert(file);
    const { name, bytes, sha256 } = file;
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
    const received = JSON.parse(readFileSync(output, 'utf8'));
    expect(received.args[0]).toMatch(/[\\/]dist[\\/]engine-select\.mjs$/);
    expect(received).toEqual({
      args: [
        received.args[0],
        '--from',
        join(serviceRoot('dev.stim.test'), 'incoming', started.result.id),
        '--set-by',
        'engine.update',
      ],
      files: { [name]: bytes.toString('base64') },
    });
    expect(drains).toEqual(['stim-server is updating to packages from Laptop', null]);
    const status = await updates.status();
    expect(status.running).toBeNull();
    expect(status.last).toMatchObject({
      ok: true,
      message: 'Build ba9876543210 is staged; the engine switches once running work drains.',
    });
    expect((await updater({ script }).status()).last?.message).toBe(status.last?.message);
  } finally {
    updates.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

it('packs the transitive workspace closure with npm ranges and keeps the source manifests unchanged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-engine-pack-test-'));
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';
  const manifests = [
    { name: 'stim', version: '1.42.0', dependencies: { '@stim-cli/core': 'workspace:*', external: '^2.0.0' } },
    { name: '@stim-cli/core', version: '1.41.0', optionalDependencies: { '@stim-cli/shared': 'workspace:^' } },
    { name: '@stim-cli/shared', version: '1.40.0', peerDependencies: { stim: 'workspace:~' } },
  ];
  try {
    writeFileSync(join(home, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
    for (const manifest of manifests) {
      const dir = join(home, 'packages', manifest.name.replace('/', '-'));
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'index.mjs'), `export const name = ${JSON.stringify(manifest.name)};\n`);
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          ...manifest,
          files: ['dist'],
          devDependencies: { unused: '*' },
          scripts: { prepare: 'exit 1' },
        }),
      );
      const link = join(home, 'node_modules', manifest.name);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const workspace = workspacePackages(join(home, 'packages', 'stim'));
    assert(workspace);
    expect([...workspace.keys()]).toEqual(manifests.map(({ name }) => name));
    const expectedRanges = [
      { dependencies: { '@stim-cli/core': '1.41.0', external: '^2.0.0' } },
      { optionalDependencies: { '@stim-cli/shared': '^1.40.0' } },
      { peerDependencies: { stim: '~1.42.0' } },
    ];
    const packed = await packWorkspace(workspace);
    for (const [index, file] of packed.entries()) {
      const expected = manifests[index];
      assert(expected);
      expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(file.sha256);
      const path = join(home, file.name);
      writeFileSync(path, file.bytes);
      const manifest = JSON.parse(execFileSync(tar, ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }));
      expect(manifest).toMatchObject({ name: expected.name, ...expectedRanges[index] });
      expect(manifest.devDependencies).toBeUndefined();
      expect(manifest.scripts).toBeUndefined();
      expect(execFileSync(tar, ['-xzOf', path, 'package/dist/index.mjs'], { encoding: 'utf8' })).toContain(
        JSON.stringify(expected.name),
      );
      const sourceDir = workspace.get(manifest.name);
      assert(sourceDir);
      const source = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
      expect(source).toMatchObject(expected);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
