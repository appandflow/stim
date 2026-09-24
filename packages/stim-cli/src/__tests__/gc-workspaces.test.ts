import { execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { matchWorktreeEntry, removeWorktreeTarget } from '../commands/worktree.ts';
import { classifyWorkspaceDirs, listWorkspaceDirs, planWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { worktreeSkipReason, type WorktreeFacts } from '../commands/gc/worktrees.ts';
import { getProject, saveConfig, upsertProject } from '../workspace/config.ts';
import { register } from '../cache/cache-manifest.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { withManagedTunnelLock } from '../engine/tunnel.ts';
import { lastUseFrom, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { claimRemoveCommand, exclusiveClaimDir } from '../ownership-claim.ts';
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
      inUse: (root) => (busy.includes(root) ? ['a stim ios, android or stop run holds its native-run.lock'] : []),
    });

  test('a workspace whose project root is gone and unregistered is orphaned', () => {
    expect(classify([entry('/w/gone')]).orphaned.map((o) => o.projectRoot)).toEqual(['/w/gone']);
  });

  test('a workspace whose project root still exists is not orphaned', () => {
    expect(classify([entry('/w/here')], { existing: ['/w/here'] })).toEqual({ orphaned: [], skipped: [] });
  });

  test('a project root whose existence cannot be read is kept, not treated as deleted', () => {
    const result = classifyWorkspaceDirs([entry('/w/denied')], {
      registryKeys: [],
      exists: () => null,
      isMounted: () => true,
      inUse: () => [],
    });
    expect(result.orphaned).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/cannot tell whether/);
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

test('--delete removes a symlinked orphaned workspace directory as a link and leaves its target', async () => {
  const orphan = goneWorkspace('linked-away');
  const target = join(projects, 'workspace-target');
  renameSync(orphan.dir, target);
  symlinkSync(target, orphan.dir, 'junction');

  const output = await captureLog(() => runGc({ delete: true }));
  expect(output).toContain(`Removed the orphaned workspace directory ${orphan.dir}`);
  expect(existsSync(orphan.dir)).toBe(false);
  expect(existsSync(join(target, 'workspace.json'))).toBe(true);
  expect(existsSync(join(target, 'state.json'))).toBe(true);
});

test('clearing the build outputs of a symlinked workspace directory keeps the link', async () => {
  const { dir } = builtWorkspace('linked-outputs', { usedDaysAgo: 10 });
  const target = join(projects, 'outputs-target');
  renameSync(dir, target);
  symlinkSync(target, dir, 'junction');

  await captureLog(() => runGc({ delete: true, cache: 'workspaces' }));
  expect(existsSync(join(target, 'derived-data'))).toBe(false);
  expect(lstatSync(dir).isSymbolicLink()).toBe(true);
  expect(existsSync(join(dir, 'workspace.json'))).toBe(true);
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

  test('a build lock that names no workspace does not mark every workspace in use, and gc names its remedy', async () => {
    const { root } = goneWorkspace('unknown');
    const lock = exclusiveClaimDir(join(tmpHome, 'build-locks', 'ios-unknown.lock'));
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'torn.claim'), '{');
    expect(workspaceInUse(root)).toEqual([]);
    const report = await captureLog(() => runGc({}));
    expect(report).toContain(claimRemoveCommand(join(tmpHome, 'build-locks', 'ios-unknown.lock')));
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
      [entry(), entry({ lastUsed: now, inUse: ['a stim ios, android or stop run holds its native-run.lock'] })],
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

test.skipIf(process.platform === 'win32')(
  'a workspace whose project root is on an unmounted volume keeps its build outputs (macOS /Volumes; skipped on win32)',
  async () => {
    const root = '/Volumes/StimTestVolumeThatDoesNotExist/offline-app';
    const dir = ensureWorkspaceStorage(root);
    mkdirSync(join(dir, 'derived-data', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'derived-data', 'nested', 'blob'), 'x');
    upsertProject(root, { metroPort: 8100 });

    await captureLog(() => runGc({ delete: true }));
    await captureLog(() => runGc({ delete: true, cache: 'workspaces' }));
    expect(existsSync(join(dir, 'derived-data', 'nested', 'blob'))).toBe(true);
    expect(getProject(root)).toBeTruthy();
  },
);

describe('linked worktree sweep classification', () => {
  const linked = (overrides: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
    source: 'linked',
    bare: false,
    locked: false,
    porcelain: [],
    unpushed: [],
    submodules: false,
    inUse: [],
    idleDays: 10,
    ...overrides,
  });

  test('a clean, pushed, idle linked worktree is removable', () => {
    expect(worktreeSkipReason(linked(), 7)).toBe(null);
  });

  test('pod install churn alone does not keep a worktree', () => {
    expect(
      worktreeSkipReason(linked({ porcelain: [' M ios/Podfile.lock', ' M ios/App.xcodeproj/project.pbxproj'] }), 7),
    ).toBe(null);
  });

  test.each([
    ['the source checkout', linked({ source: 'source' }), /^source checkout$/],
    ['an unresolvable source checkout', linked({ source: { refusal: 'detached bare HEAD' } }), /source checkout/],
    ['a bare repository', linked({ bare: true }), /bare/],
    ['a locked worktree', linked({ locked: true }), /locked/],
    ['a dirty worktree', linked({ porcelain: [' M src/App.tsx'] }), /dirty/],
    ['a worktree with only untracked files', linked({ porcelain: ['?? notes.txt'] }), /dirty/],
    ['pod churn beside another change', linked({ porcelain: [' M ios/Podfile.lock', '?? x'] }), /dirty/],
    ['an unreadable git status', linked({ porcelain: null }), /could not be read/],
    ['unpushed commits', linked({ unpushed: ['abc1234 wip'] }), /unpushed: 1 commit/],
    ['an unknown unpushed state', linked({ unpushed: null }), /could not be checked/],
    ['initialized submodules', linked({ submodules: true }), /submodules/],
    ['a worktree in use', linked({ inUse: ['its dev server supervisor (pid 1) is running'] }), /^in use: /],
    ['a recently used worktree', linked({ idleDays: 2 }), /recently used 2d ago/],
    ['a worktree whose last use is unknown', linked({ idleDays: null }), /recently used/],
  ])('%s is kept', (_name, facts, reason) => {
    expect(worktreeSkipReason(facts, 7)).toMatch(reason);
  });
});

function gitRepoWithWorktrees(names: string[]) {
  const repo = join(projects, 'repo');
  const remote = join(projects, 'remote.git');
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 });
  git(`init -q --bare "${remote}"`, projects);
  git('init -q');
  git('config user.email test@example.com');
  git('config user.name test');
  git(`remote add origin "${remote}"`);
  writeFileSync(join(repo, 'package.json'), '{}');
  git('add -A');
  git('commit -q -m init');
  git('push -q -u origin HEAD');
  const worktrees = Object.fromEntries(
    names.map((name) => {
      const path = join(projects, name);
      git(`worktree add -q "${path}" -b ${name}`);
      return [name, path];
    }),
  );
  return { repo, worktrees };
}

test('gc --worktrees reports each linked worktree, and --delete removes only the clean idle ones', async () => {
  const { repo, worktrees } = gitRepoWithWorktrees(['idle', 'fresh', 'dirty', 'racing']);
  const reported = { idle: realpathSync.native(worktrees.idle!), racing: realpathSync.native(worktrees.racing!) };
  for (const [name, path] of Object.entries(worktrees)) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path, new Date(Date.now() - (name === 'fresh' ? 1 : 10) * DAY_MS));
  }
  upsertProject(repo, { metroPort: null });
  recordWorkspaceUse(repo, new Date(Date.now() - 30 * DAY_MS));
  writeFileSync(join(worktrees.dirty!, 'scratch.txt'), 'wip');

  const report = await captureLog(() => runGc({ worktrees: true }));
  expect(report).toContain('Linked worktrees (2 removable, 3 kept)');
  expect(report).toContain('idle 7d or more (the default without --older-than)');
  expect(report).toMatch(/kept: source checkout/);
  expect(report).toMatch(/kept: recently used 1d ago/);
  expect(report).toMatch(/kept: dirty/);

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args) => errors.push(args.join(' '));
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
    if (String(args[0]).startsWith('Linked worktrees')) writeFileSync(join(worktrees.racing!, 'late.txt'), 'x');
  };
  try {
    await runGc({ worktrees: true, delete: true });
  } finally {
    console.log = original;
    console.error = originalError;
  }
  const output = lines.join('\n');
  expect(existsSync(worktrees.idle!)).toBe(false);
  expect(getProject(worktrees.idle!)).toBe(null);
  expect(output).toContain(`Removed the worktree ${reported.idle}`);
  expect(existsSync(worktrees.racing!)).toBe(true);
  expect(errors.join('\n')).toMatch(/uncommitted changes or untracked files/);
  expect(errors.join('\n')).toContain(`Kept the worktree ${reported.racing}`);
  for (const name of ['fresh', 'dirty']) expect(existsSync(worktrees[name]!)).toBe(true);
  expect(existsSync(join(repo, 'package.json'))).toBe(true);
  expect(process.exitCode).toBe(1);
}, 30_000);

