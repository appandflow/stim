import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimMetroPort, getProject, removeProject, upsertProject } from '../config.ts';
import { clearNamedPorts, getNamedPort, portListeners } from '../named-ports.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { findReclaimablePort } from '../ports.ts';
import * as identity from '../process-identity.ts';

let home: string;
let root: string;
const free = { isFree: async () => true, log: () => {} };

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

test('skips occupied ports with diagnostics and honors Metro reservations in the band', async () => {
  upsertProject(root, { metroPort: 8900 });
  const log = vi.fn<(line: string) => void>();
  expect(await getNamedPort(root, 'web', { isFree: async (port) => port !== 8901, log })).toBe(8902);
  expect(log).toHaveBeenCalledWith('Port 8901 already in use, trying next...');
  expect(claimMetroPort(root, 8902)).toBeNull();
});

test('refuses exhaustion without allocating outside the band', async () => {
  const isFree = vi.fn<(port: number) => Promise<boolean>>(async () => false);
  await expect(getNamedPort(root, 'web', { isFree, log: () => {} })).rejects.toThrow('8900 and 8999');
  expect(isFree).toHaveBeenCalledTimes(100);
  expect(getProject(root)).toBeNull();
});

test.each(['metro', '', 'bad label', '../api', '__proto__'])(
  'rejects label %j without a registry mutation',
  async (label) => {
    await expect(getNamedPort(root, label, free)).rejects.toThrow(/label|managed/);
    expect(getProject(root)).toBeNull();
  },
);

test('object property names can be labels without inherited allocations', async () => {
  expect(await getNamedPort(root, 'constructor', free)).toBe(8900);
  expect(await getNamedPort(root, 'toString', free)).toBe(8901);
});

test('release is scoped and never inspects listeners or changes Metro', async () => {
  upsertProject(root, { metroPort: 8082, ports: { web: 8900, api: 8901 } });
  setExecutor({
    runFile: () => {
      throw new Error('must not inspect listeners');
    },
  });
  await clearNamedPorts(root, { label: 'web', log: () => {} });
  expect(getProject(root)?.ports).toEqual({ api: 8901 });
  await clearNamedPorts(root, { log: () => {} });
  expect(getProject(root)?.ports).toEqual({});
  expect(getProject(root)?.metroPort).toBe(8082);
  await expect(clearNamedPorts(root, { label: 'metro', stop: true })).rejects.toThrow('managed');
});

test('dry run prints pid and command without signalling or releasing', async () => {
  upsertProject(root, { ports: { web: 8900 } });
  vi.spyOn(identity, 'captureProcessIdentity').mockReturnValue({ ok: true, token: 'token' });
  const kill = vi.spyOn(process, 'kill');
  setExecutor({ runFile: (file) => (file === 'lsof' ? '41219\n41219' : 'node /sibling/vite') });
  const log = vi.fn<(line: string) => void>();
  await clearNamedPorts(root, { stop: true, dryRun: true, log });
  expect(kill.mock.calls.filter(([, signal]) => signal && signal !== 0)).toEqual([]);
  expect(log).toHaveBeenCalledWith('would stop web (8900): pid 41219 node /sibling/vite');
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
  setExecutor({ runFile: (file) => (file === 'lsof' ? (listening ? '41219' : '') : 'node /sibling/api') });
  const log = vi.fn<(line: string) => void>();
  await clearNamedPorts(root, { stop: true, log });
  expect(kill).toHaveBeenCalledWith(41219, 'SIGTERM');
  expect(log).toHaveBeenCalledWith('stopped web (8900): pid 41219 node /sibling/api');
  expect(getProject(root)?.ports).toEqual({});
});

test('a failed inspection keeps its allocation and still releases other labels', async () => {
  upsertProject(root, { ports: { web: 8900, api: 8901 } });
  setExecutor({
    runFile: (_file, args) => {
      if (args.includes('-iTCP:8900')) throw new Error('lsof unavailable');
      return '';
    },
  });
  await expect(clearNamedPorts(root, { stop: true, log: () => {} })).rejects.toThrow('lsof unavailable');
  expect(getProject(root)?.ports).toEqual({ web: 8900 });
});

test('lsof distinguishes no listeners from unavailable tooling', () => {
  setExecutor({
    runFile: () => {
      throw Object.assign(new Error(), { status: 1, stdout: '', stderr: '' });
    },
  });
  expect(portListeners(8900)).toEqual([]);
  setExecutor({
    runFile: () => {
      throw Object.assign(new Error('denied'), { status: 1, stderr: 'denied' });
    },
  });
  expect(() => portListeners(8900)).toThrow('denied');
});

test('Metro reclamation and registry removal retain named allocations', async () => {
  const missing = join(home, 'missing');
  upsertProject(missing, { metroPort: 8082, ports: { web: 8900 } });
  expect(await findReclaimablePort(root, async () => false)).toBeNull();
  expect(() => removeProject(missing)).toThrow('Named ports remain');
  expect(getProject(missing)?.ports).toEqual({ web: 8900 });
});
