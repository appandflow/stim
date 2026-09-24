import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGcReport, formatGcReport, type ParkedSimReport } from '../commands/gc.ts';
import { setExecutor, resetExecutor } from '../exec.ts';
import { makeBuildLock, makeCacheDescriptor } from './_factories.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-gc-output-'));
  process.env.STIM_HOME = tmpHome;
  setExecutor({ run: () => '', runQuiet: () => null, runFileQuiet: () => null, spawn: () => null });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

test('GC renders a mixed resource report in its established order', () => {
  const parkedSims: ParkedSimReport[] = [
    {
      udid: 'PARKED-1',
      name: 'stim-parked',
      model: 'iPhone 17',
      runtime: '26.5',
      parkedAt: '2026-09-03T00:00:00Z',
      bytes: 2048,
      listed: true,
    },
  ];
  const output = formatGcReport(
    {
      deadProjects: ['/gone/app'],
      orphanedWorkspaces: [{ dir: '/h/workspaces/wt--0123456789abcdef', projectRoot: '/gone/wt', bytes: 8192 }],
      parkedSims,
      orphanedDevices: [{ kind: 'android', id: 'stim-orphan', name: 'stim-orphan', bytes: 2048 }],
      staleDeviceRecords: [{ kind: 'ios', id: 'GONE', project: '/app', owned: true }],
      buildLocks: {
        stale: [makeBuildLock({ platform: 'ios', key: 'abcdef123-debug-sim', pid: 123, projectRoot: '/builder' })],
        live: [],
      },
      easSessionSweep: {
        projectScope: '/app',
        orphaned: [{ id: 'S1', name: 'stim-remote', platform: 'ios', status: 'running', projectScope: '/app' }],
        notices: ['one session could not be verified'],
        deletionSafe: false,
      },
      skipped: [{ dir: '/Volumes/Offline/app', reason: 'volume /Volumes/Offline is not mounted' }],
      caches: [makeCacheDescriptor({ name: 'Build cache', dir: '/cache/build', bytes: 4096, source: 'registered' })],
      workspaceOutputs: {
        root: '/h/workspaces',
        workspaces: [
          {
            dir: '/h/workspaces/a--0',
            projectRoot: '/w/a',
            bytes: 8192,
            idleDays: 4,
            willClear: true,
            keptCode: null,
            keptReason: null,
          },
          {
            dir: '/h/workspaces/b--0',
            projectRoot: '/w/b',
            bytes: 4096,
            idleDays: null,
            willClear: false,
            keptCode: 'in-use',
            keptReason: 'in use: its dev server supervisor (pid 7) is running',
          },
        ],
      },
    },
    { now: Date.parse('2026-09-04T00:00:00Z') },
  ).join('\n');
  expect(output).toMatchSnapshot();
});

test('a cache-scoped report preserves its serialized shape without inspecting devices', async () => {
  const report = await collectGcReport({ cache: 'gc-output-test-no-matching-cache' });
  expect(JSON.stringify(report, null, 2)).toMatchSnapshot();
});
