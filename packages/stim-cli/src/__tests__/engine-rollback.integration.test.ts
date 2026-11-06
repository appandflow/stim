import assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { takeLock } from '../engine-store/locks.ts';
import { machineCopy } from './fixtures/machine-copy.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
let tmp: string;
let home: string;
let root: string;
let work: string;
let env: NodeJS.ProcessEnv;
const versions: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const installed = (name: string) => join(tmp, name, 'lib', 'node_modules', 'stim');
const record = () => join(home, 'run', 'stimd.json');
const boundBuild = (): string | null => {
  try {
    return readJson(record()).build;
  } catch {
    return null;
  }
};
const until = async (what: string, check: () => boolean, timeoutMs = 30_000) => {
  for (const deadline = Date.now() + timeoutMs; !check();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const select = (copy: string, args: string[]) =>
  JSON.parse(
    spawnSync(process.execPath, [join(installed(copy), 'dist', 'engine-select.mjs'), ...args], {
      cwd: work,
      env,
      encoding: 'utf8',
    }).stdout,
  );
const stim = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(join(root, 'bin', 'stim'), args, { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });

/** Starts `build`'s stimd from the store and resolves with its exit code. */
function bootOnce(build: string): Promise<number | null> {
  const child = spawn(process.execPath, [join(root, build, 'dist', 'cli.mjs'), '__stimd', '--mode', 'report'], {
    env,
    stdio: 'ignore',
  });
  return new Promise((done) => child.once('exit', (code) => done(code)));
}

/** A connection with `build`'s first frame, which makes that build's stimd check the engine store. */
function poke(build: string): Promise<void> {
  return new Promise((done) => {
    const socket = connect(readJson(record()).socket);
    socket.once('data', () => (socket.destroy(), done()));
    socket.once('error', () => done());
    socket.write(`${JSON.stringify({ kind: 'cli', build })}\n`);
  });
}

async function stopStimd(): Promise<void> {
  if (!existsSync(record())) return;
  const { pid } = readJson(record());
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  await until('stimd to exit', () => !alive(pid));
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-rollback-')));
  home = join(tmp, 'home');
  root = join(tmp, 'engine');
  work = join(tmp, 'work');
  mkdirSync(work);
  env = { ...process.env, HOME: tmp, STIM_HOME: home, STIM_ENGINE_ROOT: root, STIM_DAEMON: 'on' };
  process.env.STIM_HOME = home;
  process.env.STIM_ENGINE_ROOT = root;
  machineCopy(PACKAGE, join(tmp, 'a'));
  versions.a = readJson(join(installed('a'), 'package.json')).version;
  const [major = 0, minor = 0, patch = 0] = (versions.a.split('-')[0] ?? '').split('.').map(Number);
  for (const [name, bump] of [
    ['b', 1],
    ['c', 2],
  ] as const) {
    cpSync(installed('a'), installed(name), { recursive: true, verbatimSymlinks: true });
    const manifest = readJson(join(installed(name), 'package.json'));
    versions[name] = manifest.version = `${major}.${minor}.${patch + bump}`;
    writeFileSync(join(installed(name), 'package.json'), JSON.stringify(manifest));
  }
  appendFileSync(
    join(installed('b'), 'dist', 'cli.mjs'),
    `\nif (process.argv[2] === '__stimd' && (await import('node:fs')).existsSync(process.env.STIM_HOME + '/crash'))\n  setTimeout(() => { throw new Error('crash for the rollback test'); }, 300);\n`,
  );
  appendFileSync(join(installed('c'), 'dist', 'api.mjs'), `\nglobalThis.__stimApiLoadedFrom = 'c';\n`);
  const bin = join(tmp, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho ${versions.c}\n`);
  chmodSync(join(bin, 'npm'), 0o755);
}, 120_000);

afterAll(async () => {
  await stopStimd().catch(() => {});
  if (existsSync(root)) execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_ENGINE_ROOT;
});

test.skipIf(process.platform === 'win32')(
  'three abnormal exits roll the engine back with a hold that a newer build clears, and a person pins and resumes',
  async () => {
    const install = spawnSync(process.execPath, [join(installed('a'), 'bin', 'stim.mjs'), 'engine', 'install'], {
      cwd: work,
      env,
      encoding: 'utf8',
    });
    expect(install.status).toBe(0);
    const a: string = readJson(join(root, 'current.json')).dir;
    expect(readJson(join(root, 'state.json')).installedBy).toBe('install:machine');
    const b: string = select('b', ['--explicit', '--set-by', 'test']).flipped;
    expect(b).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(home, 'crash'), '');
    for (let crash = 0; crash < 3; crash++) expect(await bootOnce(b)).toBe(1);
    const thirdExit = performance.now();
    rmSync(join(home, 'crash'));
    expect(await bootOnce(b)).toBe(0);
    await until("A's stimd to bind", () => boundBuild() === a);
    const rollbackMs = performance.now() - thirdExit;

    const held = readJson(join(root, 'current.json'));
    expect({ dir: held.dir, pinned: held.pinned, pinReason: held.pinReason, setBy: held.setBy }).toEqual({
      dir: a,
      pinned: false,
      pinReason: `crash loop in ${versions.b}`,
      setBy: 'crash-loop',
    });
    expect(readJson(join(root, 'state.json')).bad).toEqual([
      expect.objectContaining({ build: b, version: versions.b }),
    ]);
    expect(select('b', ['--set-by', 'promote:machine']).refused).toContain('marked bad');

    const c: string = select('c', ['--set-by', 'promote:machine']).staged;
    expect(c).toMatch(/^[0-9a-f]{12}$/);
    await poke(a);
    await until("C's stimd to bind", () => boundBuild() === c);
    const resumed = readJson(join(root, 'current.json'));
    expect({ dir: resumed.dir, pinned: resumed.pinned, pinReason: resumed.pinReason }).toEqual({
      dir: c,
      pinned: false,
      pinReason: null,
    });

    const api = await import(pathToFileURL(join(installed('a'), 'dist', 'api.mjs')).href);
    await api.createStim({ projectRoot: work, home }).identity();
    expect(Reflect.get(globalThis, '__stimApiLoadedFrom')).toBe('c');
    const current = join(root, 'current.json');
    const started = performance.now();
    for (let each = 0; each < 1000; each++) statSync(current, { throwIfNoEntry: false });
    const statMs = (performance.now() - started) / 1000;

    await stopStimd();
    expect(stim(['engine', 'rollback']).status).toBe(0);
    const pinned = readJson(join(root, 'current.json'));
    expect({ dir: pinned.dir, pinned: pinned.pinned, pinReason: pinned.pinReason }).toEqual({
      dir: a,
      pinned: true,
      pinReason: `rolled back from ${versions.c}`,
    });
    expect(select('c', ['--set-by', 'promote:machine']).refused).toContain('pinned');
    const update = stim(['engine', 'update'], { PATH: `${join(tmp, 'fake-bin')}:${process.env.PATH}` });
    expect(update.stderr).not.toMatch(/STIM_/);
    const updated = readJson(join(root, 'current.json'));
    expect({ dir: updated.dir, pinned: updated.pinned }).toEqual({ dir: c, pinned: false });

    console.log(
      `rollback ${rollbackMs.toFixed(0)} ms from the third abnormal exit to A's bind; current.json stat ${(statMs * 1000).toFixed(1)} us per API op`,
    );
  },
  240_000,
);

test.skipIf(process.platform === 'win32')('the engine locks bind under a long TMPDIR and stay exclusive', async () => {
  const long = join(tmp, 'x'.repeat(60), 'y'.repeat(60));
  mkdirSync(long, { recursive: true });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = long;
  try {
    const lockRoot = join(long, 'engine');
    const held = await takeLock(lockRoot, '.lock.sock');
    assert(held);
    expect(await takeLock(lockRoot, '.lock.sock')).toBeNull();
    await held.release();
    const again = await takeLock(lockRoot, '.lock.sock');
    expect(again).not.toBeNull();
    await again?.release();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});
