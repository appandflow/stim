import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimMetroPort, getProject, removeProject, upsertProject } from '../workspace/config.ts';
import { clearNamedPorts, getNamedPort, releaseBrowserPort } from '../named-ports.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { findReclaimablePort } from '../ports.ts';
import * as identity from '../process-identity.ts';
import * as listeners from '../listening-ports.ts';

let home: string;
let root: string;
const free = { isFree: async () => true };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-named-ports-')));
  root = join(home, 'project');
  mkdirSync(root);
  process.env.STIM_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test.each(['named', 'browser'])('cancelling a queued %s port release keeps its allocation', async (kind) => {
  const ports = { api: 8901, 'web-cdp': 8950 };
  upsertProject(root, { ports });
  let release = () => {};
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withWorkspaceProcessLock(
    home,
    'ports',
    async () => {
      entered();
      await gate;
    },
    { external: true },
  );
  await ready;
  const controller = new AbortController();
  const pending =
    kind === 'browser'
      ? releaseBrowserPort(root, ports['web-cdp'], controller.signal)
      : clearNamedPorts(root, { signal: controller.signal, log: () => {} });
  const outcome = pending.then(
    () => null,
    (error: unknown) => error,
  );
  try {
    controller.abort();
    release();
    await holder;
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(getProject(root)?.ports).toEqual(ports);
  } finally {
    release();
    await holder;
    await outcome;
  }
});

test('concurrent labels and workspaces get unique ports, while repeated and symlink calls reuse their allocation', async () => {
  const other = join(home, 'other');
  const alias = join(home, 'alias');
  mkdirSync(other);
  symlinkSync(root, alias);
  const ports = await Promise.all([
    getNamedPort(root, 'web', free),
    getNamedPort(root, 'web', free),
    getNamedPort(root, 'api', free),
    getNamedPort(other, 'web', free),
  ]);
  expect(ports[0]).toBe(ports[1]);
  expect(new Set(ports).size).toBe(3);
  expect(
    await getNamedPort(alias, 'web', {
      isFree: async () => {
        throw new Error('must not probe an existing allocation');
      },
    }),
  ).toBe(ports[0]);
  expect(getProject(alias)).toBeNull();
});

test('skips occupied ports and honors Metro reservations in the band', async () => {
  upsertProject(root, { metroPort: 8900 });
  const read = vi.spyOn(listeners, 'readListeningPorts').mockResolvedValue(new Set([8901]));
  expect(await getNamedPort(root, 'web')).toBe(8902);
  expect(read).toHaveBeenCalledTimes(1);
  expect(claimMetroPort(root, 8902)).toBeNull();
});

test.each(['../api', '__proto__'])('rejects label %j without a registry mutation', async (label) => {
  await expect(getNamedPort(root, label, free)).rejects.toThrow(/label|managed/);
  expect(getProject(root)).toBeNull();
});

test('object property names can be labels without inherited allocations', async () => {
  expect(await getNamedPort(root, 'constructor', free)).toBe(8900);
  expect(await getNamedPort(root, 'toString', free)).toBe(8901);
});

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:8900           0.0.0.0:0              LISTENING       41219',
  '  TCP    127.0.0.1:8900         127.0.0.1:52001        ESTABLISHED     41219',
  '  TCP    0.0.0.0:8901           0.0.0.0:0              LISTENING       7',
].join('\r\n');
const NETSTAT_IDLE = NETSTAT.split('\r\n').slice(0, 4).join('\r\n');

type Argv = { file: string; args: string[] };

function posixExecutor(listening: () => boolean, command = 'node /sibling/vite'): Argv[] {
  const calls: Argv[] = [];
  setExecutor({
    findExecutable: (name: string) => (name === 'lsof' ? '/usr/sbin/lsof' : null),
    runQuiet: () => {
      throw new Error('POSIX must not inspect listeners through the shell');
    },
    runFile: (file: string, args: string[] = [], opts: { timeoutMs?: number } = {}) => {
      calls.push({ file, args });
      if (file !== 'lsof') throw new Error(`unexpected runFile ${file}`);
      expect(opts.timeoutMs).toBe(5000);
      if (listening()) return '41219\n41219';
      throw Object.assign(new Error(), { status: 1, stdout: '', stderr: '' });
    },
    runFileQuiet: (file: string, args: string[] = []) => {
      calls.push({ file, args });
      return file === 'ps' ? command : null;
    },
  });
  return calls;
}

