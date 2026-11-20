import assert from 'node:assert/strict';
import {
  execFileSync,
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
import { isJsonObject, LABEL_VARIABLE, stimBuildId, stimdClaimRoot } from '@stim-cli/core/state';
import { renderPlist } from '../src/service-plist.ts';
import { renderUnit } from '../src/service-unit.ts';
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
  const jobStarts = join(scratch, 'job-starts');
  mkdirSync(store, { recursive: true });
  mkdirSync(bin);
  // Stand in for the service manager the stimds ask: the job of `label` is loaded and set to restart, and a start is recorded.
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh\ncase "$1 $2" in\n  "print "*/${label}) exit 0 ;;\n  "kickstart "*/${label}) echo "$2" >> '${jobStarts}'; exit 0 ;;\nesac\nexit 1\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/sh\ncase "$*" in\n  *KillMode*) echo process ;;\n  *ActiveState*) printf 'ActiveState=activating\\nSubState=auto-restart\\n' ;;\n  "--user start ${label}.service") echo "$3" >> '${jobStarts}' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
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
    keepJob();
    const waiter = await until('the job process', () => jobPid());
    await new Promise((done) => setTimeout(done, 8000));
    assert.equal(jobPid(), waiter, 'the job process exited instead of waiting on the successor');
    assert.equal(record()?.pid, successor.pid);
    await answers('the stimd outside the job');
    return successor;
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

  /** Starts an attached stimd as `stim ci` does and resolves with its first answer line. */
  const attached = async () => {
    const child = spawn(process.execPath, [join(store, first, 'dist', 'cli.mjs'), '__stimd', '--attached'], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdout.setEncoding('utf8');
    let output = '';
    for await (const chunk of child.stdout) {
      output += String(chunk);
      if (output.includes('\n')) break;
    }
    child.stdin.end();
    return JSON.parse(output.split('\n')[0] ?? '') as unknown;
  };

  return {
    home,
    last,
    jobStarts,
    attached,
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
      const initial = await service.runJob();
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

  it('a successor an earlier build started outside the job leaves the home to the job at its own switch', async () => {
    const label = 'dev.stim.handoff-job-heal';
    const port = await freePort();
    const service = fixture(label, port, true);
    try {
      const outside = await service.handOver();
      expect(parentOf(outside.pid)).not.toBe(service.jobPid());
      const successor = await service.switchEngine(outside, service.last);
      await service.answers('the restarted job');
      expectServedInJob(service, outside, successor.build, label);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd a command started before the unit leaves the home to the job at its switch', async () => {
    const label = 'dev.stim.handoff-job-command-first';
    const port = await freePort();
    const service = fixture(label, port, true);
    try {
      const outside = await service.handOver(true);
      expect(parentOf(outside.pid)).not.toBe(service.jobPid());
      const successor = await service.switchEngine(outside, service.last);
      await service.answers('the restarted job');
      expectServedInJob(service, outside, successor.build, label);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it('a stimd a command starts while the job restarts leaves the home to the job', async () => {
    const label = 'dev.stim.handoff-job-gap';
    const port = await freePort();
    const service = fixture(label, port, true);
    try {
      const initial = await service.runJob(3000);
      const switched = service.switchEngine(initial);
      await until('the job stimd to exit', () => gone(initial.pid));
      const command = service.command();
      const exited = once(command, 'exit');
      const successor = await switched;
      await service.answers('the restarted job');
      expectServedInJob(service, initial, successor.build, label);
      await exited;
      expect(homeClaim(service.home)?.owner.pid).toBe(successor.pid);
      expect(readFileSync(join(service.home, 'daemon', 'daemon.ndjson'), 'utf8')).toContain(
        '"event":"stimd_deferred_to_job"',
      );
      expect(readFileSync(service.jobStarts, 'utf8')).toContain(label);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it("an attached stimd, such as stim ci's, uses the job's stimd instead of taking the home", async () => {
    const label = 'dev.stim.handoff-job-attached';
    const port = await freePort();
    const service = fixture(label, port, true);
    try {
      const job = await service.runJob();
      expect(await service.attached()).toEqual({ op: 'attached-held' });
      expect(homeClaim(service.home)?.owner.pid).toBe(job.pid);
      expect(readFileSync(service.jobStarts, 'utf8')).toContain(label);
    } finally {
      await service.cleanup();
    }
  }, 240_000);

  it("an attached stimd on a home whose job does not start names the service's status as the remedy", async () => {
    const label = 'dev.stim.handoff-job-down';
    const port = await freePort();
    const service = fixture(label, port, true);
    try {
      mkdirSync(join(service.home, 'run'), { recursive: true });
      writeFileSync(join(service.home, 'run', 'service.json'), JSON.stringify({ label, port }));
      expect(await service.attached()).toEqual({
        op: 'attached-claim-refusal',
        refusal: {
          code: 'STIM_DAEMON_UNAVAILABLE',
          message: `The ${label} service did not start this Stim home's stimd within 5 s.`,
          remedy: 'Run stim service status.',
        },
      });
      expect(homeClaim(service.home)).toBeUndefined();
      expect(readFileSync(service.jobStarts, 'utf8')).toContain(label);
    } finally {
      await service.cleanup();
    }
  }, 240_000);
});