test('a worktree gc --delete --worktrees keeps because it was used after the report is not a failure', async () => {
  const { worktrees } = gitRepoWithWorktrees(['reused']);
  const reused = worktrees.reused!;
  upsertProject(reused, { metroPort: null });
  recordWorkspaceUse(reused, new Date(Date.now() - 10 * DAY_MS));

  const originalError = console.error;
  console.error = () => {};
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
    if (String(args[0]).startsWith('Linked worktrees')) recordWorkspaceUse(reused);
  };
  try {
    await runGc({ worktrees: true, delete: true });
  } finally {
    console.log = original;
    console.error = originalError;
  }
  expect(existsSync(reused)).toBe(true);
  expect(lines.join('\n')).toMatch(/Kept the worktree .*reused: used 0d ago since gc checked it/);
  expect(process.exitCode).not.toBe(1);
}, 30_000);

test('gc refuses --cache combined with --worktrees and removes nothing', async () => {
  const { worktrees } = gitRepoWithWorktrees(['idle']);
  upsertProject(worktrees.idle!, { metroPort: null });
  recordWorkspaceUse(worktrees.idle!, new Date(Date.now() - 30 * DAY_MS));
  const { dir } = builtWorkspace('built', { usedDaysAgo: 30 });

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args) => errors.push(args.join(' '));
  let output: string;
  try {
    output = await captureLog(() => runGc({ cache: 'workspaces', worktrees: true, delete: true }));
  } finally {
    console.error = originalError;
  }
  expect(errors.join('\n')).toContain('STIM_BAD_ARG');
  expect(output).toBe('');
  expect(process.exitCode).toBe(1);
  expect(existsSync(worktrees.idle!)).toBe(true);
  expect(existsSync(join(dir, 'derived-data'))).toBe(true);
}, 30_000);

