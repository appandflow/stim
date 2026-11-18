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
 * A Stim home, an engine store with two builds of this checkout's `stim` dist, and a LaunchAgent for `label`. The
 * launchctl mock runs its job as `sh -c <stimd>` in its own process group, so the stimd is the child of the job's
 * process as under Stim Host.
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
  const stimd = (build: string, carried = false) =>
    spawn(
      '/bin/sh',
      [
        '-c',
        '"$@"; exit $?',
        'sh',
        process.execPath,
        join(store, build, 'dist', 'cli.mjs'),
        '__stimd',
        '--mode',
        'on',
        ...(carried ? ['--carried'] : []),
        '--service',
        '--loopback-only',
        '--port',
        String(port),
      ],
      { env, stdio: 'ignore', detached: true },
    );
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('STIM_HOME', join(scratch, 'caller'));
  vi.stubEnv('STIM_ENGINE_ROOT', store);
  mkdirSync(join(scratch, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(
    join(scratch, 'Library', 'LaunchAgents', `${label}.plist`),
    renderPlist({
      label,
      host: null,
      node: process.execPath,
      script: join(store, 'bin', 'stimd'),
      port,
      env: [],
      pathPrepend: [],
      environment: { STIM_HOME: home },
      logPath: join(scratch, 'service.log'),
      workingDirectory: scratch,
      serve: null,
    }),
  );
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

  /**
   * Runs the unit's job on the first build, points the engine at the next one, and returns the successor once the job's
   * stimd handed the home to it and the restarted job waits on it.
   */
  const handOver = async () => {
    const initial = await runJob();
    point(next);
    let polls = 0;
    const successor = await until('the successor', () => {
      const current = record();
      if (current && current.pid !== initial.pid && current.build === next) return current;
      if (polls++ % 20 === 0) {
        const nudge = connect(initial.socket);
        nudge.on('error', () => {});
        nudge.on('connect', () => nudge.destroy());
      }
      return null;
    });
    const ended = launchd.job;
    if (ended && ended.exitCode === null && ended.signalCode === null) await once(ended, 'exit');
    launchd.start = () => stimd(next);
    launchd.job = launchd.start();
    await answers('the successor');
    return successor;
  };

  const cleanup = async () => {
    const job = launchd.job;
    launchd.job = null;
    if (job?.pid && job.exitCode === null && job.signalCode === null) {
      const exited = once(job, 'exit');
      process.kill(-job.pid, 'SIGTERM');
      await exited;
    }
    for (let round = 0; round < 3; round++) {
      const holder = readClaimSet(stimdClaimRoot(home)).live.find(({ mode }) => mode === 'exclusive');
      if (!holder || inspectProcessIdentity(holder.owner) !== 'same') break;
      process.kill(holder.owner.pid, 'SIGTERM');
      await until('the fixture stimd to exit', () => inspectProcessIdentity(holder.owner) !== 'same');
    }
    rmSync(scratch, { recursive: true, force: true });
  };

  /** Starts a stimd that serves the port without being the service's, as one Desktop or a command started. */
  const runIndependent = async () => {
    stimd(first, true);
    const started = await until('the independent stimd', () => record());
    await answers('the independent stimd');
    return started;
  };

  return {
    home,
    runJob,
    runIndependent,
    handOver,
    health,
    cleanup,
    script: join(store, next, 'dist', 'cli.mjs'),
  };
}

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

  it('install leaves a stimd that is not the service, beside a job with or without a process', async () => {
    const label = 'dev.stim.handoff-independent';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      const independent = await service.runIndependent();
      const install = () =>
        installJob(
          { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
          { script: service.script, host: null, requestPermissions: false },
        );
      for (const runs of [false, true]) {
        const start = () =>
          runs
            ? spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true })
            : spawn('/usr/bin/true', [], { stdio: 'ignore', detached: true });
        launchd.start = start;
        const job = start();
        launchd.job = job;
        if (!runs) await once(job, 'exit');
        await expect(install()).rejects.toThrow(`did not stop and release port ${port}`);
        expect(gone(independent.pid)).toBe(false);
      }
    } finally {
      await service.cleanup();
    }
  }, 240_000);
});
