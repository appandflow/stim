import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceRunClaims, workspaceRecordingsDir } from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { createStim } from '../api.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { register } from '../cache/cache-manifest.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';

vi.mock('../devices/machine-cache-usage.ts', () => ({ getMachineCacheReport: async () => null }));

const recordingIo = vi.hoisted((): { afterRemove?: (path: unknown) => void } => ({}));
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      const result = fs.rmSync(...args);
      recordingIo.afterRemove?.(args[0]);
      return result;
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const result = await fs.rm(...args);
      recordingIo.afterRemove?.(args[0]);
      return result;
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpHome: string;
let projects: string;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '0';
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) => (file === 'git' ? real.runFileQuiet(file, args, opts) : null),
    findExecutable: (name) => (name === 'gh' ? null : real.findExecutable(name)),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
});

afterEach(() => {
  recordingIo.afterRemove = undefined;
  vi.unstubAllEnvs();
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
  process.exitCode = 0;
});

async function gcJson(opts: Parameters<typeof runGc>[0]) {
  const stdout: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runGc({ ...opts, json: true });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? '');
}

/** Writes 1000-byte segments of one simulator's footage, each `[start, end]` in epoch milliseconds. */
function record(root: string, segments: [number, number][]): string {
  ensureWorkspaceStorage(root);
  const dir = join(workspaceRecordingsDir(root), 'ios-default');
  mkdirSync(dir, { recursive: true });
  for (const [start, end] of segments) writeFileSync(join(dir, `${start}-${end}.seg`), 'x'.repeat(1000));
  return dir;
}

function liveWorkspace(name: string, segments: [number, number][]): { root: string; dir: string } {
  const root = join(projects, name);
  mkdirSync(root);
  upsertProject(root, { metroPort: 8100, platforms: {} });
  return { root, dir: record(root, segments) };
}

const now = Date.now();

function tree(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out.push(`${path} ${stat.size}`);
    }
  };
  for (const root of roots) walk(root);
  return out.toSorted();
}

function registeredCache(): string {
  const dir = join(tmpHome, 'fixture-cache');
  mkdirSync(join(dir, 'aa', 'entry'), { recursive: true });
  writeFileSync(join(dir, 'aa', 'entry', 'blob'), 'x'.repeat(2000));
  register({ dir, name: 'Fixture cache', prune: 'entries', entriesDepth: 2 });
  return dir;
}

test('a dry run at critical changes nothing; each level deletes only its own categories', async () => {
  const live = liveWorkspace('live', [[now - 120_000, now - 60_000]]);
  const goneDir = record(join(projects, 'gone'), [[now - 60_000, now]]);
  const cache = registeredCache();
  const before = tree(tmpHome, projects);

  const dry = await gcJson({ dryRun: true, pressure: 'critical' });
  expect(dry).toMatchObject({ mode: 'dry-run', level: 'critical', failures: null, results: [] });
  const would = (dry.actions as { kind: string; target: string; outcome: string; rung: number | null }[]).filter(
    (action) => action.outcome === 'would',
  );
  expect(would).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'remove-orphan', rung: null }),
      expect.objectContaining({ kind: 'delete-recordings', rung: 8 }),
      expect.objectContaining({ kind: 'empty-cache', target: cache, rung: 3 }),
    ]),
  );
  expect(tree(tmpHome, projects)).toEqual(expect.arrayContaining(before));

  await gcJson({ pressure: 'normal' });
  expect(existsSync(goneDir)).toBe(false);
  expect(existsSync(live.dir)).toBe(true);
  expect(existsSync(join(cache, 'aa', 'entry', 'blob'))).toBe(true);

  await gcJson({ pressure: 'high' });
  expect(existsSync(live.dir)).toBe(true);
  expect(existsSync(join(cache, 'aa', 'entry', 'blob'))).toBe(true);

  const critical = await gcJson({ pressure: 'critical' });
  expect(critical.failures).toBe(0);
  expect(readdirSync(live.dir)).toEqual([]);
  expect(existsSync(join(workspaceRecordingsDir(live.root), '..', 'workspace.json'))).toBe(true);
  expect(existsSync(join(cache, 'aa', 'entry', 'blob'))).toBe(false);
});

test('cancelling the critical run while it deletes recordings keeps later footage and releases admission', async () => {
  const live = liveWorkspace('live', [
    [now - 10 * DAY_MS, now - 10 * DAY_MS + 60_000],
    [now - 9 * DAY_MS, now - 9 * DAY_MS + 60_000],
  ]);
  const open = join(live.dir, `${now}.part`);
  writeFileSync(open, 'open footage');
  const controller = new AbortController();
  const removed: string[] = [];
  recordingIo.afterRemove = (file) => {
    if (String(file).startsWith(live.dir) && String(file).endsWith('.seg')) {
      removed.push(String(file));
      controller.abort();
    }
  };
  const client = createStim({ projectRoot: live.root, home: tmpHome, env: { ...process.env } });
  await expect(client.collectGarbage({ pressure: 'critical', signal: controller.signal })).rejects.toMatchObject({
    code: 'STIM_CANCELLED',
  });
  expect(removed).toHaveLength(1);
  expect(existsSync(join(live.dir, `${now - 9 * DAY_MS}-${now - 9 * DAY_MS + 60_000}.seg`))).toBe(true);
  expect(existsSync(open)).toBe(true);
  const admission = readClaimSet(maintenanceRunClaims());
  expect(admission.live).toEqual([]);
  expect(admission.unresolved).toEqual([]);
});

test('keeps the recordings of a workspace whose project root cannot be proven gone, even at critical', async () => {
  const unmounted =
    process.platform === 'win32'
      ? `Q:\\stim-test-unmounted-${process.pid}\\app`
      : join('/Volumes', `stim-test-unmounted-${process.pid}`, 'app');
  const dir = record(unmounted, [[now - 60_000, now]]);

  const report = await gcJson({ dryRun: true });
  expect(report.sections.recordings).toEqual([]);
  expect(report.sections.skipped).toEqual([
    expect.objectContaining({ detail: expect.stringContaining('is not mounted') }),
  ]);

  await gcJson({ pressure: 'critical' });
  expect(existsSync(dir)).toBe(true);
});
