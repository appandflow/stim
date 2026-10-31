import { setExecutor, resetExecutor } from '../exec.ts';

import { isInsideProject, resolveProjectMetro, killMetroTree, killMetroTreeAsync } from '../metro.ts';
import { captureProcessToken } from '../process-identity.ts';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

test('isInsideProject accepts the root and descendants, rejects siblings', () => {
  const project = absolute('/a/b');
  expect(isInsideProject(project, project)).toBe(true);
  expect(isInsideProject(absolute('/a/b/apps/x'), project)).toBe(true);
  expect(isInsideProject(absolute('/a/bc'), project)).toBe(false);
  expect(isInsideProject(absolute('/a'), project)).toBe(false);
  expect(isInsideProject(null, project)).toBe(false);
});

test('resolveProjectMetro identifies a workspace Metro without claiming ownership', async () => {
  setExecutor({
    run: () => '',
    runFileQuiet: (file: string, args: string[]) => {
      if (file === 'lsof' && args.includes('-sTCP:LISTEN')) return '59914';
      if (file === 'lsof' && args.join(' ').includes('-p 59914 -d cwd')) return 'p59914\nfcwd\nn/a/b\n';
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

test('killMetroTree refuses to signal its own group even with a matching token', async () => {
  const token = captureProcessToken(process.pid);
  expect(token).toBeTruthy();
  const signal = vi.spyOn(process, 'kill');
  for (const killTree of [killMetroTree, killMetroTreeAsync]) expect(await killTree(process.pid, token!)).toBe(false);
  expect(signal).not.toHaveBeenCalled();
  signal.mockRestore();
});
