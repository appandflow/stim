import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { isJsonObject, stimBuildId, stimdClaimRoot } from '@stim-cli/core/state';
import { renderPlist } from '../src/service-plist.ts';
import { installJob, serviceStatus } from '../src/service.ts';

const launchd = vi.hoisted((): { job: ChildProcess | null; start: (() => ChildProcess) | null } => ({
  job: null,
  start: null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      if (file !== 'launchctl') return actual.execFile(file, args, options, callback);
      const job = launchd.job;
      const running = job !== null && job.exitCode === null && job.signalCode === null;
      if (args[0] === 'print') {
        if (!job)
          return callback(
            Object.assign(new Error('Could not find service'), { cmd: file }),
            '',
            'Could not find service',
          );
        return callback(null, running ? `\tstate = running\n\tpid = ${job.pid}\n` : '\tstate = not running\n', '');
      }
      if (args[0] === 'bootout') {
        launchd.job = null;
        if (!running || !job.pid) return callback(null, '', '');
        job.once('exit', () => callback(null, '', ''));
        process.kill(-job.pid, 'SIGTERM');
        return;
      }
      if (args[0] === 'bootstrap' && launchd.start) {
        launchd.job = launchd.start();
        return callback(null, '', '');
      }
      return callback(Object.assign(new Error(`launchctl ${args[0]} is not mocked`), { cmd: file }), '', 'not mocked');
    },
  };
});

const repo = join(import.meta.dirname, '../../..');

async function until<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const result = check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
};

/**
 * Runs its arguments as a child and exits with it, as Stim Host does. macOS shells reset `XPC_SERVICE_NAME` to 0 in
 * the children they fork, so a shell cannot stand in for a launchd job's process.
 */
const HOST = `const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: 'ignore' });
process.on('SIGTERM', () => {});
child.on('exit', (code) => process.exit(code ?? 1));`;

/**
 * A Stim home, an engine store with two builds of this checkout's `stim` dist, and a LaunchAgent for `label`. The
 * launchctl mock runs its job as `HOST <stimd>` in its own process group with `XPC_SERVICE_NAME` set to the label, so
 * the stimd is the child of the job's process as under Stim Host.
 */
