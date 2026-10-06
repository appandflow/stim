import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installService, rollbackService } from '../src/service.ts';
import { renderPlist } from '../src/service-plist.ts';

const launchd = vi.hoisted(() => ({
  job: null as 'old' | 'new' | null,
  original: '',
  port: 7787,
  busyUntil: 0,
  stopDelay: 0,
  failNew: false,
  exitAfterHealth: false,
  startup: 'ready',
  healthUnavailable: false,
  staleHealth: false,
  bootstraps: [] as { plist: string; portBusy: boolean }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === 'launchctl') {
        if (args[0] === 'print') {
          if (!launchd.job) return callback(new Error('Could not find service'), '', 'Could not find service');
          const failed = launchd.job === 'new' && launchd.failNew;
          return callback(
            null,
            failed
              ? '\tstate = not running\n\tlast exit code = 1'
              : `\tstate = running\n\tpid = ${launchd.job === 'old' ? 2147483647 : process.pid}\n\tlast exit code = 1`,
            '',
          );
        }
        if (args[0] === 'bootout') {
          if (launchd.job === 'old') launchd.busyUntil = Date.now() + launchd.stopDelay;
          launchd.job = null;
          return callback(null, '', '');
        }
        if (args[0] === 'bootstrap') {
          const plist = readFileSync(args[2]!, 'utf8');
          launchd.bootstraps.push({ plist, portBusy: Date.now() < launchd.busyUntil });
          launchd.job = plist === launchd.original ? 'old' : 'new';
          return callback(null, '', '');
        }
      }
      if (file === 'lsof') return callback(null, '456\n', '');
      if (file === 'plutil') return callback(null, execFileSync(file, args, { encoding: 'utf8' }), '');
      return actual.execFile(file, args, options, callback as never);
    },
  };
});

vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:net')>()),
  createServer: () => {
    const server = new EventEmitter() as EventEmitter & {
      listen: (port: number, host: string, callback: () => void) => void;
      close: (callback: () => void) => void;
    };
    server.listen = (port, _host, callback) => {
      if (port === launchd.port && Date.now() < launchd.busyUntil) {
        server.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
      } else callback();
    };
    server.close = (callback) => callback();
    return server;
  },
}));

vi.mock('../src/stim-host.ts', () => ({
  installHostApp: async () => ({ app: '/tmp/Stim Host.app', executable: '/tmp/stim-host', name: 'Stim Host' }),
  requestHostPermissions: async () => {},
  hostPermissionPanes: async () => ({ screen: 'Screen Recording', control: 'Accessibility' }),
}));

describe.skipIf(process.platform !== 'darwin')('service lifecycle', () => {
  let home: string;
  let plist: string;
  let previousArgv: string[];
  const label = 'dev.stim.lifecycle';
  const install = () => installService({ label, port: launchd.port, env: [], pathPrepend: [], serve: false });
  const finish = async <T>(operation: Promise<T>): Promise<T> => {
    await vi.runAllTimersAsync();
    return operation;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    home = mkdtempSync(join(tmpdir(), 'stim-service-lifecycle-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_HOME', join(home, 'state'));
    previousArgv = process.argv;
    process.argv = [process.execPath, join(home, 'new-server.mjs')];
    writeFileSync(process.argv[1]!, '');
    plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    Object.assign(launchd, {
      job: 'old',
      port: 7787,
      busyUntil: 0,
      stopDelay: 0,
      failNew: false,
      exitAfterHealth: false,
      startup: 'ready',
      healthUnavailable: false,
      staleHealth: false,
      bootstraps: [],
    });
    launchd.original = renderPlist({
      label,
      host: '/tmp/stim-host',
      node: process.execPath,
      script: join(home, 'old-server.mjs'),
      port: launchd.port,
      env: [],
      pathPrepend: [],
      environment: { STIM_HOME: process.env.STIM_HOME! },
      logPath: join(home, 'server.log'),
      workingDirectory: home,
      serve: null,
    });
    writeFileSync(plist, launchd.original);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!launchd.job && Date.now() >= launchd.busyUntil) throw new Error('connection refused');
        if (launchd.job === 'new' && ((launchd.failNew && !launchd.staleHealth) || launchd.healthUnavailable)) {
          throw new Error('connection refused');
        }
        if (launchd.job === 'new' && launchd.exitAfterHealth) launchd.failNew = true;
        return new Response(
          JSON.stringify({
            server: 'stim-server',
            version: '1.0.0',
            startup: { state: launchd.startup, reason: 'Stim home unavailable' },
          }),
        );
      }),
    );
  });

  afterEach(() => {
    process.argv = previousArgv;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('waits for the old child listener to release the port before bootstrapping', async () => {
    launchd.stopDelay = 1000;
    expect(await finish(install())).toContain(`stim-server 1.0.0 answers on 127.0.0.1:${launchd.port}.`);
    expect(launchd.bootstraps.map((attempt) => attempt.portBusy)).toEqual([false]);
  });

  it('names the occupied port and listening pid when the old child does not stop', async () => {
    launchd.stopDelay = 60_000;
    await Promise.all([
      expect(install()).rejects.toThrow('release port 7787 (listening pid 456) within 45 s'),
      vi.runAllTimersAsync(),
    ]);
    expect(readFileSync(plist, 'utf8')).toBe(launchd.original);
    expect(launchd.bootstraps).toEqual([]);
  });

  it('fails and restores the previous service when the replacement exits immediately', async () => {
    launchd.failNew = true;
    await Promise.all([expect(install()).rejects.toThrow('is not running (last exit code 1)'), vi.runAllTimersAsync()]);
    expect(readFileSync(plist, 'utf8')).toBe(launchd.original);
    expect(launchd.bootstraps.map((attempt) => attempt.plist === launchd.original)).toEqual([false, true]);
    expect(launchd.job).toBe('old');
  });

  it('fails if the job exits while its health request completes', async () => {
    launchd.exitAfterHealth = true;
    await Promise.all([expect(install()).rejects.toThrow('is not running (last exit code 1)'), vi.runAllTimersAsync()]);
    expect(launchd.job).toBe('old');
  });

  it.each(['degraded', 'pending', 'unavailable'])('keeps the %s note while the job runs', async (state) => {
    launchd.startup = state;
    launchd.healthUnavailable = state === 'unavailable';
    const notes = (await finish(install())).join('\n');
    expect(notes).toContain(
      state === 'degraded'
        ? 'not serving clients'
        : state === 'pending'
          ? 'still reading its Stim home'
          : 'readiness is unavailable',
    );
    expect(launchd.job).toBe('new');
  });

  it('restores the current service when the rollback job exits despite matching stale health', async () => {
    const target = join(home, 'previous', 'dist', 'stim-server.mjs');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
    writeFileSync(join(dirname(target), '..', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    execFileSync('plutil', ['-replace', 'StimService.PreviousScript', '-string', target, plist]);
    launchd.original = readFileSync(plist, 'utf8');
    launchd.failNew = true;
    launchd.staleHealth = true;
    await Promise.all([
      expect(rollbackService(label, () => {})).rejects.toThrow('Switched back to stim-server 1.0.0'),
      vi.runAllTimersAsync(),
    ]);
    expect(readFileSync(plist, 'utf8')).toBe(launchd.original);
    expect(launchd.job).toBe('old');
  });
});
