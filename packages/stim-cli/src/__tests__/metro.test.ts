import { setExecutor, resetExecutor } from '../exec.ts';
import { isMetroRunning } from '../ports.ts';
import {
  parseLsofPids,
  parseNetstatPids,
  listeningPids,
  parseLsofCwd,
  isInsideProject,
  processCwd,
  resolveProjectMetro,
  killMetroTree,
  NOT_OURS_FOREIGN_CWD,
  NOT_OURS_UNRESPONSIVE,
} from '../metro.ts';
import { captureProcessToken } from '../process-identity.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { spawn as realSpawn } from 'node:child_process';
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CAN_READ_CWD = processCwd(process.pid) !== null;
import { join, resolve as absolute } from 'node:path';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-metro-home-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('parseLsofPids parses newline separated pids and ignores junk', () => {
  expect(parseLsofPids('59914\n59806\n')).toEqual([59914, 59806]);
  expect(parseLsofPids('')).toEqual([]);
  expect(parseLsofPids(null)).toEqual([]);
  expect(parseLsofPids('not-a-pid\n42')).toEqual([42]);
});

test('parseLsofCwd extracts the cwd path from -Fn field output', () => {
  const out = 'p59914\nfcwd\nn/Volumes/SSD/Developer/member-app\n';
  expect(parseLsofCwd(out)).toBe('/Volumes/SSD/Developer/member-app');
  expect(parseLsofCwd('')).toBe(null);
  expect(parseLsofCwd('p59914\nfcwd\n')).toBe(null);
});

test('isInsideProject accepts the root and descendants, rejects siblings', () => {
  const project = absolute('/a/b');
  expect(isInsideProject(project, project)).toBe(true);
  expect(isInsideProject(absolute('/a/b/apps/x'), project)).toBe(true);
  expect(isInsideProject(absolute('/a/bc'), project)).toBe(false);
  expect(isInsideProject(absolute('/a'), project)).toBe(false);
  expect(isInsideProject(null, project)).toBe(false);
});

test('resolveProjectMetro returns missing when nothing listens', async () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  expect(r.missing).toBe(true);
  resetExecutor();
});

test('resolveProjectMetro refuses a listener that does not answer /status', async () => {
  setExecutor({ run: () => '', runQuiet: () => '4242', spawn: () => {} });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => false });
  expect(r.notOurs).toMatch(/does not answer/);
  expect(r.metro).toBe(undefined);
  expect(r.kind).toBe(NOT_OURS_UNRESPONSIVE);
  resetExecutor();
});

test('resolveProjectMetro refuses a Metro running from another directory', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      if (cmd.includes('-sTCP:LISTEN')) return '4242';
      if (cmd.includes('-d cwd')) return 'p4242\nfcwd\nn/somewhere/else\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  expect(r.notOurs).toMatch(/outside/);
  expect(r.kind).toBe(NOT_OURS_FOREIGN_CWD);
  resetExecutor();
});

test('resolveProjectMetro identifies a workspace Metro without claiming ownership', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      if (cmd.includes('-sTCP:LISTEN')) return '59914';
      if (cmd.includes('-d cwd')) return 'p59914\nfcwd\nn/a/b\n';
      return '';
    },
    spawn: () => {},
  });
  const r = await resolveProjectMetro(8082, '/a/b', { probe: async () => true });
  expect(r.metro!.pid).toBe(59914);
  expect(r.metro!.leader).toBe(59914);
  expect(r.metro!.processToken).toBeUndefined();
  resetExecutor();
});

test('parseNetstatPids takes the listening row for the port and ignores the rest', () => {
  const out = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:8082           0.0.0.0:0              LISTENING       2212',
    '  TCP    [::]:8082              [::]:0                 LISTENING       2212',
    '  TCP    127.0.0.1:8082         127.0.0.1:51001        ESTABLISHED     3300',
    '  TCP    0.0.0.0:8083           0.0.0.0:0              LISTENING       4400',
    '  UDP    0.0.0.0:8082           *:*                                    5500',
  ].join('\r\n');
  expect(parseNetstatPids(out, 8082)).toEqual([2212]);
  expect(parseNetstatPids(out, 8083)).toEqual([4400]);
  expect(parseNetstatPids(out, 9999)).toEqual([]);
  expect(parseNetstatPids(null, 8082)).toEqual([]);
});