test('worktree removal re-checks for new work under its removal locks', async () => {
  const { worktrees } = gitRepoWithWorktrees(['late']);
  const late = worktrees.late!;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args) => errors.push(args.join(' '));
  let removed: boolean;
  try {
    removed = await removeWorktreeTarget(late, {
      guard: () => {
        writeFileSync(join(late, 'written-after-the-first-check.txt'), 'x');
        return [];
      },
    });
  } finally {
    console.error = originalError;
  }
  expect(removed).toBe(false);
  expect(existsSync(join(late, 'written-after-the-first-check.txt'))).toBe(true);
  expect(errors.join('\n')).toMatch(/uncommitted changes or untracked files/);
}, 30_000);

test('a worktree registered under a symlinked path still matches the path git reports', () => {
  const real = join(projects, 'real-worktree');
  mkdirSync(real, { recursive: true });
  const link = join(projects, 'linked-worktree');
  symlinkSync(real, link, 'junction');
  expect(matchWorktreeEntry([{ path: real }], join(link, 'apps', 'mobile'))?.path).toBe(real);
});

test('a workspace whose output size cannot be measured is listed as size unknown and still cleared', async () => {
  const { root, dir } = builtWorkspace('slow', { usedDaysAgo: 10 });
  const current = getExecutor();
  setExecutor({
    ...current,
    runFile: (file, args, opts) => {
      if (file === 'du') throw new Error('Command timed out after 60000ms: du');
      return current.runFile(file, args, opts);
    },
  });

  const report = await captureLog(() => runGc({ cache: 'workspaces' }));
  expect(report).toContain(`size unknown  ${root} (idle 10d)`);
  await captureLog(() => runGc({ cache: 'workspaces', delete: true }));
  expect(existsSync(join(dir, 'derived-data'))).toBe(false);
});
