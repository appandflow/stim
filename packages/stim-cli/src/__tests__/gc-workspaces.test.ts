import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { classifyWorkspaceDirs, listWorkspaceDirs, planWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { getProject, saveConfig, upsertProject } from '../workspace/config.ts';
import { register } from '../cache/cache-manifest.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { withManagedTunnelLock } from '../engine/tunnel.ts';
import { lastUseFrom, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { exclusiveClaimDir } from '../ownership-claim.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';

let tmpHome: string;
let projects: string;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) => (file === 'git' ? real.runFileQuiet(file, args, opts) : null),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = 0;
});

function captureLog(fn: () => unknown): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => logs.join('\n'));
}

function goneWorkspace(name: string): { root: string; dir: string } {
  const root = join(projects, name);
  const dir = ensureWorkspaceStorage(root);
  writeFileSync(join(dir, 'state.json'), '{}');
  return { root, dir };
}

function holdNativeRun(root: string): void {
  plantClaim(join(workspaceDir(root), 'native-run.lock'), 'exclusive', liveClaimOwner());
}

describe('orphaned workspace classification', () => {
  const entry = (projectRoot: string | null, problem: string | null = null) => ({
    dir: `/h/workspaces/${projectRoot ?? 'x'}`,
    projectRoot,
    problem,
  });
  const classify = (
    entries: ReturnType<typeof entry>[],
    {
      registryKeys = [] as string[],
      existing = [] as string[],
      unmounted = [] as string[],
      busy = [] as string[],
    } = {},
  ) =>
    classifyWorkspaceDirs(entries, {
      registryKeys,
      exists: (path) => existing.includes(path),
      isMounted: (path) => !unmounted.includes(path),
      inUse: (root) => (busy.includes(root) ? ['a stim ios or android run holds its native-run.lock'] : []),
    });

  test('a workspace whose project root is gone and unregistered is orphaned', () => {
    expect(classify([entry('/w/gone')]).orphaned.map((o) => o.projectRoot)).toEqual(['/w/gone']);
  });

  test('a workspace whose project root still exists is not orphaned', () => {
    expect(classify([entry('/w/here')], { existing: ['/w/here'] })).toEqual({ orphaned: [], skipped: [] });
  });

  test('a project root on an unmounted volume is kept and reported', () => {
    const result = classify([entry('/Volumes/Off/app')], { unmounted: ['/Volumes/Off/app'] });
    expect(result.orphaned).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/not mounted/);
  });

  test('a missing or unreadable workspace.json is unresolved, never orphaned', () => {
    const result = classify([entry(null, 'it has no workspace.json')]);
    expect(result.orphaned).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/no workspace\.json/);
  });

  test('a registry key equal to or under the root leaves the directory to the registry sweep', () => {
    expect(classify([entry('/w/gone')], { registryKeys: ['/w/gone'] })).toEqual({ orphaned: [], skipped: [] });
    expect(classify([entry('/w/gone')], { registryKeys: ['/w/gone/apps/mobile'] })).toEqual({
      orphaned: [],
      skipped: [],
    });
    expect(classify([entry('/w/gone')], { registryKeys: ['/w/gone-other'] }).orphaned).toHaveLength(1);
  });

  test('a workspace in use is kept and reported with the reason', () => {
    const result = classify([entry('/w/gone')], { busy: ['/w/gone'] });
    expect(result.orphaned).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/native-run\.lock/);
  });
});

test('listWorkspaceDirs resolves each directory through its workspace.json', () => {
  const { root } = goneWorkspace('app');
  const bare = join(tmpHome, 'workspaces', 'bare--0000000000000000');
  mkdirSync(bare, { recursive: true });
  const broken = join(tmpHome, 'workspaces', 'broken--0000000000000000');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'workspace.json'), '{');
  const moved = join(tmpHome, 'workspaces', 'moved--0000000000000000');
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, 'workspace.json'), JSON.stringify({ projectRoot: root }));

  const byDir = Object.fromEntries(listWorkspaceDirs().map((e) => [e.dir, e]));
  expect(byDir[workspaceDir(root)]).toEqual({ dir: workspaceDir(root), projectRoot: root, problem: null });
  expect(byDir[bare]?.problem).toMatch(/no workspace\.json/);
  expect(byDir[broken]?.problem).toMatch(/does not parse/);
  expect(byDir[moved]?.problem).toMatch(/another name/);
});

