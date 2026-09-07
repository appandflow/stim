import { setExecutor, resetExecutor } from '../exec.ts';
import { isMetroRunning } from '../ports.ts';
import {
  parseLsofPids,
  parseLsofCwd,
  isInsideProject,
  processCwd,
  resolveProjectMetro,
  killMetroTree,
  NOT_OURS_FOREIGN_CWD,
  NOT_OURS_UNRESPONSIVE,
} from '../metro.ts';
import { captureProcessToken } from '../process-identity.ts';
import { writeWorkspaceState } from '../supervisor/state.ts';
import { spawn as realSpawn } from 'node:child_process';
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CAN_READ_CWD = processCwd(process.pid) !== null;
import { join } from 'node:path';

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
  expect(isInsideProject('/a/b', '/a/b')).toBe(true);
  expect(isInsideProject('/a/b/apps/x', '/a/b')).toBe(true);
  expect(isInsideProject('/a/bc', '/a/b')).toBe(false);
  expect(isInsideProject('/a', '/a/b')).toBe(false);
  expect(isInsideProject(null, '/a/b')).toBe(false);
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
