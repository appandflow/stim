import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { isJsonObject, LABEL_VARIABLE, stimBuildId, stimdClaimRoot } from '@stim-cli/core/state';
import { renderPlist } from '../src/service-plist.ts';
import { renderUnit } from '../src/service-unit.ts';
import { installJob, serviceStatus } from '../src/service.ts';
import { upsertProject } from '../../stim-cli/src/workspace/config.ts';
import { workspaceLogsDir } from '../../stim-cli/src/workspace/paths.ts';
import { readWorkspaceState } from '../../stim-cli/src/workspace/workspace-state.ts';

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

const parentOf = (pid: number) =>
  Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());

/**
 * A Stim home, an engine store with three builds of this checkout's `stim` dist (and its `bin/stimd` shim with `shim`), and a
 * LaunchAgent (macOS) or systemd user unit (Linux) for `label` that runs the shim. The mock runs the job as
 * `HOST <stimd of the current build>` in its own process group with `XPC_SERVICE_NAME` or `STIM_SERVICE_LABEL` set to
 * the label, so the stimd is the child of the job's process as under Stim Host, and `runJob` starts it again when it
 * exits, as KeepAlive and `Restart=always` do.
 */
function fixture(label: string, port: number, shim = false) {
  const scratch = mkdtempSync(join(tmpdir(), 'stim-service-handoff-'));
  const home = join(scratch, 'home');
  const store = join(scratch, 'engine');
  const bin = join(scratch, 'bin');
  mkdirSync(store, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const streamPids = join(scratch, 'stream-pids');
  // Stands in for `xcrun simctl spawn ... log stream`: one line, then it runs until killed.
  writeFileSync(
    join(bin, 'xcrun'),
    `#!/bin/sh\ncase "$*" in *'log show'*) exit 0;; esac\necho $$ >> '${streamPids}'\nprintf '{"eventType":"logEvent","eventMessage":"line from %s"}\\n' $$\nexec /bin/sleep 600\n`,
    { mode: 0o755 },
  );
  const streams = () => {
    try {
      return readFileSync(streamPids, 'utf8').trim().split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
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
  const last = makeBuild('last');
  let current = first;
  if (shim) mkdirSync(join(store, 'bin'));
  const point = (build: string) => {
    current = build;
    writeFileSync(join(store, 'current.json'), JSON.stringify({ format: 1, dir: build, version: build }));
    if (shim)
      writeFileSync(
        join(store, 'bin', 'stimd'),
        `#!/bin/sh\nexec "${process.execPath}" "${join(store, build, 'dist', 'cli.mjs')}" __stimd "$@"\n`,
        { mode: 0o755 },
      );
  };
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
  const jobEnv = { [process.platform === 'darwin' ? 'XPC_SERVICE_NAME' : LABEL_VARIABLE]: label };
  const stimd = (build: string) => cli(build, serviceArgs, jobEnv);
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('STIM_HOME', join(scratch, 'caller'));
  vi.stubEnv('STIM_ENGINE_ROOT', store);
  mkdirSync(join(scratch, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(scratch, '.config', 'systemd', 'user'), { recursive: true });
  const writeUnit = (unitLabel: string) => {
    const spec = {
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
    };
    if (process.platform === 'darwin')
      writeFileSync(join(scratch, 'Library', 'LaunchAgents', `${unitLabel}.plist`), renderPlist(spec));
    else writeFileSync(join(scratch, '.config', 'systemd', 'user', `${unitLabel}.service`), renderUnit(spec));
  };
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

  /**
   * Starts the job on the current build, and again `restartMs` after its process exits until the job is stopped, as
   * KeepAlive and `Restart=always` with `RestartSec` do.
   */
  const keepJob = (restartMs = 0) => {
    const start = () => {
      const job = stimd(current);
      job.once('exit', () =>
        setTimeout(() => {
          if (launchd.job === job) launchd.job = start();
        }, restartMs),
      );
      return job;
    };
    launchd.start = start;
    launchd.job = start();
  };

  const runJob = async (restartMs = 0) => {
    keepJob(restartMs);
    const started = await until('the job stimd', () => record());
    await answers('the job stimd');
    return started;
  };

  /** The process the job runs now, while it runs. */
  const jobPid = () => {
    const job = launchd.job;
    return job?.pid && job.exitCode === null && job.signalCode === null ? job.pid : null;
  };

  /** Points the engine at `build` (the next one by default) and returns the stimd that holds the home after `initial`. */
  const switchEngine = async (initial: { pid: number; socket: string }, build = next) => {
    point(build);
    let polls = 0;
    return until('the successor', () => {
      const held = record();
      if (held && held.pid !== initial.pid && held.build === build) return held;
      if (polls++ % 20 === 0) {
        const nudge = connect(initial.socket);
        nudge.on('error', () => {});
        nudge.on('connect', () => nudge.destroy());
      }
      return null;
    });
  };

  /**
   * Leaves the home as an engine switch on an earlier build did, or as a command that started stimd before the unit
   * (`commandFirst`): the next build's stimd outside the job holds the home, and the unit's job waits on it. Returns that
   * stimd once the job's process has had time to find the home held and attach.
   */
  const handOver = async (commandFirst = false) => {
    point(next);
    cli(next, commandFirst ? ['__stimd', '--mode', 'on'] : [...serviceArgs, '--unit-successor', label]);
    const successor = await until('the stimd outside the job', () => record());
    if (!commandFirst) await answers('the successor');
    keepJob(shim ? 60_000 : 0);
    const waiter = await until('the job process', () => jobPid());
    if (shim) return { ...successor, waiter };
    await new Promise((done) => setTimeout(done, 8000));
    assert.equal(jobPid(), waiter, 'the job process exited instead of waiting on the successor');
    assert.equal(record()?.pid, successor.pid);
    await answers('the stimd outside the job');
    return { ...successor, waiter };
  };

  const stopHome = async () => {
    for (let round = 0; round < 3; round++) {
      const holder = readClaimSet(stimdClaimRoot(home)).live.find(({ mode }) => mode === 'exclusive');
      if (!holder || inspectProcessIdentity(holder.owner) !== 'same') return;
      try {
        process.kill(holder.owner.pid, 'SIGTERM');
      } catch {
        return;
      }
      await until('the fixture stimd to exit', () => inspectProcessIdentity(holder.owner) !== 'same', 120_000);
    }
  };

  const stopJob = async () => {
    const job = launchd.job;
    launchd.job = null;
    if (job?.pid && job.exitCode === null && job.signalCode === null) {
      const exited = once(job, 'exit');
      try {
        process.kill(-job.pid, 'SIGTERM');
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
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
    for (const pid of streams())
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
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
  const runDesktop = async (netPort = port) => {
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
        `${JSON.stringify({ kind: 'desktop' })}\n${JSON.stringify({ op: 'net.ensure', params: { port: netPort, loopbackOnly: true } })}\n`,
      );
    });
    if (netPort === port) await answers('the Desktop stimd');
    return started;
  };

  /** Sends `lines` to the stimd at `socket` as a command of `build` would, and resolves once it answers `op`. */
  const talk = (socket: string, build: string, lines: object[], op: string) =>
    new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      const client = connect(socket);
      let buffer = '';
      client.setEncoding('utf8');
      client.on('error', reject);
      client.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.includes(`"op":"${op}"`)) resolve(client);
      });
      client.write([{ kind: 'cli', build }, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(''));
    });

  return {
    home,
    label,
    talk,
    cli,
    first,
    bin,
    scratch,
    streams,
    stopJobOnly: () => stopJob(),
    restartJob: (restartMs: number) => keepJob(restartMs),
    last,
    answers,
    command: () => cli(next, ['__stimd', '--mode', 'on']),
    jobPid,
    record,
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

const unmarkedRefusal = (pid: number, home: string, port: number, label: string) =>
  `Stim daemon PID ${pid} for ${home} serves port ${port} outside the ${label} job, and it carries no service mark: Stim Desktop, \`stim serve\`, or a Stim build older than this one started it, so install cannot prove it belongs to ${label} and left the service as it was. Stop it once its work drains with \`kill ${pid}\`; that also stops what Stim Desktop or the command that started it is using, and its dev servers keep running and the next stimd takes them over. Then run the same \`stim service install\` command again.`;

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

  it('install refuses before unloading when a stimd from an older build serves the port outside the job', async () => {
    const label = 'dev.stim.handoff-bare-service';
    const port = await freePort();
    const service = fixture(label, port);
    try {
      const bare = await service.runBareService();
      expect(homeClaim(service.home)?.details.serviceUnit).toBeUndefined();
      await service.setJob(true);
      const job = launchd.job;
      await expect(
        installJob(
          { label, port, env: [], pathPrepend: [], serve: false, stimHome: service.home },
          { script: service.script, host: null, requestPermissions: false },
        ),
      ).rejects.toHaveProperty('message', unmarkedRefusal(bare.pid, service.home, port, label));
      expect(launchd.job).toBe(job);
      expect(job?.exitCode).toBeNull();
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
      await service.setJob(false);
      await expect(install()).rejects.toThrow(`did not stop and release port ${port}`);
      expect(gone(served.pid)).toBe(false);
      await service.setJob(true);
      await expect(install()).rejects.toHaveProperty('message', unmarkedRefusal(served.pid, service.home, port, label));
      expect(gone(served.pid)).toBe(false);
      await service.stopHome();
      const desktop = await service.runDesktop();
      await service.setJob(true);
      await expect(install()).rejects.toHaveProperty(
        'message',
        unmarkedRefusal(desktop.pid, service.home, port, label),
      );
      expect(gone(desktop.pid)).toBe(false);
    } finally {
      await service.cleanup();
    }
  }, 360_000);
});