function win32Executor(listening: () => boolean): Argv[] {
  const calls: Argv[] = [];
  setExecutor({
    findExecutable: () => {
      throw new Error('win32 must not look for lsof');
    },
    runFile: (file: string, args: string[] = []) => {
      if (file !== 'netstat' || args.join(' ') !== '-ano') throw new Error(`unexpected win32 command ${file}`);
      calls.push({ file, args });
      return listening() ? NETSTAT : NETSTAT_IDLE;
    },
    runQuiet: (cmd: string) => {
      calls.push({ file: cmd.split(' ')[0]!, args: cmd.split(' ').slice(1) });
      if (cmd === 'netstat -ano') return listening() ? NETSTAT : '';
      return null;
    },
    runFileQuiet: (file: string, args: string[] = []) => {
      calls.push({ file, args });
      if (file === 'tasklist') return '"node.exe","41219","Console","1","84,120 K"';
      if (file === 'taskkill')
        return 'SUCCESS: The process with PID 41219 (child process of PID 8) has been terminated.';
      return null;
    },
  });
  return calls;
}

test('release is scoped and never inspects listeners or changes Metro', async () => {
  upsertProject(root, { metroPort: 8082, ports: { web: 8900, api: 8901 } });
  const refuse = () => {
    throw new Error('must not inspect listeners');
  };
  setExecutor({ run: refuse, runFile: refuse, runQuiet: refuse, runFileQuiet: refuse });
  await clearNamedPorts(root, { label: 'web', log: () => {} });
  expect(getProject(root)?.ports).toEqual({ api: 8901 });
  await clearNamedPorts(root, { log: () => {} });
  expect(getProject(root)?.ports).toEqual({});
  expect(getProject(root)?.metroPort).toBe(8082);
  await expect(clearNamedPorts(root, { label: 'metro', stop: true })).rejects.toThrow('managed');
});

test('win32 dry run reads the listener from netstat and its image from tasklist', async () => {
  upsertProject(root, { ports: { web: 8900 } });
  vi.spyOn(identity, 'captureProcessIdentity').mockReturnValue({ ok: true, token: 'token' });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const calls = win32Executor(() => true);
  const log = vi.fn<(line: string) => void>();
  await clearNamedPorts(root, { stop: true, dryRun: true, log, platform: 'win32' });
  expect(kill.mock.calls.filter(([, signal]) => signal && signal !== 0)).toEqual([]);
  expect(calls).toContainEqual({ file: 'netstat', args: ['-ano'] });
  expect(calls).toContainEqual({ file: 'tasklist', args: ['/FI', 'PID eq 41219', '/FO', 'CSV', '/NH'] });
  expect(calls.some((c) => c.file === 'ps' || c.file === 'taskkill')).toBe(false);
  expect(log).toHaveBeenCalledWith('would stop web (8900): pid 41219 node.exe');
  expect(getProject(root)?.ports).toEqual({ web: 8900 });
});

test('stops a listener outside the workspace and releases only after it is gone', async () => {
  upsertProject(root, { ports: { web: 8900 } });
  vi.spyOn(identity, 'captureProcessIdentity').mockReturnValue({ ok: true, token: 'token' });
  vi.spyOn(identity, 'inspectProcessIdentity').mockReturnValue('same');
  vi.spyOn(identity, 'waitForProcessExit').mockResolvedValue(true);
  let listening = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGTERM') listening = false;
    return true;
  });
  const calls = posixExecutor(() => listening, 'node /sibling/api');
  const log = vi.fn<(line: string) => void>();
  await clearNamedPorts(root, { stop: true, log, platform: 'darwin' });
  expect(kill).toHaveBeenCalledWith(41219, 'SIGTERM');
  expect(calls.some((c) => c.file === 'taskkill')).toBe(false);
  expect(log).toHaveBeenCalledWith('stopped web (8900): pid 41219 node /sibling/api');
  expect(getProject(root)?.ports).toEqual({});
});

test('a listener that cannot be identified keeps its allocation and still releases other labels', async () => {
  upsertProject(root, { ports: { web: 8900, api: 8901 } });
  vi.spyOn(identity, 'captureProcessIdentity').mockReturnValue({ ok: false, reason: 'EPERM (denied)' });
  setExecutor({
    findExecutable: () => '/usr/sbin/lsof',
    runFile: (_file: string, args: string[]) => {
      if (args.includes('-iTCP:8900')) return '41219';
      throw Object.assign(new Error(), { status: 1, stdout: '', stderr: '' });
    },
    runFileQuiet: () => null,
  });
  await expect(clearNamedPorts(root, { stop: true, log: () => {}, platform: 'darwin' })).rejects.toThrow(
    'Cannot identify pid 41219 on web (8900): EPERM (denied)',
  );
  expect(getProject(root)?.ports).toEqual({ web: 8900 });
});

test('Metro reclamation and registry removal retain named allocations', async () => {
  const missing = join(home, 'missing');
  upsertProject(missing, { metroPort: 8082, ports: { web: 8900 } });
  expect(await findReclaimablePort(root, async () => false)).toBeNull();
  expect(() => removeProject(missing)).toThrow('Named ports remain');
  expect(getProject(missing)?.ports).toEqual({ web: 8900 });
});