test('listeningPids falls back to netstat on Windows, where lsof does not exist', () => {
  const asked: string[] = [];
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      asked.push(cmd);
      if (cmd !== 'netstat -ano') return null;
      return '  TCP    0.0.0.0:8082           0.0.0.0:0              LISTENING       2212';
    },
    spawn: () => {},
  });
  expect(listeningPids(8082, 'win32')).toEqual([2212]);
  expect(asked).toEqual(['lsof -nP -iTCP:8082 -sTCP:LISTEN -t', 'netstat -ano']);
  asked.length = 0;
  expect(listeningPids(8082, 'darwin')).toEqual([]);
  expect(asked).toEqual(['lsof -nP -iTCP:8082 -sTCP:LISTEN -t']);
});

test('resolveProjectMetro accepts an unreadable-cwd listener that is this workspace recorded supervisor', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-own-')));
  const token = captureProcessToken(process.pid);
  expect(token).toBeTruthy();
  writeWorkspaceState(root, { supervisor: { pid: process.pid, port: 8082, processToken: token } });
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => (cmd.includes('-sTCP:LISTEN') ? String(process.pid) : null),
    spawn: () => {},
  });
  try {
    const r = await resolveProjectMetro(8082, root, { probe: async () => true, cwdOf: () => null });
    expect(r.metro?.pid).toBe(process.pid);
    expect(r.metro?.leader).toBe(process.pid);
    expect(r.metro?.processToken).toBe(token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProjectMetro still refuses an unreadable-cwd listener this workspace did not record', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-foreign-')));
  writeWorkspaceState(root, {
    supervisor: { pid: process.pid, port: 8082, processToken: captureProcessToken(process.pid) },
  });
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => (cmd.includes('-sTCP:LISTEN') ? '4242' : null),
    spawn: () => {},
  });
  try {
    const r = await resolveProjectMetro(8082, root, { probe: async () => true, cwdOf: () => null });
    expect(r.metro).toBe(undefined);
    expect(r.notOurs).toMatch(/working directory could not be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([undefined, 'malformed'])('killMetroTree refuses an unverified identity (%s)', (token) => {
  const signal = vi.spyOn(process, 'kill');
  expect(killMetroTree(59806, token)).toBe(false);
  expect(signal).not.toHaveBeenCalled();
  signal.mockRestore();
});

test('killMetroTree refuses to signal its own group even with a matching token', () => {
  const token = captureProcessToken(process.pid);
  expect(token).toBeTruthy();
  const signal = vi.spyOn(process, 'kill');
  expect(killMetroTree(process.pid, token!)).toBe(false);
  expect(signal).not.toHaveBeenCalled();
  signal.mockRestore();
});

test.skipIf(!CAN_READ_CWD)(
  'resolveProjectMetro reuses an external server but only kills a REAL explicitly recorded detached supervisor',
  { timeout: 30_000 },
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-')));
    const script = join(dir, 'fake-metro.js');
    writeFileSync(
      script,
      `
    const http = require('http');
    const server = http.createServer((req, res) => res.end('packager-status:running'));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port) + '\\n');
    });
  `,
    );
    const child = realSpawn(process.execPath, [script], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.unref();
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('the fake Metro never reported a port')), 10000);
      child.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk;
        const line = buffered.split('\n')[0] ?? '';
        if (buffered.includes('\n')) {
          clearTimeout(timer);
          resolve(parseInt(line, 10));
        }
      });
    });
    try {
      expect(Number.isFinite(port), 'the fake Metro must report the port it bound').toBeTruthy();
      for (let i = 0; i < 40; i++) {
        if (await isMetroRunning(port)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const ours = await resolveProjectMetro(port, dir);
      expect(ours.metro, `expected identification, got ${JSON.stringify(ours)}`).toBeTruthy();
      expect(typeof ours.metro!.pid).toBe('number');

      const foreign = await resolveProjectMetro(port, join(tmpdir(), 'some-other-project'));
      expect(foreign.notOurs, 'a process outside the project must not be claimed').toBeTruthy();

      expect(killMetroTree(ours.metro!.leader)).toBe(false);
      expect(await isMetroRunning(port)).toBe(true);
      const token = captureProcessToken(child.pid!);
      expect(token).toBeTruthy();
      writeWorkspaceState(dir, { supervisor: { pid: child.pid, port, processToken: token } });
      const owned = await resolveProjectMetro(port, dir);
      expect(owned.metro?.processToken).toBe(token);
      expect(killMetroTree(owned.metro!.leader, owned.metro!.processToken)).toBe(true);
      for (let i = 0; i < 40; i++) {
        if (!(await isMetroRunning(port))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await isMetroRunning(port)).toBe(false);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