function fixture(label: string, port: number) {
  const scratch = mkdtempSync(join(tmpdir(), 'stim-service-handoff-'));
  const home = join(scratch, 'home');
  const store = join(scratch, 'engine');
  const bin = join(scratch, 'bin');
  mkdirSync(store, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const pkg = join(repo, 'packages/stim-cli');
  const makeBuild = (name: string) => {
    const dir = join(store, name);
    mkdirSync(dir);
    cpSync(join(pkg, 'dist'), join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', `handoff-${name}.mjs`), 'export {};\n');
    cpSync(join(pkg, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(pkg, 'node_modules'), join(dir, 'node_modules'), 'junction');
    const id = stimBuildId(join(dir, 'dist'));
    assert(id);
    renameSync(dir, join(store, id));
    return id;
  };
  const first = makeBuild('first');
  const next = makeBuild('next');
  const point = (build: string) =>
    writeFileSync(join(store, 'current.json'), JSON.stringify({ format: 1, dir: build, version: build }));
  point(first);
  const env = {
    HOME: scratch,
    USERPROFILE: scratch,
    STIM_HOME: home,
    STIM_ENGINE_ROOT: store,
    STIM_DAEMON: 'on',
    STIM_NO_UPDATE_CHECK: '1',
    PATH: bin,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  const cli = (build: string, args: string[], extraEnv: Record<string, string> = {}) =>
    spawn(process.execPath, ['-e', HOST, process.execPath, join(store, build, 'dist', 'cli.mjs'), ...args], {
      env: { ...env, ...extraEnv },
      stdio: 'ignore',
      detached: true,
    });
  const serviceArgs = ['__stimd', '--mode', 'on', '--service', '--loopback-only', '--port', String(port)];
  const stimd = (build: string) => cli(build, serviceArgs, { XPC_SERVICE_NAME: label });
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('STIM_HOME', join(scratch, 'caller'));
  vi.stubEnv('STIM_ENGINE_ROOT', store);
  mkdirSync(join(scratch, 'Library', 'LaunchAgents'), { recursive: true });
  const writeUnit = (unitLabel: string) =>
    writeFileSync(
      join(scratch, 'Library', 'LaunchAgents', `${unitLabel}.plist`),
      renderPlist({
        label: unitLabel,
        host: null,
        node: process.execPath,
        script: join(store, 'bin', 'stimd'),
        port,
        env: [],
        pathPrepend: [],
        environment: { STIM_HOME: home },
        logPath: join(scratch, `${unitLabel}.log`),
        workingDirectory: scratch,
        serve: null,
      }),
    );
  writeUnit(label);
  const record = () => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(home, 'run', 'stimd.json'), 'utf8'));
      return isJsonObject(parsed) &&
        typeof parsed.pid === 'number' &&
        typeof parsed.build === 'string' &&
        typeof parsed.socket === 'string'
        ? { pid: parsed.pid, build: parsed.build, socket: parsed.socket }
        : null;
    } catch {
      return null;
    }
  };
  const health = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  };
  const answers = async (what: string) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      if (await health()) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`timed out waiting for ${what} to answer on ${port}`);
  };

  const runJob = async () => {
    launchd.start = () => stimd(first);
    launchd.job = launchd.start();
    const started = await until('the job stimd', () => record());
    await answers('the job stimd');
    return started;
  };

  /** Points the engine at the next build and returns the stimd that `initial` hands the home to. */
  const switchEngine = async (initial: { pid: number; socket: string }) => {
    point(next);
    let polls = 0;
    return until('the successor', () => {
      const current = record();
      if (current && current.pid !== initial.pid && current.build === next) return current;
      if (polls++ % 20 === 0) {
        const nudge = connect(initial.socket);
        nudge.on('error', () => {});
        nudge.on('connect', () => nudge.destroy());
      }
      return null;
    });
  };

  /**
   * Runs the unit's job on the first build, points the engine at the next one, and returns the successor once the job's
   * stimd handed the home to it and the restarted job waits on it.
   */
  const handOver = async () => {
    const successor = await switchEngine(await runJob());
    const ended = launchd.job;
    if (ended && ended.exitCode === null && ended.signalCode === null) await once(ended, 'exit');
    launchd.start = () => stimd(next);
    launchd.job = launchd.start();
    await answers('the successor');
    return successor;
  };

  const stopHome = async () => {
    for (let round = 0; round < 3; round++) {
      const holder = readClaimSet(stimdClaimRoot(home)).live.find(({ mode }) => mode === 'exclusive');
      if (!holder || inspectProcessIdentity(holder.owner) !== 'same') return;
      process.kill(holder.owner.pid, 'SIGTERM');
      await until('the fixture stimd to exit', () => inspectProcessIdentity(holder.owner) !== 'same');
    }
  };

  const stopJob = async () => {
    const job = launchd.job;
    launchd.job = null;
    if (job?.pid && job.exitCode === null && job.signalCode === null) {
      const exited = once(job, 'exit');
      process.kill(-job.pid, 'SIGTERM');
      await exited;
    }
  };

  /** Replaces the job with one that runs `sleep`, or with one whose process already exited. */
  const setJob = async (runs: boolean) => {
    await stopJob();
    const start = () =>
      runs
        ? spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true })
        : spawn('/usr/bin/true', [], { stdio: 'ignore', detached: true });
    launchd.start = start;
    const job = start();
    launchd.job = job;
    if (!runs) await once(job, 'exit');
  };

  const cleanup = async () => {
    await stopJob();
    await stopHome();
    rmSync(scratch, { recursive: true, force: true });
  };

  /** Installs another unit for the same home and port and runs its stimd outside the job of `label`. */
  const runOtherUnit = async (other: string) => {
    writeUnit(other);
    cli(first, serviceArgs, { XPC_SERVICE_NAME: other });
    const started = await until('the other unit stimd', () => record());
    await answers('the other unit stimd');
    return started;
  };

  /** Starts a stimd with the arguments an older build gives its successor: `--service` alone, outside any job. */
  const runBareService = async () => {
    cli(first, serviceArgs);
    const started = await until('the bare --service stimd', () => record());
    await answers('the bare --service stimd');
    return started;
  };

  /** Runs a plain `stim serve` on the unit's port, as a person would before installing the service. */
  const runServe = async () => {
    cli(first, ['serve', '--loopback-only', '--port', String(port)]);
    const started = await until('stim serve', () => record());
    await answers('stim serve');
    return started;
  };

  /** Starts a stimd as Stim Desktop does and asks it, as Desktop asks, to serve the unit's port. */
  const runDesktop = async () => {
    cli(first, ['__stimd', '--mode', 'on']);
    const started = await until('the Desktop stimd', () => record());
    await new Promise<void>((resolve, reject) => {
      const client = connect(started.socket);
      let buffer = '';
      client.setEncoding('utf8');
      client.on('error', reject);
      client.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.includes('"op":"net"')) {
          client.destroy();
          resolve();
        }
      });
      client.write(
        `${JSON.stringify({ kind: 'desktop' })}\n${JSON.stringify({ op: 'net.ensure', params: { port, loopbackOnly: true } })}\n`,
      );
    });
    await answers('the Desktop stimd');
    return started;
  };

  return {
    home,
    runJob,
    runServe,
    runDesktop,
    runBareService,
    runOtherUnit,
    switchEngine,
    setJob,
    stopHome,
    handOver,
    health,
    cleanup,
    script: join(store, next, 'dist', 'cli.mjs'),
  };
}

