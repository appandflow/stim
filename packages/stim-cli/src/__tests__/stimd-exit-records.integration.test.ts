import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { stimBuildId } from '@stim-cli/core/state';
import { machineCopy } from './fixtures/machine-copy.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(PACKAGE, 'dist', 'cli.mjs');

let dir: string;
let home: string;
let env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];

const recordPid = (): number | null => {
  try {
    return JSON.parse(readFileSync(join(home, 'run', 'stimd.json'), 'utf8')).pid;
  } catch {
    return null;
  }
};
const logged = (): { event: string; msg: string; pid?: number; level: string }[] => {
  const file = join(home, 'daemon', 'daemon.ndjson');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
};
const boots = (): { pid: number; abnormal?: true; reason?: string }[] => {
  try {
    return JSON.parse(readFileSync(join(home, 'run', 'stimd-boots.json'), 'utf8')).boots;
  } catch {
    return [];
  }
};

/** Starts a stimd of this build; `extra` env can make it throw once it runs. */
function start(extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [cli, '__stimd', '--mode', 'report'], {
    env: { ...env, ...extra },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}
const bound = (child: ChildProcess) => vi.waitFor(() => expect(recordPid()).toBe(child.pid), { timeout: 20_000 });
const exited = async (child: ChildProcess): Promise<number | null> => {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await once(child, 'exit');
  return typeof code === 'number' ? code : null;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-exit-records-')));
  home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(
    join(dir, 'throw.mjs'),
    `setTimeout(() => {
  if (process.env.STIM_TEST_THROW === 'rejection') Promise.reject(new Error('rejected for the test'));
  else throw new Error('thrown for the test');
}, 1500);\n`,
  );
  env = {
    ...process.env,
    HOME: dir,
    STIM_HOME: home,
    STIM_ENGINE_ROOT: join(dir, 'engine'),
    STIM_DAEMON: 'report',
  };
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('every stimd exit leaves a record', () => {
  test('a successor logs and counts a predecessor that was killed, and a clean exit leaves no such record', async () => {
    const first = start();
    await bound(first);
    first.kill('SIGKILL');
    await exited(first);
    const second = start();
    await bound(second);
    expect(logged().filter((entry) => entry.event === 'stimd_predecessor_lost')).toMatchObject([
      { level: 'error', pid: first.pid },
    ]);
    expect(boots().filter((boot) => boot.abnormal)).toMatchObject([{ pid: first.pid }]);
    second.kill('SIGTERM');
    expect(await exited(second)).toBe(0);
    const third = start();
    await bound(third);
    expect(logged().filter((entry) => entry.event === 'stimd_predecessor_lost')).toHaveLength(1);
  }, 60_000);

  test('SIGHUP ends a detached stimd as SIGTERM does: logged, claims released', async () => {
    const child = start();
    await bound(child);
    child.kill('SIGHUP');
    expect(await exited(child)).toBe(0);
    expect(logged().find((entry) => entry.event === 'daemon_exited')?.msg).toContain('SIGHUP');
    expect(readClaimSet(join(home, 'run', 'stimd')).live).toEqual([]);
    expect(boots().some((boot) => boot.abnormal)).toBe(false);
  }, 60_000);

  test.each(['exception', 'rejection'])(
    'an uncaught %s reaches daemon.ndjson with its stack and counts',
    async (kind) => {
      const child = start({ NODE_OPTIONS: `--import=${join(dir, 'throw.mjs')}`, STIM_TEST_THROW: kind });
      expect(await exited(child)).toBe(1);
      const entry = logged().find((line) => line.event === 'daemon_exited' && line.level === 'error');
      expect(entry?.msg).toContain(kind === 'rejection' ? 'rejected for the test' : 'thrown for the test');
      expect(entry?.msg).toContain('at ');
      expect(boots().filter((boot) => boot.abnormal)).toMatchObject([{ pid: child.pid }]);
    },
    60_000,
  );

  test('three abnormal exits with a clean exit between them hold stimd, and status shows the hold', async () => {
    const crash = { NODE_OPTIONS: `--import=${join(dir, 'throw.mjs')}` };
    expect(await exited(start(crash))).toBe(1);
    expect(await exited(start(crash))).toBe(1);
    const clean = start();
    await bound(clean);
    clean.kill('SIGTERM');
    expect(await exited(clean)).toBe(0);
    expect(await exited(start(crash))).toBe(1);

    const held = start();
    expect(await exited(held)).toBe(0);
    expect(logged().some((entry) => entry.event === 'engine_crash_hold')).toBe(true);
    expect(recordPid()).not.toBe(held.pid);

    const status = spawnSync(process.execPath, [cli, 'status', '--json'], { env, encoding: 'utf8' });
    const { daemon } = JSON.parse(status.stdout);
    expect(daemon.crashHold).toMatchObject({ count: 3 });
    expect(daemon.crashHold.remedy).toContain('no previous engine');
    expect(daemon.abnormalExits).toHaveLength(3);
  }, 120_000);

  test('a startup failure after the claim is taken counts as an abnormal boot', async () => {
    mkdirSync(join(home, 'run', 'stimd.json'), { recursive: true });
    const child = start();
    expect(await exited(child)).toBe(1);
    expect(boots().filter((boot) => boot.abnormal)).toMatchObject([{ pid: child.pid }]);
    expect(boots()[0]?.reason).toContain('cannot listen');
  }, 60_000);

  test('a handover whose successor cannot start logs successor_missing and leaves the marker a client starts a stimd for', async () => {
    const dist = join(machineCopy(PACKAGE, join(dir, 'prefix')), 'dist');
    const old = spawn(process.execPath, [join(dist, 'cli.mjs'), '__stimd', '--mode', 'report'], {
      env,
      stdio: 'ignore',
    });
    children.push(old);
    await bound(old);
    const next = `${dist}.next`;
    cpSync(dist, next, { recursive: true });
    appendFileSync(join(next, 'cli.mjs'), "\nthrow new Error('broken update');\n");
    const after = stimBuildId(next);
    expect(after).toBeTruthy();
    renameSync(dist, `${dist}.old`);
    renameSync(next, dist);
    const poke = connect(JSON.parse(readFileSync(join(home, 'run', 'stimd.json'), 'utf8')).socket);
    poke.on('error', () => {});
    poke.write(`${JSON.stringify({ kind: 'cli', build: after })}\n`);
    await vi.waitFor(() => expect(logged().map((entry) => entry.event)).toContain('successor_missing'), {
      timeout: 40_000,
    });
    poke.destroy();
    expect(await exited(old)).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'run', 'successor-missing.json'), 'utf8'))).toMatchObject({
      pid: old.pid,
      reason: expect.stringContaining('did not bind'),
    });
  }, 90_000);
});
