import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortProbe } from '../ports.ts';
import {
  resumeServices,
  serviceId,
  serviceProcessPids,
  serviceRecords,
  servicesEnv,
  startServices,
  stopServices,
  teardownServices,
} from '../services.ts';
import { testContext } from './_context.ts';

let home: string;
let root: string;
let scripts: string;
const pids = new Set<number>();

const server = `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
const [port, pidFile] = process.argv.slice(2);
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
const stop = async () => {
  if (!existsSync('db.pid')) return;
  const pid = Number(readFileSync('db.pid', 'utf8'));
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (;;) { try { process.kill(pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 20)); }
  rmSync('db.pid');
};
if (action === 'start') {
  writeFileSync('data', 'rows');
  const child = spawn(process.execPath, [process.env.SERVER, process.env.DB_PORT, dir + '/db.pid'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (;;) { if (existsSync('db.pid')) break; await new Promise((r) => setTimeout(r, 20)); }
} else if (action === 'stop') {
  await stop();
} else if (action === 'teardown') {
  await stop();
  rmSync('data', { force: true });
} else if (action === 'orphan') {
  writeFileSync(process.env.MARKER, process.env.DB_ID + ' ' + process.cwd());
} else if (action === 'fail') {
  process.exit(1);
}
`;

const ctx = () => testContext({ env: { ...process.env, SERVER: join(scripts, 'server.mjs') } });

function declare(services: Record<string, unknown>) {
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ services }));
}

function recorded(name: string): { pid: number; port: number; env: Record<string, string> } {
  const record = serviceRecords(root)[name];
  const port = Object.values(record?.ports ?? {})[0];
  if (!record || port === undefined) throw new Error(`no record for ${name}`);
  return { pid: record.process?.pid ?? 0, port, env: record.env };
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
  process.env.STIM_HOME = join(home, 'stim');
});

afterEach(() => {
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
  test('a one-line service is supervised: started with its port as an argument, idle-stopped by signal, revived, then stopped by identity once its folder is gone', async () => {
    declare({ web: { ports: { web: 'WEB_PORT' }, start: [process.execPath, join(scripts, 'server.mjs'), '{web}'] } });
    const operation = ctx();
    expect(await startServices(root, undefined, { operation })).toMatchObject([{ name: 'web', outcome: 'started' }]);
    const first = recorded('web');
    pids.add(first.pid);
    const port = first.port;
    expect(await listens(port)).toBe(true);
    expect(await serviceProcessPids(root)).toContain(first.pid);
    expect(await servicesEnv(root)).toEqual({ web: { WEB_PORT: String(port) } });
    expect(await startServices(root, 'web', { operation })).toMatchObject([{ outcome: 'running' }]);

    expect(await stopServices(root, undefined, 'idle', { operation })).toMatchObject([{ outcome: 'stopped' }]);
    expect(await listens(port)).toBe(false);
    expect(serviceRecords(root).web).toMatchObject({ state: 'stopped', stoppedBy: 'idle' });

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
    const run = (action: string) => [process.execPath, join(scripts, 'db.mjs'), action];
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

  test('a workspace whose folder is gone runs the orphan teardown from the home folder with the service id', async () => {
    const run = (action: string) => [process.execPath, join(scripts, 'db.mjs'), action];
    const marker = join(home, 'orphan.txt');
    declare({
      db: {
        ports: { pg: 'DB_PORT' },
        idEnv: 'DB_ID',
        env: { MARKER: marker },
        start: run('start'),
        stop: run('stop'),
        orphanTeardown: run('orphan'),
      },
    });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    pids.add(Number(readFileSync(join(root, 'db.pid'), 'utf8')));
    rmSync(root, { recursive: true, force: true });
    expect(await teardownServices(root, { operation })).toMatchObject([{ name: 'db', outcome: 'torn-down' }]);
    expect(readFileSync(marker, 'utf8')).toBe(`${serviceId(root, 'db')} ${realpathSync(homedir())}`);
  });

  test('a teardown that fails while the service still runs keeps its record and names the service and command', async () => {
    const run = (action: string) => [process.execPath, join(scripts, 'db.mjs'), action];
    declare({ db: { ports: { pg: 'DB_PORT' }, start: run('start'), stop: run('stop'), teardown: run('fail') } });
    const operation = ctx();
    await startServices(root, undefined, { operation });
    await expect(teardownServices(root, { operation })).rejects.toThrow(/db: teardown command .* exited with status 1/);
    expect(serviceRecords(root).db).toMatchObject({ state: 'running' });
  });
});
