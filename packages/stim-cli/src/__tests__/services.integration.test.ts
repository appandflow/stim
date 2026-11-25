import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortProbe } from '../ports.ts';
import {
  resumeServices,
  serviceId,
  forgetExitedServices,
  serviceProcessPids,
  serviceRecords,
  servicesEnv,
  startServices,
  stopServices,
  teardownServices,
} from '../services.ts';
import { getProject } from '../workspace/config.ts';
import * as reverse from '../reverse-ports.ts';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { getNamedPort } from '../named-ports.ts';
import { reversePorts } from '@stim-cli/core/state';
import { testContext } from './_context.ts';

let home: string;
let root: string;
let scripts: string;
const pids = new Set<number>();

const server = `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pidFile = args.find((arg) => !/^\\d+$/.test(arg));
for (const port of args.filter((arg) => /^\\d+$/.test(arg)))
  createServer().listen(Number(port), '127.0.0.1', () => {
    if (pidFile) writeFileSync(pidFile, String(process.pid));
    console.log('listening on ' + port);
  });
`;

const db = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [action] = process.argv.slice(2);
const dir = process.cwd();
const pidFile = process.env.PIDFILE ?? 'db.pid';
const alive = () => {
  if (!existsSync(pidFile)) return false;
  try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; }
};
const stop = async () => {
  if (!alive()) { console.error('not running'); process.exit(1); }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (;;) { try { process.kill(pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }
  rmSync(pidFile);
};
if (action === 'start' && alive()) {
  process.exit(0);
} else if (action === 'start') {
  writeFileSync('data', 'rows');
  const child = spawn(process.execPath, [process.env.SERVER, process.env.DB_PORT, process.env.PIDFILE ?? dir + '/db.pid'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (;;) { if (existsSync(pidFile)) break; await new Promise((r) => setTimeout(r, 20)); }
} else if (action === 'stop') {
  await stop();
} else if (action === 'teardown') {
  if (alive()) await stop();
  rmSync('data', { force: true });
} else if (action === 'orphan') {
  await stop();
  writeFileSync(process.env.MARKER, process.env.DB_ID + ' ' + process.cwd());
} else if (action === 'fail') {
  process.exit(1);
} else if (action === 'start-then-fail') {
  if (alive()) process.exit(1);
  const child = spawn(process.execPath, [process.env.SERVER, process.env.DB_PORT, process.env.PIDFILE ?? dir + '/db.pid'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (;;) { if (existsSync(pidFile)) break; await new Promise((r) => setTimeout(r, 20)); }
  process.exit(1);
}
`;

const launcher = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(child.pid));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ctx = () => testContext({ env: { ...process.env, SERVER: join(scripts, 'server.mjs') } });

function declare(services: Record<string, unknown>) {
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ services }));
}

const run = (action: string) => [process.execPath, join(scripts, 'db.mjs'), action];

function recorded(name: string): { pid: number; port: number; env: Record<string, string> } {
  const record = serviceRecords(root)[name];
  if (!record) throw new Error(`no record for ${name}`);
  return { pid: record.process?.pid ?? 0, port: Object.values(record.ports)[0] ?? 0, env: record.env };
}

async function listens(port: number | undefined): Promise<boolean> {
  return port !== undefined && !(await createPortProbe()(port));
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-services-it-')));
  root = join(home, 'app');
  scripts = join(home, 'scripts');
  mkdirSync(root);
  mkdirSync(scripts);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(scripts, 'server.mjs'), server);
  writeFileSync(join(scripts, 'db.mjs'), db);
  writeFileSync(join(scripts, 'launcher.mjs'), launcher);
  process.env.STIM_HOME = join(home, 'stim');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  pids.clear();
  for (const file of [join(root, 'db.pid')])
    if (existsSync(file)) {
      try {
        process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
      } catch {}
    }
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe.skipIf(process.platform === 'win32')('workspace services (skipped on win32)', () => {
  test('a portless supervised service that exits during startup fails readiness', async () => {
    declare({ worker: { start: [process.execPath, '-e', 'setTimeout(() => process.exit(3), 300)'] } });
    expect(await startServices(root, undefined, { operation: ctx() })).toMatchObject([
      { name: 'worker', outcome: 'failed' },
    ]);
    expect(serviceRecords(root).worker).toMatchObject({ state: 'stopped' });
  }, 30_000);

  test('a one-line service is supervised: started with its port as an argument, idle-stopped by signal, revived, then stopped by identity once its folder is gone', async () => {
    declare({
      web: {
        ports: { web: 'WEB_PORT', admin: { env: 'ADMIN_PORT', reverse: false } },
        start: [process.execPath, join(scripts, 'server.mjs'), '{web}', '{admin}'],
      },
    });
    const devices = vi.spyOn(reverse, 'reverseOnDevices').mockResolvedValue([]);
    const operation = ctx();
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ name: 'web', outcome: 'started' }]);
    const first = recorded('web');
    pids.add(first.pid);
    const port = first.port;
    expect(await listens(port)).toBe(true);
    expect(await serviceProcessPids(root)).toContain(first.pid);
    const admin = serviceRecords(root).web?.ports.admin;
    expect(await servicesEnv(root)).toEqual({ web: { WEB_PORT: String(port), ADMIN_PORT: String(admin) } });
    expect(reversePorts(readWorkspaceState(root))).toEqual([port]);
    expect(devices).toHaveBeenLastCalledWith(root, port, 'add');
    expect(await startServices(root, 'web', { operation })).toMatchObject([{ outcome: 'running' }]);

    expect(await stopServices(root, undefined, 'idle', { operation })).toMatchObject([{ outcome: 'stopped' }]);
    expect(await listens(port)).toBe(false);
    expect(serviceRecords(root).web).toMatchObject({ state: 'stopped', stoppedBy: 'idle' });
    expect(reversePorts(readWorkspaceState(root))).toEqual([]);
    expect(devices).toHaveBeenLastCalledWith(root, port, 'remove');

    expect(await resumeServices(root, { operation })).toMatchObject([{ name: 'web', outcome: 'started' }]);
    const second = recorded('web');
    pids.add(second.pid);
    expect(second.pid).not.toBe(first.pid);
    expect(await listens(port)).toBe(true);

    rmSync(root, { recursive: true, force: true });
    expect(await teardownServices(root, { operation })).toMatchObject([{ name: 'web', outcome: 'torn-down' }]);
    expect(await listens(port)).toBe(false);
    expect(serviceRecords(root)).toEqual({});
  });

  test('a service with its own commands: stop keeps its data, revive resumes only an idle stop, removal tears it down', async () => {
    declare({
      db: {
        ports: { pg: 'DB_PORT' },
        idEnv: 'DB_ID',
        start: run('start'),
        stop: run('stop'),
        teardown: run('teardown'),
      },
    });
    const operation = ctx();
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ name: 'db', outcome: 'started' }]);
    const { port, env } = recorded('db');
    expect(env).toEqual({ DB_PORT: String(port), DB_ID: serviceId(root, 'db') });
    expect(await listens(port)).toBe(true);
    expect(await serviceProcessPids(root)).toContain(Number(readFileSync(join(root, 'db.pid'), 'utf8')));

    await stopServices(root, undefined, 'command', { operation });
    expect(await listens(port)).toBe(false);
    expect(readFileSync(join(root, 'data'), 'utf8')).toBe('rows');
    expect(await resumeServices(root, { operation })).toEqual([]);

    await startServices(root, undefined, { operation });
    await stopServices(root, undefined, 'idle', { operation });
    expect(await resumeServices(root, { operation })).toMatchObject([{ name: 'db', outcome: 'started' }]);
    expect(await listens(port)).toBe(true);

    expect(await teardownServices(root, { operation })).toMatchObject([{ name: 'db', outcome: 'torn-down' }]);
    expect(await listens(port)).toBe(false);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  test('commands read envFile at each launch while Stim variables stay private and win', async () => {
    const envFile = join(root, '.service.env');
    const marker = join(root, 'env-marker');
    const script = join(scripts, 'env.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify([process.env.SECRET, process.env.DB_PORT]));`,
    );
    writeFileSync(envFile, 'SECRET=first\nDB_PORT=1\n');
    declare({
      db: {
        envFile: '.service.env',
        ports: { pg: 'DB_PORT' },
        ready: [process.execPath, '-e', ''],
        start: [process.execPath, script, marker],
        stop: [process.execPath, script, marker],
      },
    });
    const operation = ctx();
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ outcome: 'started' }]);
    const port = String(recorded('db').port);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['first', port]);
    expect(serviceRecords(root).db?.envFile).toBe(envFile);
    expect(recorded('db').env).toEqual({ DB_PORT: port });
    expect(await servicesEnv(root)).toEqual({ db: { DB_PORT: port } });
    writeFileSync(envFile, 'SECRET=second\nDB_PORT=1\n');
    expect(await stopServices(root, undefined, 'command', { operation })).toMatchObject([{ outcome: 'stopped' }]);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['second', port]);
  });

  test('a supervised process gets its envFile variables', async () => {
    const marker = join(root, 'env-marker');
    writeFileSync(join(root, '.service.env'), 'SECRET=process\n');
    declare({
      worker: {
        envFile: '.service.env',
        start: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.SECRET); setInterval(Object, 1000)`,
        ],
      },
    });
    expect(await startServices(root, undefined, { operation: ctx() })).toMatchObject([{ outcome: 'started' }]);
    pids.add(recorded('worker').pid);
    await expect.poll(() => existsSync(marker) && readFileSync(marker, 'utf8')).toBe('process');
  }, 30_000);

  test('a missing envFile fails the start and names the file', async () => {
    declare({
      broken: { envFile: 'missing.env', start: [process.execPath, '-e', ''], stop: [process.execPath, '-e', ''] },
    });
    expect(await startServices(root, undefined, { operation: ctx() })).toMatchObject([
      { name: 'broken', outcome: 'failed', detail: expect.stringContaining(join(root, 'missing.env')) },
    ]);
  });

  test('a workspace whose folder is gone runs the orphan teardown from the home folder with the service id', async () => {
    const marker = join(home, 'orphan.txt');
    declare({
      db: {
        ports: { pg: 'DB_PORT' },
        idEnv: 'DB_ID',
        env: { MARKER: marker, PIDFILE: join(home, 'db.pid') },
        start: run('start'),
        stop: run('stop'),
        orphanTeardown: run('orphan'),
      },
    });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    pids.add(Number(readFileSync(join(home, 'db.pid'), 'utf8')));
    rmSync(root, { recursive: true, force: true });
    expect(await teardownServices(root, { operation })).toMatchObject([{ name: 'db', outcome: 'torn-down' }]);
    expect(readFileSync(marker, 'utf8')).toBe(`${serviceId(root, 'db')} ${realpathSync(homedir())}`);
  });

  test('a teardown that fails while the service still runs keeps its record and names the service and command', async () => {
    declare({ db: { ports: { pg: 'DB_PORT' }, start: run('start'), stop: run('stop'), teardown: run('fail') } });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    await expect(teardownServices(root, { operation })).rejects.toThrow(/db: teardown command .* exited with status 1/);
    expect(serviceRecords(root).db).toMatchObject({ state: 'running' });
  });

  test('a supervised process that exited after revive is not revived again, and its stop reaches its whole process group', async () => {
    const workerFile = join(home, 'worker.pid');
    declare({
      worker: {
        start: [process.execPath, join(scripts, 'launcher.mjs'), workerFile],
        ready: [
          process.execPath,
          '-e',
          `process.exit(require('fs').existsSync(${JSON.stringify(workerFile)}) ? 0 : 1)`,
        ],
      },
    });
    const operation = ctx();
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ outcome: 'started' }]);
    expect(getProject(root)).not.toBeNull();
    const { pid } = recorded('worker');
    pids.add(pid);
    const worker = Number(readFileSync(workerFile, 'utf8'));
    pids.add(worker);
    expect(await stopServices(root, undefined, 'idle', { operation })).toMatchObject([{ outcome: 'stopped' }]);
    expect(alive(worker)).toBe(false);

    rmSync(workerFile);
    await resumeServices(root, { operation });
    const again = recorded('worker').pid;
    pids.add(again);
    pids.add(Number(readFileSync(workerFile, 'utf8')));
    process.kill(-again, 'SIGKILL');
    await expect.poll(() => alive(again)).toBe(false);
    await forgetExitedServices(root, ['worker']);
    expect(serviceRecords(root).worker).toMatchObject({ state: 'stopped' });
    expect(serviceRecords(root).worker?.stoppedBy).toBeUndefined();
    expect(await resumeServices(root, { operation })).toEqual([]);
  }, 30_000);

  test('a live process that is not ready yet is waited for, not started twice, and a failed start can be retried', async () => {
    const flag = join(home, 'ready');
    writeFileSync(flag, '');
    const check = [process.execPath, '-e', `process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 0 : 1)`];
    declare({
      web: { ports: ['web'], start: [process.execPath, join(scripts, 'server.mjs'), '{web}'], ready: check },
      broken: { start: run('fail'), stop: run('stop') },
    });
    const operation = ctx();
    await startServices(root, 'web', { operation });
    const { pid } = recorded('web');
    pids.add(pid);
    rmSync(flag);
    const timer = setTimeout(() => writeFileSync(flag, ''), 1500);
    onTestFinished(() => clearTimeout(timer));
    expect(await startServices(root, 'web', { operation })).toMatchObject([{ outcome: 'running' }]);
    expect(recorded('web').pid).toBe(pid);

    expect(await startServices(root, 'broken', { operation })).toMatchObject([{ outcome: 'failed' }]);
    expect(serviceRecords(root).broken).toMatchObject({ state: 'stopped' });
    expect(await startServices(root, 'broken', { operation })).toMatchObject([{ outcome: 'failed' }]);
  });

  test('a stack that partly came up stays running for the idle pass, a later start runs start again, and a failed revive keeps the idle mark', async () => {
    declare({ db: { ports: { pg: 'DB_PORT' }, start: run('start-then-fail'), stop: run('stop') } });
    const operation = ctx();
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ outcome: 'failed' }]);
    pids.add(Number(readFileSync(join(root, 'db.pid'), 'utf8')));
    expect(serviceRecords(root).db).toMatchObject({ state: 'running' });
    expect(await stopServices(root, undefined, 'idle', { operation })).toMatchObject([{ outcome: 'stopped' }]);
    expect(await stopServices(root, undefined, 'idle', { operation })).toMatchObject([{ outcome: 'not-running' }]);

    expect(await resumeServices(root, { operation })).toMatchObject([{ outcome: 'failed' }]);
    pids.add(Number(readFileSync(join(root, 'db.pid'), 'utf8')));
    expect(serviceRecords(root).db).toMatchObject({ state: 'running', stoppedBy: 'idle' });

    declare({ db: { ports: { pg: 'DB_PORT' }, start: run('start'), stop: run('stop') } });
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ outcome: 'running' }]);
    expect(serviceRecords(root).db?.stoppedBy).toBeUndefined();
  });

  test.each<[string, () => Record<string, unknown>]>([
    [
      'a commands service, even when its ready check passes',
      () => ({ start: run('start'), stop: run('stop'), ready: [process.execPath, '-e', ''] }),
    ],
    ['a supervised process', () => ({ start: [process.execPath, join(scripts, 'server.mjs'), '{pg}'] })],
  ])('a port held by a process Stim did not start refuses the start of %s', async (_name, service) => {
    declare({ db: { ports: { pg: 'DB_PORT' }, ...service() } });
    const port = await getNamedPort(root, 'pg');
    execFileSync(process.execPath, [join(scripts, 'db.mjs'), 'start'], {
      cwd: root,
      env: { ...process.env, SERVER: join(scripts, 'server.mjs'), DB_PORT: String(port) },
    });
    pids.add(Number(readFileSync(join(root, 'db.pid'), 'utf8')));
    const [result] = await startServices(root, undefined, { operation: ctx() });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result?.detail).toMatch(/held by a process Stim did not start/);
    expect(serviceRecords(root).db).toBeUndefined();
  });

  test('a reclaim that keeps the folder stops each service once, keeps its data, and forgets it with its ports', async () => {
    declare({
      db: { ports: { pg: 'DB_PORT' }, start: run('start'), stop: run('stop'), teardown: run('teardown') },
      web: { ports: ['web'], start: [process.execPath, join(scripts, 'server.mjs'), '{web}'] },
    });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    const dbPort = recorded('db').port;
    await stopServices(root, 'web', 'command', { operation });
    const result = await reclaimProject(root, { operation });
    expect(result.keptEntry).toBe(false);
    expect(await listens(dbPort)).toBe(false);
    expect(readFileSync(join(root, 'data'), 'utf8')).toBe('rows');
    expect(serviceRecords(root)).toEqual({});
    expect(getProject(root)).toBeNull();
  });

  test('a teardown that fails keeps the record and ports until --force, and one after a stop does not stop again', async () => {
    declare({ db: { ports: { pg: 'DB_PORT' }, start: run('start'), stop: run('stop'), teardown: run('fail') } });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    const { port } = recorded('db');
    await expect(teardownServices(root, { operation })).rejects.toThrow(/run by hand in .*DB_PORT=\d+ .*db\.mjs fail/);
    expect(serviceRecords(root).db?.teardownFailure).toMatch(/exited with status 1/);
    expect(getProject(root)?.ports).toEqual({ pg: port });
    expect(await teardownServices(root, { operation, force: true })).toMatchObject([{ outcome: 'torn-down' }]);
    expect(serviceRecords(root)).toEqual({});
    expect(getProject(root)?.ports).toEqual({});
    execFileSync(process.execPath, [join(scripts, 'db.mjs'), 'stop'], { cwd: root });

    declare({ db: { ports: { pg: 'DB_PORT' }, start: run('start'), stop: run('stop') } });
    await startServices(root, undefined, { operation });
    await stopServices(root, undefined, 'command', { operation });
    expect(await teardownServices(root, { operation })).toMatchObject([{ outcome: 'torn-down' }]);
  });

  test('gc of a workspace whose folder is gone tries a failing orphan teardown once, prints what to run, and goes on', async () => {
    const marker = join(home, 'missing-dir', 'orphan.txt');
    declare({
      db: {
        ports: { pg: 'DB_PORT' },
        idEnv: 'DB_ID',
        env: { MARKER: marker, PIDFILE: join(home, 'db.pid') },
        start: run('start'),
        stop: run('stop'),
        orphanTeardown: run('orphan'),
      },
    });
    const lines: string[] = [];
    const operation = testContext({
      env: ctx().env,
      output: (_stream, text) => {
        lines.push(text);
      },
    });
    await startServices(root, undefined, { operation });
    pids.add(Number(readFileSync(join(home, 'db.pid'), 'utf8')));
    rmSync(root, { recursive: true, force: true });
    const result = await reclaimProject(root, { operation });
    expect(result.keptEntry).toBe(false);
    expect(serviceRecords(root)).toEqual({});
    expect(lines.join('')).toMatch(/service db: orphan_teardown command .* run by hand in .*DB_ID=db-/);
  });

  test("commands run later use the PATH the start recorded, not the caller's", async () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'fakedb'), `#!${process.execPath}\nimport(${JSON.stringify(join(scripts, 'db.mjs'))});\n`, {
      mode: 0o755,
    });
    declare({ db: { ports: { pg: 'DB_PORT' }, start: ['fakedb', 'start'], stop: ['fakedb', 'stop'] } });
    const PATH = `${bin}:${process.env.PATH}`;
    await startServices(root, undefined, { operation: testContext({ env: { ...ctx().env, PATH } }) });
    const { port } = recorded('db');
    expect(await listens(port)).toBe(true);
    const daemon = testContext({ env: { ...process.env, PATH: '/usr/bin:/bin' } });
    expect(await stopServices(root, undefined, 'idle', { operation: daemon })).toMatchObject([{ outcome: 'stopped' }]);
    expect(await listens(port)).toBe(false);
  });

  test('a service started while a reclaim runs keeps the workspace instead of losing its record', async () => {
    declare({ web: { ports: ['web'], start: [process.execPath, join(scripts, 'server.mjs'), '{web}'] } });
    const operation = ctx();
    const result = await reclaimProject(root, {
      operation,
      teardownBrowser: async () => {
        await startServices(root, undefined, { operation });
        pids.add(recorded('web').pid);
        return { status: 'missing' };
      },
    });
    expect(result.keptEntry).toBe(true);
    expect(serviceRecords(root).web).toMatchObject({ state: 'running' });
  });

  test('a start that leaves a running service alone keeps the record it was started with', async () => {
    declare({ db: { ports: { pg: 'DB_PORT' }, env: { STACK: 'one' }, start: run('start'), stop: run('stop') } });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    pids.add(Number(readFileSync(join(root, 'db.pid'), 'utf8')));
    declare({ db: { ports: { pg: 'DB_PORT' }, env: { STACK: 'two' }, start: run('start'), stop: run('stop') } });
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ outcome: 'running' }]);
    expect(serviceRecords(root).db?.env.STACK).toBe('one');
  });

  test('revive resumes in dependency order whatever order the records were written in', async () => {
    const forever = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    const record = (dependsOn: string[]) => ({
      kind: 'process',
      cwd: root,
      env: {},
      dependsOn,
      ports: {},
      reverse: [],
      start: forever,
      state: 'stopped',
      stoppedBy: 'idle',
      at: new Date().toISOString(),
    });
    updateWorkspaceState(root, (state) => ({ ...state, services: { api: record(['db']), db: record([]) } }));
    const outcomes = await resumeServices(root, { operation: ctx() });
    for (const each of Object.values(serviceRecords(root))) if (each.process) pids.add(each.process.pid);
    expect(outcomes.map((outcome) => outcome.name)).toEqual(['db', 'api']);
  });
});