test('gc reports an orphaned workspace directory and --delete removes only the confirmed ones', async () => {
  const orphan = goneWorkspace('deleted-worktree');
  const busy = goneWorkspace('building-worktree');
  holdNativeRun(busy.root);
  const unresolved = join(tmpHome, 'workspaces', 'bare--0000000000000000');
  mkdirSync(join(unresolved, 'derived-data'), { recursive: true });

  const report = await captureLog(() => runGc({}));
  expect(report).toContain('Orphaned workspace directories (1):');
  expect(report).toContain(orphan.dir);
  expect(report).toContain(`recorded project root ${orphan.root} is gone`);
  expect(report).toMatch(/building-worktree.*native-run\.lock/);
  expect(existsSync(orphan.dir)).toBe(true);

  const output = await captureLog(() => runGc({ delete: true }));
  expect(output).toContain(`Removed the orphaned workspace directory ${orphan.dir}`);
  expect(existsSync(orphan.dir)).toBe(false);
  expect(existsSync(busy.dir)).toBe(true);
  expect(existsSync(unresolved)).toBe(true);
});

test('--delete keeps an orphan whose native run started after the report', async () => {
  const orphan = goneWorkspace('raced');
  const original = console.log;
  let held = false;
  console.log = (...args) => {
    if (!held && String(args[0]).includes('Orphaned workspace directories')) {
      holdNativeRun(orphan.root);
      held = true;
    }
  };
  try {
    await runGc({ delete: true });
  } finally {
    console.log = original;
  }
  expect(held).toBe(true);
  expect(existsSync(join(orphan.dir, 'workspace.json'))).toBe(true);
});

describe('workspaceInUse', () => {
  test('an idle workspace has no reasons', () => {
    const { root } = goneWorkspace('idle');
    expect(workspaceInUse(root)).toEqual([]);
  });

  test('a held native-run.lock marks it in use', () => {
    const { root } = goneWorkspace('native');
    holdNativeRun(root);
    expect(workspaceInUse(root).join('\n')).toMatch(/native-run\.lock/);
  });

  test('a live build lock or slot naming the root marks it in use; one naming another root does not', () => {
    const { root } = goneWorkspace('building');
    plantClaim(join(tmpHome, 'build-locks', 'ios-other.lock'), 'exclusive', liveClaimOwner(), {
      details: { projectRoot: join(projects, 'elsewhere') },
    });
    expect(workspaceInUse(root)).toEqual([]);
    plantClaim(join(tmpHome, 'build-slots', 'slot-0'), 'exclusive', liveClaimOwner(), {
      details: { index: 0, projectRoot: root },
    });
    expect(workspaceInUse(root).join('\n')).toMatch(/live build slot/);
  });

  test('a build lock whose workspace cannot be identified marks every workspace in use', () => {
    const { root } = goneWorkspace('unknown');
    const lock = exclusiveClaimDir(join(tmpHome, 'build-locks', 'ios-unknown.lock'));
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'torn.claim'), '{');
    expect(workspaceInUse(root).join('\n')).toMatch(/cannot identify/);
  });

  test('a held managed tunnel lock marks it in use', async () => {
    const { root } = goneWorkspace('tunnel');
    await withManagedTunnelLock(root, async () => {
      expect(workspaceInUse(root).join('\n')).toMatch(/managed tunnel lock is held/);
    });
    expect(workspaceInUse(root)).toEqual([]);
  });

  test('a supervisor that is this live process marks it in use', () => {
    const { root } = goneWorkspace('supervised');
    writeWorkspaceState(root, { supervisor: { ...liveClaimOwner(), port: 8081 } });
    expect(workspaceInUse(root).join('\n')).toMatch(/supervisor \(pid \d+\) is running/);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTPUTS = ['derived-data', 'gradle-build', 'android-cas', 'cache-provider'];

function builtWorkspace(name: string, { usedDaysAgo = 0 }: { usedDaysAgo?: number } = {}) {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  const dir = ensureWorkspaceStorage(root);
  for (const output of OUTPUTS) {
    mkdirSync(join(dir, output, 'nested'), { recursive: true });
    writeFileSync(join(dir, output, 'nested', 'blob'), 'x'.repeat(64 * 1024));
  }
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'build-ios.ndjson'), '{}\n');
  const usedAt = new Date(Date.now() - usedDaysAgo * DAY_MS);
  utimesSync(join(dir, 'logs', 'build-ios.ndjson'), usedAt, usedAt);
  recordWorkspaceUse(root, usedAt);
  upsertProject(root, { metroPort: 8100, platforms: { ios: { deviceUdid: `U-${name}`, owned: true } } });
  return { root, dir };
}

