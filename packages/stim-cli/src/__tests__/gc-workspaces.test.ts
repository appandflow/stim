import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { classifyWorkspaceDirs, listWorkspaceDirs } from '../commands/gc/workspaces.ts';
import { saveConfig } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { withManagedTunnelLock } from '../engine/tunnel.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
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
