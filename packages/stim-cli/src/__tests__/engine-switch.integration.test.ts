import assert from 'node:assert';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimdRecordFile, workspaceAgentDeviceDir } from '@stim-cli/core/state';
import { readClaimSet } from '../ownership-claim.ts';
import { acquireBuildSlot } from '../engine/build-slots.ts';
import { writeAgentDeviceBootHook } from '../engine/agent-device.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { takeLock } from '../engine-store/locks.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let tmp: string;
let home: string;
let root: string;
let work: string;
let env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const stimd = (): { pid: number; socket: string; build: string } => readJson(stimdRecordFile());
const stimdBuild = () => {
  try {
    return stimd().build;
  } catch {
    return null;
  }
};
const until = async (what: string, check: () => boolean, timeoutMs = 20_000) => {
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

/** A connection to stimd with the first frame of `build`, then `ops`; resolves with it once stimd answers them all. */
function ask(build: string, ops: string[], answers: number): Promise<{ socket: Socket; replies: string[] }> {
  return new Promise((resolve) => {
    const socket = connect(stimd().socket);
    const replies: string[] = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, end)).op);
        buffer = buffer.slice(end + 1);
        if (replies.length === answers) resolve({ socket, replies });
      }
    });
    socket.once('connect', () =>
      socket.write(
        [{ kind: 'cli', build }, ...ops.map((op) => ({ op }))].map((line) => `${JSON.stringify(line)}\n`).join(''),
      ),
    );
  });
}

async function beginTimes(build: string, runs: number): Promise<number[]> {
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    const { socket, replies } = await ask(build, ['op.begin'], 2);
    times.push(performance.now() - started);
    expect(replies).toEqual(['hello', 'op.begun']);
    socket.destroy();
  }
  return times.toSorted((a, b) => a - b);
}

const claimOf = (build: string) => readClaimSet(buildClaimRoot(root, build)).live.map((claim) => claim.details);

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-switch-')));
  home = join(tmp, 'home');
  root = join(tmp, 'engine');
  work = join(tmp, 'work');
  mkdirSync(work);
  env = { ...process.env, STIM_HOME: home, STIM_ENGINE_ROOT: root, STIM_DAEMON: 'on' };
  process.env.STIM_HOME = home;
  process.env.STIM_ENGINE_ROOT = root;
  const packed = execFileSync(npm, ['pack', '--pack-destination', tmp], { cwd: PACKAGE, encoding: 'utf8' })
    .trim()
    .split('\n')
    .at(-1);
  assert(packed);
  const installed = (name: string) => join(tmp, name, 'lib', 'node_modules', 'stim');
  execFileSync(npm, ['install', '-g', '--prefix', join(tmp, 'a'), join(tmp, packed), '--ignore-scripts'], {
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  cpSync(installed('a'), installed('b'), { recursive: true, verbatimSymlinks: true });
  const manifest = readJson(join(installed('b'), 'package.json'));
  manifest.version = `${manifest.version}-switch.1`;
  writeFileSync(join(installed('b'), 'package.json'), JSON.stringify(manifest));
  appendFileSync(join(installed('b'), 'dist', 'cli.mjs'), '\n// b\n');
}, 120_000);

afterAll(async () => {
  for (const child of children) child.kill('SIGTERM');
  if (existsSync(stimdRecordFile())) {
    const { pid } = stimd();
    if (alive(pid)) process.kill(pid, 'SIGTERM');
    await until('the last stimd to exit', () => !alive(pid)).catch(() => {});
  }
  if (existsSync(root)) execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_ENGINE_ROOT;
});