describe('last use of a workspace', () => {
  const at = (iso: string) => Date.parse(iso);

  test('newer evidence than the recorded lastUsedAt wins, so a long Metro session is not idle', () => {
    expect(
      lastUseFrom({ lastUsedAt: '2026-09-01T00:00:00Z', lastBuild: { startedAt: '2026-09-20T00:00:00Z' } }, [
        at('2026-09-21T00:00:00Z'),
      ]),
    ).toBe(at('2026-09-21T00:00:00Z'));
    expect(lastUseFrom({ lastUsedAt: '2026-09-22T00:00:00Z' }, [at('2026-09-21T00:00:00Z')])).toBe(
      at('2026-09-22T00:00:00Z'),
    );
  });

  test('without lastUsedAt, the newest of the last build, the supervisor start and the log mtimes is used', () => {
    const state = {
      lastBuild: { startedAt: '2026-09-02T00:00:00Z' },
      supervisor: { startedAt: '2026-09-05T00:00:00Z' },
    };
    expect(lastUseFrom(state, [at('2026-09-03T00:00:00Z')])).toBe(at('2026-09-05T00:00:00Z'));
    expect(lastUseFrom(state, [at('2026-09-07T00:00:00Z')])).toBe(at('2026-09-07T00:00:00Z'));
  });

  test('a workspace with no evidence of use has no last use', () => {
    expect(lastUseFrom(null, [])).toBeNaN();
    expect(lastUseFrom({ lastUsedAt: 'garbage' }, [])).toBeNaN();
  });
});

describe('planning workspace build output clearing', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const entry = (overrides: Partial<Parameters<typeof planWorkspaceOutputs>[0][number]> = {}) => ({
    dir: '/h/workspaces/app--0',
    projectRoot: '/w/app',
    problem: null,
    bytes: 1024,
    lastUsed: now - 10 * DAY_MS,
    inUse: [] as string[],
    ...overrides,
  });

  test('without --older-than every workspace not in use is cleared', () => {
    const [idle, busy] = planWorkspaceOutputs(
      [entry(), entry({ lastUsed: now, inUse: ['a stim ios or android run holds its native-run.lock'] })],
      { olderThan: null, now },
    );
    expect(idle).toMatchObject({ willClear: true, idleDays: 10 });
    expect(busy).toMatchObject({ willClear: false });
    expect(busy?.keptReason).toMatch(/^in use: .*native-run/);
  });

  test('--older-than keeps a workspace used more recently, and one whose last use is unknown', () => {
    const [old, recent, unknown] = planWorkspaceOutputs(
      [entry(), entry({ lastUsed: now - 2 * DAY_MS }), entry({ lastUsed: NaN })],
      { olderThan: 3, now },
    );
    expect(old?.willClear).toBe(true);
    expect(recent?.keptReason).toBe('used 2d ago, within --older-than 3');
    expect(unknown?.keptReason).toBe('its last use is unknown');
  });

  test('an unresolved workspace directory is never cleared', () => {
    const [unresolved] = planWorkspaceOutputs([entry({ projectRoot: null, problem: 'it has no workspace.json' })], {
      olderThan: null,
      now,
    });
    expect(unresolved?.willClear).toBe(false);
  });
});

test('gc --delete --cache workspaces clears only the build outputs and keeps the workspace registered', async () => {
  const { root, dir } = builtWorkspace('app', { usedDaysAgo: 1 });
  const cacheDir = join(projects, 'shared-cache');
  mkdirSync(join(cacheDir, 'entry'), { recursive: true });
  writeFileSync(join(cacheDir, 'entry', 'blob'), 'x'.repeat(4096));
  register({ dir: cacheDir, name: 'Shared cache' });

  const report = await captureLog(() => runGc({ cache: 'workspaces' }));
  expect(report).toMatch(/Workspace build outputs \(detected\)/);
  expect(report).toMatch(/Swift/);
  expect(report).toContain(`${root} (idle 1d)`);
  expect(report).toContain('would be CLEARED');
  expect(report).not.toContain('Shared cache');

  await captureLog(() => runGc({ cache: 'workspaces', delete: true }));
  for (const output of OUTPUTS) expect(existsSync(join(dir, output))).toBe(false);
  expect(existsSync(join(dir, 'workspace.json'))).toBe(true);
  expect(existsSync(join(dir, 'state.json'))).toBe(true);
  expect(existsSync(join(dir, 'logs', 'build-ios.ndjson'))).toBe(true);
  expect(getProject(root)?.platforms?.ios).toEqual({ deviceUdid: 'U-app', owned: true });
  expect(existsSync(join(cacheDir, 'entry', 'blob'))).toBe(true);
});

test('plain gc --delete clears idle workspaces, and --older-than limits it by last use', async () => {
  const recent = builtWorkspace('recent', { usedDaysAgo: 1 });
  const stale = builtWorkspace('stale', { usedDaysAgo: 10 });
  const busy = builtWorkspace('busy', { usedDaysAgo: 30 });
  holdNativeRun(busy.root);

  const output = await captureLog(() => runGc({ delete: true, olderThan: 3 }));
  expect(existsSync(join(stale.dir, 'derived-data'))).toBe(false);
  expect(existsSync(join(recent.dir, 'derived-data'))).toBe(true);
  expect(existsSync(join(busy.dir, 'derived-data'))).toBe(true);
  expect(output).toMatch(/Kept the build outputs of .*busy: in use/);

  await captureLog(() => runGc({ delete: true }));
  expect(existsSync(join(recent.dir, 'derived-data'))).toBe(false);
  expect(existsSync(join(busy.dir, 'derived-data'))).toBe(true);
});