describe.skipIf(process.platform === 'win32')("an engine switch under a service unit's job", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const expectServedInJob = (
    service: ReturnType<typeof fixture>,
    replaced: { pid: number },
    build: string,
    label: string,
  ) => {
    const held = service.record();
    expect(held?.build).toBe(build);
    expect(gone(replaced.pid)).toBe(true);
    const holder = homeClaim(service.home);
    expect(holder?.owner.pid).toBe(held?.pid);
    expect(holder?.details.serviceUnit).toBe(label);
    assert(held);
    expect(parentOf(held.pid)).toBe(service.jobPid());
    const events = readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8');
    expect(events).toContain('"event":"successor_job"');
    expect(events).not.toContain('"event":"successor_bound"');
  };

  it('restarts the job on the new build instead of starting a successor outside it', async () => {
    const label = 'dev.stim.handoff-job-switch';
    const port = await freePort();
    const service = fixture(label, port, true);
    try {
      mkdirSync(join(service.home, 'run'), { recursive: true });
      writeFileSync(join(service.home, 'run', 'job-restart.json'), JSON.stringify({ at: Date.now(), pid: 1, label }));
      const initial = await service.runJob();
      expect(existsSync(join(service.home, 'run', 'job-restart.json'))).toBe(false);
      const job = service.jobPid();
      const successor = await service.switchEngine(initial);
      await service.answers('the restarted job');
      expect(service.jobPid()).not.toBe(job);
      expect(successor.pid).toBe(service.record()?.pid);
      expectServedInJob(service, initial, successor.build, label);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  /** The job's process `waiter` took the home itself, without the service manager restarting it. */
  const takenBackInJob = async (service: ReturnType<typeof fixture>, outside: { pid: number }, waiter: number) => {
    const held = await until('the job to take the home back', () => {
      const holder = homeClaim(service.home);
      return holder?.details.serviceUnit === service.label && holder.owner.pid !== outside.pid ? holder : null;
    });
    expect(parentOf(held.owner.pid)).toBe(waiter);
    expect(service.jobPid()).toBe(waiter);
    await until('the stimd outside the job to exit', () => gone(outside.pid));
    await service.answers('the job stimd');
    const events = readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8');
    expect(events).toContain('takes this Stim home back once no command runs');
    expect(events).not.toContain('"event":"successor_bound"');
    return held.owner.pid;
  };

  it('a successor an earlier build started outside the job leaves the home to the job once idle', async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-heal', port, true);
    try {
      const outside = await service.handOver();
      expect(await takenBackInJob(service, outside, outside.waiter)).toBe(service.record()?.pid);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd a command started before the unit leaves the home to the job once idle', async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-command-first', port, true);
    try {
      const outside = await service.handOver(true);
      expect(await takenBackInJob(service, outside, outside.waiter)).toBe(service.record()?.pid);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd a command starts while the job restarts serves until idle, then the job takes the home back', async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-gap', port, true);
    try {
      const initial = await service.runJob(3000);
      void service.switchEngine(initial).catch(() => {});
      await until('the job stimd to exit', () => gone(initial.pid));
      const command = service.command();
      const exited = once(command, 'exit');
      const outside = await until('the command stimd', () => {
        const held = service.record();
        return held && held.pid !== initial.pid ? held : null;
      });
      const waiter = await until('the restarted job process', () => service.jobPid());
      expect(await takenBackInJob(service, outside, waiter)).toBe(service.record()?.pid);
      await exited;
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd whose net thread a pairing started on another port leaves the home to the job once idle', async () => {
    const port = await freePort();
    const other = await freePort();
    const service = fixture('dev.stim.handoff-job-port', port, true);
    try {
      const initial = await service.runJob(3000);
      void service.switchEngine(initial).catch(() => {});
      await until('the job stimd to exit', () => gone(initial.pid));
      const command = service.command();
      const exited = once(command, 'exit');
      const outside = await until('the command stimd', () => {
        const held = service.record();
        return held && held.pid !== initial.pid ? held : null;
      });
      (
        await service.talk(outside.socket, outside.build, [{ op: 'net.ensure', params: { port: other } }], 'net')
      ).destroy();
      await exited;
      const held = await until('the job to take the home back', () => {
        const holder = homeClaim(service.home);
        return holder?.details.serviceUnit === service.label ? holder : null;
      });
      expect(parentOf(held.owner.pid)).toBe(service.jobPid());
      await service.answers('the job stimd');
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a job waiting on a holder whose engine switches exits for the new build instead of taking the home back', async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-rebuild', port, true);
    try {
      const initial = await service.runJob();
      const holder = await service.switchEngine(initial);
      expect(parentOf(holder.pid)).toBe(service.jobPid());
      await service.stopJobOnly();
      await until('the job stimd to exit', () => gone(holder.pid));
      service.command();
      const outside = await until('the command stimd', () => service.record());
      const op = await service.talk(outside.socket, outside.build, [{ op: 'op.begin', command: 'test' }], 'op.begun');
      op.write(`${JSON.stringify({ op: 'op.wait' })}\n`);
      service.restartJob(2000);
      await service.answers('the job asks the command stimd for its net thread');
      const waiter = service.jobPid();
      const retakes: number[] = [];
      const watch = setInterval(() => {
        const held = service.record();
        if (held && held.pid !== outside.pid && held.build === outside.build) retakes.push(held.pid);
      }, 25);
      try {
        const after = await service.switchEngine(outside, service.last);
        expect(retakes).toEqual([]);
        expect(gone(outside.pid)).toBe(true);
        expect(parentOf(after.pid)).toBe(service.jobPid());
        expect(service.jobPid()).not.toBe(waiter);
      } finally {
        clearInterval(watch);
      }
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stim serve the user runs keeps the home while the job waits on it', async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-serve', port, true);
    try {
      const serve = await service.runServe();
      service.restartJob(60_000);
      const waiter = await until('the job process', () => service.jobPid());
      await new Promise((done) => setTimeout(done, 8000));
      expect(service.record()?.pid).toBe(serve.pid);
      expect(service.jobPid()).toBe(waiter);
      expect(readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8')).not.toContain(
        'takes this Stim home back',
      );
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it("the job resumes the device log streams of the command's stimd it takes the home back from", async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-logs', port, true);
    try {
      const app = join(service.scratch, 'app');
      mkdirSync(app);
      vi.stubEnv('STIM_HOME', service.home);
      upsertProject(app, {});
      service.cli(service.first, ['__stimd', '--mode', 'on']);
      const holder = await until('the command stimd', () => service.record());
      const op = await service.talk(
        holder.socket,
        holder.build,
        [
          {
            op: 'op.begin',
            params: {
              workspace: app,
              forwarded: { cwd: app, env: { PATH: service.bin, HOME: service.scratch, STIM_HOME: service.home } },
            },
          },
        ],
        'op.begun',
      );
      const started = await new Promise<Record<string, unknown>>((resolve) => {
        let buffer = '';
        op.on('data', (chunk: string) => {
          buffer += chunk;
          const line = buffer.split('\n').find((entry) => entry.includes('"logs.'));
          if (line) resolve(JSON.parse(line));
        });
        op.write(
          `${JSON.stringify({ op: 'logs.start', params: { root: app, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' } })}\n`,
        );
      });
      expect(started).toMatchObject({ op: 'logs.started' });
      const [first] = await until('the device log stream', () =>
        service.streams().length > 0 ? service.streams() : null,
      );
      op.destroy();
      service.restartJob(60_000);
      const waiter = await until('the job process', () => service.jobPid());
      const deviceLog = () => {
        try {
          return readFileSync(join(workspaceLogsDir(app), 'device.ndjson'), 'utf8');
        } catch {
          return '';
        }
      };
      await until('a resumed stream writing the workspace log', () =>
        service.streams().some((pid) => pid !== first && deviceLog().includes(`line from ${pid}`)),
      );
      expect(gone(holder.pid)).toBe(true);
      expect(parentOf(service.record()?.pid ?? 0)).toBe(waiter);
      expect(readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8')).toContain(
        `resumed device log stream ${String(started.streamId)}`,
      );
      expect(readWorkspaceState(app)?.collectors?.ios).toMatchObject({ kind: 'stream', streamId: started.streamId });
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd a foreground stim serve listens through keeps the home while the job asks for other options', async () => {
    const port = await freePort();
    const other = await freePort();
    const service = fixture('dev.stim.handoff-job-foreground', port, true);
    try {
      service.cli(service.first, ['__stimd', '--mode', 'on']);
      const holder = await until('the command stimd', () => service.record());
      const serve = service.cli(service.first, ['serve', '--loopback-only', '--port', String(other)]);
      for (const deadline = Date.now() + 60_000; ;) {
        const listening = await fetch(`http://127.0.0.1:${other}/health`, { signal: AbortSignal.timeout(2000) }).then(
          (response) => response.ok,
          () => false,
        );
        if (listening) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for stim serve to listen');
        await new Promise((done) => setTimeout(done, 100));
      }
      service.restartJob(60_000);
      await until('the job process', () => service.jobPid());
      await new Promise((done) => setTimeout(done, 8000));
      expect(service.record()?.pid).toBe(holder.pid);
      expect(serve.exitCode).toBeNull();
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd whose net thread Stim Desktop started on other options keeps the home, also after an engine switch', async () => {
    const port = await freePort();
    const service = fixture('dev.stim.handoff-job-desktop', port, true);
    try {
      const desktop = await service.runDesktop(await freePort());
      const successor = await service.switchEngine(desktop);
      service.restartJob(60_000);
      await until('the job process', () => service.jobPid());
      await new Promise((done) => setTimeout(done, 8000));
      expect(service.record()?.pid).toBe(successor.pid);
      expect(readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8')).not.toContain(
        'takes this Stim home back',
      );
    } finally {
      await service.cleanup();
    }
  }, 240_000);
});