test.skipIf(process.platform === 'win32')(
  'a staged build waits for pinned work, the drained stimd flips it and is replaced, and old CLIs follow',
  async () => {
    const run = (dir: string, args: string[]) =>
      spawnSync(process.execPath, [join(dir, 'dist', 'cli.mjs'), ...args], { cwd: work, env, encoding: 'utf8' });
    const install = spawnSync(
      process.execPath,
      [join(tmp, 'a', 'lib', 'node_modules', 'stim', 'bin', 'stim.mjs'), 'engine', 'install'],
      {
        cwd: work,
        env,
        encoding: 'utf8',
      },
    );
    expect(install.stderr).not.toMatch(/STIM_/);
    expect(install.status).toBe(0);
    const a: string = readJson(join(root, 'current.json')).dir;

    children.push(spawn(join(root, 'bin', 'stimd'), ['--mode', 'report'], { env, stdio: 'ignore', detached: true }));
    await until('stimd of A', () => stimdBuild() === a);
    const first = stimd().pid;
    const before = await beginTimes(a, 40);

    const watch = spawn(process.execPath, [join(root, a, 'dist', 'cli.mjs'), 'status', '--watch'], {
      cwd: work,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(watch);
    let watchErr = '';
    watch.stderr?.on('data', (chunk) => (watchErr += String(chunk)));
    const watched = new Promise<number | null>((done) => watch.once('exit', (code) => done(code)));

    const pinned = await ask(a, ['op.begin'], 2);
    expect(claimOf(a)).toEqual([expect.objectContaining({ drained: false })]);
    const stage = spawnSync(
      process.execPath,
      [join(tmp, 'b', 'lib', 'node_modules', 'stim', 'dist', 'engine-select.mjs'), '--explicit', '--set-by', 'test'],
      { cwd: work, env, encoding: 'utf8' },
    );
    const b: string = JSON.parse(stage.stdout).staged;
    expect(b).toMatch(/^[0-9a-f]{12}$/);
    expect(readJson(join(root, 'current.json')).dir).toBe(a);

    const lines: string[] = [];
    const held = acquireBuildSlot({
      max: 8,
      engine: { root, build: a },
      intervalMs: 20,
      out: (line) => lines.push(line),
    });
    const heldOutcome = held.then(
      () => 'took a slot',
      (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`,
    );
    await until('the slot hold line', () => lines.length > 0);
    expect(lines).toEqual([
      `switching Stim to ${readJson(join(root, 'staged.json')).version}; waiting for 0 running builds`,
    ]);

    const lock = await takeLock(root, '.lock.sock');
    assert(lock);
    pinned.socket.destroy();
    await until('A to record drained', () => claimOf(a)[0]?.drained === true);
    expect(readJson(join(root, 'current.json')).dir).toBe(a);

    await lock.release();
    const released = performance.now();
    (await ask(a, [], 1)).socket.destroy();
    await until('the successor stimd of B to bind', () => stimdBuild() === b);
    const switchMs = performance.now() - released;
    await until('A to exit', () => !alive(first));

    const current = readJson(join(root, 'current.json'));
    expect({ dir: current.dir, setBy: current.setBy }).toEqual({ dir: b, setBy: 'test' });
    expect(readFileSync(join(root, 'previous'), 'utf8').trim()).toBe(a);
    expect(existsSync(join(root, 'staged.json'))).toBe(false);
    expect(readdirSync(join(root, 'claims'))).toEqual([b]);
    expect(await heldOutcome).toBe(`STIM_ENGINE_SWITCHED: Stim updated to ${current.version}; rerun`);
    expect(await watched).toBe(75);
    expect(watchErr).toContain(`Stim updated to ${current.version}; rerun`);

    const old = run(join(root, a), ['start']);
    expect(old.stderr.split(`Stim updated to ${current.version}; running this command on it`).length - 1).toBe(1);
    expect(old.stderr).toContain('STIM_NO_PROJECT');

    const after = await beginTimes(b, 40);
    writeAgentDeviceBootHook(work, { root, build: b });
    expect(readJson(join(workspaceAgentDeviceDir(work), 'boot-hook.json')).command).toEqual([
      join(root, 'bin', 'stim'),
      'revive',
      '--json',
    ]);

    const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(stimd().pid)], { encoding: 'utf8' }).trim());
    const p95 = (times: number[]) => (times[Math.floor(times.length * 0.95)] ?? NaN).toFixed(1);
    console.log(
      `switch ${switchMs.toFixed(0)} ms from drained to the successor's bind; stimd RSS after it ${rss} KiB; op.begin p95 ${p95(before)} ms on A, ${p95(after)} ms on B`,
    );
  },
  180_000,
);