const homeClaim = (home: string) => readClaimSet(stimdClaimRoot(home)).live.find(({ mode }) => mode === 'exclusive');

describe.skipIf(process.platform !== 'darwin')('a service after an engine handoff', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('status names the successor outside the job, and install stops it and starts the new job', async () => {
    const label = 'dev.stim.handoff-install';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      const successor = await service.handOver();
      expect(homeClaim(service.home)?.details.serviceUnit).toBe(label);
      expect((await serviceStatus(label)).listener).toEqual({
        pid: successor.pid,
        stimd: expect.objectContaining({ build: successor.build }),
        inJob: false,
      });

      const notes = await installJob(
        { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
        { script: service.script, host: null, requestPermissions: false },
      );
      expect(notes).toContainEqual(expect.stringContaining(`answers on 127.0.0.1:${port}`));
      expect(gone(successor.pid)).toBe(true);
      const status = await serviceStatus(label);
      expect(status.listener).toMatchObject({ inJob: true, stimd: expect.anything() });
      expect(status.listener?.pid).not.toBe(successor.pid);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('install signals a stimd that runs inside the job only through the job', async () => {
    const label = 'dev.stim.handoff-in-job';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      await service.runJob();
      expect((await serviceStatus(label)).listener).toMatchObject({ inJob: true, stimd: expect.anything() });
      await installJob(
        { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
        { script: service.script, host: null, requestPermissions: false },
      );
      const events = readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8');
      expect(events).toContain('daemon_exited');
      expect(events).not.toContain('daemon_signal_during_shutdown');
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('install leaves running a stimd that another unit label of the same home and port marked', async () => {
    const label = 'dev.stim.handoff-label-a';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      const other = await service.runOtherUnit('dev.stim.handoff-label-b');
      expect(homeClaim(service.home)?.details.serviceUnit).toBe('dev.stim.handoff-label-b');
      await service.setJob(true);
      await installJob(
        { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
        { script: service.script, host: null, requestPermissions: false },
      ).catch(() => undefined);
      expect(gone(other.pid)).toBe(false);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('install leaves running a stimd started with an older build successor arguments', async () => {
    const label = 'dev.stim.handoff-bare-service';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      const bare = await service.runBareService();
      expect(homeClaim(service.home)?.details.serviceUnit).toBeUndefined();
      await service.setJob(true);
      await installJob(
        { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
        { script: service.script, host: null, requestPermissions: false },
      ).catch(() => undefined);
      expect(gone(bare.pid)).toBe(false);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('install leaves running the successor of a plain stim serve after an engine switch', async () => {
    const label = 'dev.stim.handoff-serve-successor';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      const successor = await service.switchEngine(await service.runServe());
      const holder = homeClaim(service.home);
      expect(holder?.owner.pid).toBe(successor.pid);
      expect(holder?.details.serviceUnit).toBeUndefined();
      await service.setJob(true);
      await installJob(
        { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
        { script: service.script, host: null, requestPermissions: false },
      ).catch(() => undefined);
      expect(gone(successor.pid)).toBe(false);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('install leaves running a stim serve or a Desktop stimd that no service unit started', async () => {
    const label = 'dev.stim.handoff-independent';
    const port = await freePort();
    const service = fixture(label, port);
    const install = () =>
      installJob(
        { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
        { script: service.script, host: null, requestPermissions: false },
      );
    try {
      const served = await service.runServe();
      for (const runs of [false, true]) {
        await service.setJob(runs);
        await expect(install()).rejects.toThrow(`did not stop and release port ${port}`);
        expect(gone(served.pid)).toBe(false);
      }
      await service.stopHome();
      const desktop = await service.runDesktop();
      await service.setJob(true);
      await expect(install()).rejects.toThrow(`did not stop and release port ${port}`);
      expect(gone(desktop.pid)).toBe(false);
    } finally {
      await service.cleanup();
    }
  }, 360_000);
});
