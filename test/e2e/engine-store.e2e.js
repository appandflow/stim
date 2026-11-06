import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-engine-')));
const home = join(tmp, 'home');
const root = join(tmp, 'engine');
const env = { ...process.env, HOME: home, USERPROFILE: home, STIM_HOME: join(home, '.stim'), STIM_ENGINE_ROOT: root };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const installed = (prefix) => join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'stim');
const copies = {};

const stim = (copy, ...args) =>
  spawnSync(process.execPath, [join(copies[copy].dir, 'bin', 'stim.mjs'), ...args], {
    env,
    cwd: tmp,
    encoding: 'utf8',
  });
const status = (copy) => {
  const run = stim(copy, 'engine', 'status', '--json');
  assert.equal(run.status, 0, run.stderr);
  return { ...JSON.parse(run.stdout), stderr: run.stderr };
};

before(() => {
  const packed = execFileSync(npm, ['pack', '--pack-destination', tmp], {
    cwd: join(REPO, 'packages', 'stim-cli'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
    .trim()
    .split('\n')
    .at(-1);
  const a = join(tmp, 'a', 'npm');
  execFileSync(
    npm,
    [
      'install',
      '-g',
      '--prefix',
      a,
      join(tmp, packed),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
    ],
    {
      env: { ...process.env, npm_config_loglevel: 'error' },
      shell: process.platform === 'win32',
    },
  );
  const version = JSON.parse(readFileSync(join(installed(a), 'package.json'), 'utf8')).version;
  copies.a = { dir: installed(a), version };
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  for (const [name, bump] of [
    ['b', 1],
    ['c', 2],
  ]) {
    const dir = installed(join(tmp, name, 'npm'));
    cpSync(copies.a.dir, dir, { recursive: true, verbatimSymlinks: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    manifest.version = `${major}.${minor}.${patch + bump}`;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    appendFileSync(join(dir, 'dist', 'cli.mjs'), `\n// ${name}\n`);
    copies[name] = { dir, version: manifest.version };
  }
});

after(() => {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (!entry.isSymbolicLink())
      execFileSync(
        process.platform === 'win32' ? 'attrib' : 'chmod',
        process.platform === 'win32'
          ? ['-r', join(entry.parentPath, entry.name)]
          : ['u+w', join(entry.parentPath, entry.name)],
      );
  rmSync(tmp, { recursive: true, force: true });
});

test(
  'install, promote newer copies, collect the superseded tree and roll back to a pinned engine',
  { timeout: 300_000 },
  () => {
    const install = stim('a', 'engine', 'install');
    assert.equal(install.status, 0, install.stderr);
    const first = status('a');
    assert.equal(first.current.version, copies.a.version);
    if (process.platform !== 'win32')
      assert.equal(statSync(join(root, first.current.dir, 'dist', 'cli.mjs')).mode & 0o222, 0);

    const second = status('b');
    assert.equal(second.current.version, copies.b.version);
    assert.equal(second.previous, first.current.dir);

    const third = status('c');
    assert.equal(third.current.version, copies.c.version);
    assert.equal(third.previous, second.current.dir);
    assert.deepEqual(readdirSync(join(root, '.trash')), []);
    assert.ok(!readdirSync(root).includes(first.current.dir), 'the superseded tree is collected');

    const version = stim('a', '--version');
    assert.equal(version.stdout, `${copies.a.version}\n`);
    assert.match(version.stderr, new RegExp(`engine ${copies.c.version.replaceAll('.', '\\.')}`));

    const rollback = stim('c', 'engine', 'rollback');
    assert.equal(rollback.status, 0, rollback.stderr);
    const pinned = status('c');
    assert.equal(pinned.current.version, copies.b.version);
    assert.equal(pinned.current.pinned, true);
    assert.equal(pinned.current.pinReason, `rolled back from ${copies.c.version}`);
    assert.match(pinned.stderr, /the engine is pinned at .*run stim engine update to resume updates/);
    assert.ok(
      readFileSync(join(root, 'bin', 'stimd'), 'utf8').includes(
        `"${join(root, pinned.current.dir, 'dist', 'cli.mjs')}" __stimd "$@"`,
      ),
      'the stimd shim names the current build',
    );
  },
);
