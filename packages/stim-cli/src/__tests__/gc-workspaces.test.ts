import { execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
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
import { basename, join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { matchWorktreeEntry, removeWorktreeTarget } from '../commands/worktree.ts';
import { classifyWorkspaceDirs, listWorkspaceDirs, planWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { worktreeSkipReason, type WorktreeFacts } from '../commands/gc/worktrees.ts';
import { mergeState, type MergeState } from '../workspace/merge-state.ts';
import {
  selectPullRequest,
  type GhPullRequest,
  type PullRequestFact,
  type PullRequestLookup,
} from '../workspace/pull-request.ts';
import { getProject, saveConfig, upsertProject } from '../workspace/config.ts';
import { register } from '../cache/cache-manifest.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { withManagedTunnelLock } from '../engine/tunnel.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { claimRemoveCommand, exclusiveClaimDir } from '../ownership-claim.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { registerCollector } from '../collector/state.ts';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { liveClaimOwner, plantClaim } from './_factories.ts';

let tmpHome: string;
let projects: string;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
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
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
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
  return { raw: stdout[0] ?? '', payload: JSON.parse(stdout[0] ?? '') };
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

test('gc --json reports orphaned workspace directories and workspace build outputs with stable reasons', async () => {
  const orphan = goneWorkspace('deleted-worktree');
  const stale = builtWorkspace('stale', { usedDaysAgo: 10 });
  const recent = builtWorkspace('recent', { usedDaysAgo: 1 });
  const busy = builtWorkspace('busy', { usedDaysAgo: 30 });
  holdNativeRun(busy.root);

  const { raw, payload } = await gcJson({ olderThan: 3 });

  expect(payload.worktreeSweep).toBe(null);
  expect(payload.sections.linkedWorktrees).toEqual([]);
  expect(payload.sections.orphanedWorkspaces).toEqual([
    { dir: orphan.dir, projectRoot: orphan.root, bytes: expect.any(Number) },
  ]);
  const outputs = Object.fromEntries(
    payload.sections.workspaceBuildOutputs.map((w: { projectRoot: string }) => [w.projectRoot, w]),
  );
  expect(outputs[stale.root]).toMatchObject({
    dir: stale.dir,
    idleDays: 10,
    willClear: true,
    reason: null,
    detail: null,
    bytes: expect.any(Number),
  });
  expect(outputs[recent.root]).toMatchObject({ willClear: false, reason: 'recently-used' });
  expect(outputs[busy.root]).toMatchObject({
    willClear: false,
    reason: 'in-use',
    detail: expect.stringMatching(/^in use: /),
  });
  expect(raw).not.toMatch(/Swift|state\.json, logs/);
  expect(existsSync(orphan.dir)).toBe(true);
  expect(existsSync(join(stale.dir, 'derived-data'))).toBe(true);
});

test('gc --delete --json reports what it removed apart from what it kept', async () => {
  const orphan = goneWorkspace('deleted-worktree');
  const stale = builtWorkspace('stale', { usedDaysAgo: 10 });
  const busy = builtWorkspace('busy', { usedDaysAgo: 30 });
  holdNativeRun(busy.root);

  expect((await gcJson({ olderThan: 3 })).payload.results).toEqual([]);
  const { payload } = await gcJson({ olderThan: 3, delete: true });

  expect(payload.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'workspaceDirectory',
        status: 'done',
        label: orphan.dir,
        bytes: expect.any(Number),
      }),
      expect.objectContaining({
        kind: 'workspaceOutputs',
        status: 'done',
        label: stale.root,
        bytes: expect.any(Number),
      }),
      expect.objectContaining({
        kind: 'workspaceOutputs',
        status: 'kept',
        label: busy.root,
        detail: expect.stringMatching(/^in use: /),
      }),
    ]),
  );
  expect(payload.results.filter((r: { status: string }) => r.status === 'failed')).toEqual([]);
  expect(existsSync(orphan.dir)).toBe(false);
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
    expect(busy).toMatchObject({ willClear: false, keptCode: 'in-use' });
    expect(busy?.keptReason).toMatch(/^in use: .*native-run/);
  });

  test('--older-than keeps a workspace used more recently, and one whose last use is unknown', () => {
    const [old, recent, unknown] = planWorkspaceOutputs(
      [entry(), entry({ lastUsed: now - 2 * DAY_MS }), entry({ lastUsed: NaN })],
      { olderThan: 3, now },
    );
    expect(old?.willClear).toBe(true);
    expect(recent).toMatchObject({ keptCode: 'recently-used', keptReason: 'used 2d ago, within --older-than 3' });
    expect(unknown).toMatchObject({ keptCode: 'last-use-unknown', keptReason: 'its last use is unknown' });
  });

  test('an unresolved workspace directory is never cleared', () => {
    const [unresolved] = planWorkspaceOutputs([entry({ projectRoot: null, problem: 'it has no workspace.json' })], {
      olderThan: null,
      now,
    });
    expect(unresolved).toMatchObject({ willClear: false, keptCode: 'unresolved' });
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

function loggedWorkspace(name: string): { root: string; logs: string } {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  const logs = join(ensureWorkspaceStorage(root), 'logs');
  mkdirSync(logs, { recursive: true });
  upsertProject(root, { metroPort: 8100 });
  return { root, logs };
}

function oversizedLog(file: string): void {
  const line = `${JSON.stringify({ msg: 'x'.repeat(1000) })}\n`;
  writeFileSync(file, `${line.repeat(Math.ceil((LOG_ROTATE_BYTES + 64 * 1024) / line.length))}{"msg":"last"}\n`);
}

test('gc --json reports the logs of every workspace, and --delete trims oversized capped logs of idle workspaces', async () => {
  const quiet = loggedWorkspace('quiet');
  writeFileSync(join(quiet.logs, 'metro.ndjson'), '{}\n');
  const big = loggedWorkspace('big');
  oversizedLog(join(big.logs, 'device.ndjson'));
  oversizedLog(join(big.logs, 'metro.ndjson.1'));
  oversizedLog(join(big.logs, 'build-ios.ndjson'));
  const busy = loggedWorkspace('busy');
  oversizedLog(join(busy.logs, 'device.ndjson'));
  holdNativeRun(busy.root);
  const collecting = loggedWorkspace('collecting');
  oversizedLog(join(collecting.logs, 'device.ndjson'));
  registerCollector(collecting.root, 'ios', { pid: 1 });

  const { payload } = await gcJson({});
  const byRoot = Object.fromEntries(
    payload.sections.workspaceLogs.map((w: { projectRoot: string }) => [w.projectRoot, w]),
  );
  expect(byRoot[quiet.root]).toMatchObject({ bytes: 3, trimBytes: 0, willTrim: false, reason: null });
  expect(byRoot[big.root]).toMatchObject({ willTrim: true, reason: null });
  expect(byRoot[big.root].trimBytes).toBeGreaterThan(0);
  expect(byRoot[big.root].bytes).toBeGreaterThan(3 * LOG_ROTATE_BYTES);
  expect(byRoot[busy.root]).toMatchObject({ willTrim: false, reason: 'in-use' });
  expect(byRoot[collecting.root]).toMatchObject({ willTrim: false, reason: 'collector' });
  expect(payload.actionable).toBe(true);

  const longAgo = new Date(Math.floor((Date.now() - 30 * DAY_MS) / 1000) * 1000);
  utimesSync(join(big.logs, 'device.ndjson'), longAgo, longAgo);
  const buildBytes = statSync(join(big.logs, 'build-ios.ndjson')).size;
  const output = await captureLog(() => runGc({ delete: true }));
  expect(output).toContain(`Trimmed the logs of ${big.root}`);
  for (const name of ['device.ndjson', 'metro.ndjson.1']) {
    const text = readFileSync(join(big.logs, name), 'utf8');
    expect(text.length).toBeLessThanOrEqual(LOG_ROTATE_BYTES);
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('{"msg":"last"}\n')).toBe(true);
  }
  expect(statSync(join(big.logs, 'build-ios.ndjson')).size).toBe(buildBytes);
  expect(statSync(join(big.logs, 'device.ndjson')).mtimeMs).toBe(longAgo.getTime());
  expect(statSync(join(busy.logs, 'device.ndjson')).size).toBeGreaterThan(LOG_ROTATE_BYTES);
  expect(statSync(join(collecting.logs, 'device.ndjson')).size).toBeGreaterThan(LOG_ROTATE_BYTES);
  expect(output).toMatch(/Kept the logs of .*collecting: a device log collector is recorded for ios/);
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
    merge: null,
    pullRequest: null,
    activity: null,
    ...overrides,
  });
  const merged = (coversUnpushed = false, mergedAt = 0): MergeState => ({
    merged: true,
    into: 'origin/main',
    head: 'abc',
    coversUnpushed,
    mergedAt,
  });

  test('a clean, pushed, idle linked worktree is removable', () => {
    expect(worktreeSkipReason(linked(), 7)).toBe(null);
  });

  test('a merged worktree is removable without the idle rule, even when used today', () => {
    expect(worktreeSkipReason(linked({ idleDays: 0, merge: merged() }), null)).toBe(null);
  });

  test('local-only commits block a merged worktree unless its upstream was deleted after the merge', () => {
    expect(worktreeSkipReason(linked({ unpushed: ['abc wip'], merge: merged() }), null)?.code).toBe('unpushed');
    expect(worktreeSkipReason(linked({ unpushed: ['abc wip'], merge: merged(true) }), null)).toBe(null);
  });

  test.each([
    ['dirty', linked({ porcelain: ['?? notes.txt'], merge: merged() }), 'dirty'],
    ['in use', linked({ inUse: ['its dev server supervisor (pid 1) is running'], merge: merged() }), 'in-use'],
    ['locked', linked({ locked: true, merge: merged() }), 'locked'],
    ['the source checkout', linked({ source: 'source', merge: merged() }), 'source-checkout'],
    ['with submodules', linked({ submodules: true, merge: merged(true) }), 'submodules'],
    [
      'not merged',
      linked({ merge: { merged: false, unknown: false, detail: 'not merged into origin/main' } }),
      'not-merged',
    ],
    [
      'of unknown merge state',
      linked({ merge: { merged: false, unknown: true, detail: 'merge state unknown: fetch failed' } }),
      'merge-unknown',
    ],
  ])('without --worktrees, a worktree %s is kept', (_name, facts, code) => {
    expect(worktreeSkipReason(facts, null)?.code).toBe(code);
  });

  test('pod install churn alone does not keep a worktree', () => {
    expect(
      worktreeSkipReason(linked({ porcelain: [' M ios/Podfile.lock', ' M ios/App.xcodeproj/project.pbxproj'] }), 7),
    ).toBe(null);
  });

  test.each([
    ['the source checkout', linked({ source: 'source' }), 'source-checkout', /^source checkout$/],
    [
      'an unresolvable source checkout',
      linked({ source: { refusal: 'detached bare HEAD' } }),
      'source-checkout-unknown',
      /source checkout/,
    ],
    ['a bare repository', linked({ bare: true }), 'bare-repository', /bare/],
    ['a locked worktree', linked({ locked: true }), 'locked', /locked/],
    ['a dirty worktree', linked({ porcelain: [' M src/App.tsx'] }), 'dirty', /dirty/],
    ['a worktree with only untracked files', linked({ porcelain: ['?? notes.txt'] }), 'dirty', /dirty/],
    ['pod churn beside another change', linked({ porcelain: [' M ios/Podfile.lock', '?? x'] }), 'dirty', /dirty/],
    ['an unreadable git status', linked({ porcelain: null }), 'status-unreadable', /could not be read/],
    ['unpushed commits', linked({ unpushed: ['abc1234 wip'] }), 'unpushed', /unpushed: 1 commit/],
    ['an unknown unpushed state', linked({ unpushed: null }), 'unpushed-unchecked', /could not be checked/],
    ['initialized submodules', linked({ submodules: true }), 'submodules', /submodules/],
    ['a worktree in use', linked({ inUse: ['its dev server supervisor (pid 1) is running'] }), 'in-use', /^in use: /],
    ['a recently used worktree', linked({ idleDays: 2 }), 'recently-used', /recently used 2d ago/],
    ['a worktree whose last use is unknown', linked({ idleDays: null }), 'last-use-unknown', /recently used/],
  ])('%s is kept', (_name, facts, code, text) => {
    const skip = worktreeSkipReason(facts, 7);
    expect(skip?.code).toBe(code);
    expect(skip?.text).toMatch(text);
  });

  describe('the pull request of its branch', () => {
    const pr = (state: PullRequestFact['state'], overrides: Partial<PullRequestFact> = {}): PullRequestLookup => ({
      pullRequest: {
        number: 12,
        state,
        url: 'https://github.com/o/r/pull/12',
        head: 'abc',
        containsHead: true,
        endedAt: 0,
        ...overrides,
      },
    });
    const notMerged: MergeState = { merged: false, unknown: false, detail: 'not merged into origin/main' };

    test('a merged pull request makes a clean worktree removable, even with its remote branch deleted', () => {
      expect(worktreeSkipReason(linked({ idleDays: 0, pullRequest: pr('merged'), merge: notMerged }), null)).toBe(null);
      expect(worktreeSkipReason(linked({ unpushed: ['abc wip'], pullRequest: pr('merged') }), null)).toBe(null);
    });

    test('a closed pull request makes a clean, pushed worktree removable but keeps unpushed commits', () => {
      expect(worktreeSkipReason(linked({ idleDays: 0, pullRequest: pr('closed') }), null)).toBe(null);
      expect(worktreeSkipReason(linked({ unpushed: ['abc wip'], pullRequest: pr('closed') }), null)?.code).toBe(
        'unpushed',
      );
    });

    test('a merged pull request never overrides uncommitted work, and the reason counts the files', () => {
      const skip = worktreeSkipReason(linked({ porcelain: [' M a.ts', '?? b.ts'], pullRequest: pr('merged') }), null);
      expect(skip).toEqual({ code: 'dirty', text: 'dirty: 2 uncommitted or untracked files' });
    });

    test('an open pull request, or HEAD past a merged one, is not merged', () => {
      expect(worktreeSkipReason(linked({ pullRequest: pr('open'), merge: notMerged }), null)).toEqual({
        code: 'not-merged',
        text: 'not merged into origin/main; PR #12 open',
      });
      expect(worktreeSkipReason(linked({ pullRequest: pr('merged', { containsHead: false }) }), null)).toEqual({
        code: 'not-merged',
        text: 'PR #12 merged, and HEAD has commits it does not',
      });
    });

    test('an unknown pull request state falls back to the git verdict', () => {
      const unknown = { unavailable: 'gh is not installed' };
      expect(worktreeSkipReason(linked({ pullRequest: unknown, merge: notMerged }), null)?.code).toBe('not-merged');
      expect(worktreeSkipReason(linked({ pullRequest: unknown, merge: merged() }), null)).toBe(null);
    });

    test('the grace period runs from when the pull request was merged or closed', () => {
      const now = Date.parse('2026-09-25T12:00:00Z');
      const facts = linked({
        pullRequest: pr('closed', { endedAt: now - 10 * 60_000 }),
        activity: { at: now - 600 * 60_000, basis: 'a git index write' },
      });
      const skip = worktreeSkipReason(facts, null, { ms: 120 * 60_000, now });
      expect(skip?.code).toBe('recent-activity');
      expect(skip?.text).toMatch(/^recent activity: PR #12 closed 10m ago/);
    });
  });

  describe('the grace period', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const grace = { ms: 120 * 60_000, now };
    const ago = (minutes: number) => now - minutes * 60_000;
    const activity = (minutes: number) => ({ at: ago(minutes), basis: 'a git index write' });

    test('keeps a merged worktree whose newest activity is inside the grace period, until it ends', () => {
      const skip = worktreeSkipReason(linked({ merge: merged(false, ago(600)), activity: activity(30) }), null, grace);
      expect(skip).toEqual({
        code: 'recent-activity',
        text: 'recent activity: a git index write 30m ago; removable after 2026-09-25T13:30:00.000Z',
        eligibleAt: Date.parse('2026-09-25T13:30:00Z'),
      });
    });

    test('keeps a worktree whose branch merged inside the grace period even when nothing else changed', () => {
      const skip = worktreeSkipReason(linked({ merge: merged(false, ago(10)), activity: activity(600) }), null, grace);
      expect(skip?.code).toBe('recent-activity');
      expect(skip?.text).toMatch(/^recent activity: merged into origin\/main 10m ago/);
      expect(skip?.eligibleAt).toBe(ago(10) + grace.ms);
    });

    test('removes a merged worktree once both its activity and its merge are older than the grace period', () => {
      expect(worktreeSkipReason(linked({ merge: merged(false, ago(121)), activity: activity(180) }), null, grace)).toBe(
        null,
      );
    });

    test('applies to an idle worktree too', () => {
      expect(worktreeSkipReason(linked({ activity: activity(5) }), 7, grace)?.code).toBe('recent-activity');
      expect(worktreeSkipReason(linked({ activity: activity(500) }), 7, grace)).toBe(null);
    });

    test('keeps a worktree whose activity cannot be read', () => {
      expect(worktreeSkipReason(linked({ merge: merged(false, ago(600)) }), null, grace)?.code).toBe(
        'activity-unknown',
      );
    });

    test('never overrides a stronger reason, and 0 turns it off', () => {
      expect(worktreeSkipReason(linked({ porcelain: ['?? x'], activity: activity(1) }), 7, grace)?.code).toBe('dirty');
      expect(worktreeSkipReason(linked({ merge: merged(false, ago(1)) }), null, { ms: 0, now })).toBe(null);
    });
  });
});

describe('choosing the pull request of a worktree', () => {
  const gh = (number: number, state: string, headRefOid: string): GhPullRequest => ({
    number,
    state,
    url: `https://github.com/o/r/pull/${number}`,
    headRefOid,
    mergedAt: state === 'MERGED' ? '2026-09-24T10:00:00Z' : null,
    closedAt: state === 'OPEN' ? null : '2026-09-24T10:00:00Z',
  });
  const history: Record<string, string[]> = { head: ['base'], later: ['head', 'base'] };
  const isAncestor = (ancestor: string, descendant: string) => (history[descendant] ?? []).includes(ancestor);

  test('picks the pull request whose head is HEAD over an older one that reused the branch name', () => {
    const chosen = selectPullRequest([gh(6536, 'MERGED', 'other'), gh(6540, 'CLOSED', 'head')], 'head', isAncestor);
    expect(chosen).toMatchObject({ number: 6540, state: 'closed', containsHead: true });
    expect(chosen?.endedAt).toBe(Date.parse('2026-09-24T10:00:00Z'));
  });

  test('an open pull request on the same head wins over a closed one', () => {
    expect(selectPullRequest([gh(2, 'CLOSED', 'head'), gh(1, 'OPEN', 'head')], 'head', isAncestor)?.state).toBe('open');
  });

  test('a pull request whose head contains HEAD contains its commits; one HEAD is past does not', () => {
    expect(selectPullRequest([gh(3, 'MERGED', 'later')], 'head', isAncestor)).toMatchObject({ containsHead: true });
    expect(selectPullRequest([gh(3, 'MERGED', 'base')], 'head', isAncestor)).toMatchObject({ containsHead: false });
  });

  test('a pull request unrelated to HEAD, or from a fork that reuses the branch name, is ignored', () => {
    expect(selectPullRequest([gh(4, 'MERGED', 'unrelated')], 'head', isAncestor)).toBe(null);
    expect(selectPullRequest([{ ...gh(5, 'MERGED', 'head'), isCrossRepository: true }], 'head', isAncestor)).toBe(null);
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

test('gc --worktrees --json reports each worktree verdict with its idle threshold and no registry keys', async () => {
  const { repo, worktrees } = gitRepoWithWorktrees(['idle', 'fresh']);
  for (const [name, path] of Object.entries(worktrees)) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path, new Date(Date.now() - (name === 'fresh' ? 1 : 10) * DAY_MS));
  }
  upsertProject(repo, { metroPort: null });

  const { payload } = await gcJson({ worktrees: true });

  expect(payload.worktreeSweep).toEqual({ olderThan: 7, defaulted: true });
  const byPath = Object.fromEntries(
    payload.sections.linkedWorktrees.map((w: { path: string }) => [realpathSync.native(w.path), w]),
  );
  expect(byPath[realpathSync.native(worktrees.idle!)]).toEqual({
    path: expect.any(String),
    idleDays: 10,
    mergedInto: null,
    pullRequest: null,
    pullRequestUnknown: 'gh is not installed',
    willRemove: true,
    reason: null,
    detail: 'idle 10d',
    eligibleAt: null,
  });
  expect(byPath[realpathSync.native(worktrees.fresh!)]).toMatchObject({
    willRemove: false,
    reason: 'recently-used',
    detail: expect.stringMatching(/^recently used 1d ago; merge state unknown: origin\/HEAD is not set/),
  });
  expect(byPath[realpathSync.native(repo)]).toMatchObject({ willRemove: false, reason: 'source-checkout' });
  expect(existsSync(worktrees.idle!)).toBe(true);

  expect((await gcJson({ worktrees: true, olderThan: 30 })).payload.worktreeSweep).toEqual({
    olderThan: 30,
    defaulted: false,
  });
}, 30_000);

test('gc --delete removes a worktree whose pull request merged or closed only when nothing would be lost', async () => {
  const names = ['shipped', 'abandoned', 'unsaved', 'wip', 'gone', 'noPr'];
  const { worktrees } = gitRepoWithWorktrees(names);
  const git = (args: string, cwd: string) =>
    execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  const heads: Record<string, string> = {};
  for (const name of names) {
    const path = worktrees[name]!;
    writeFileSync(join(path, `${name}.txt`), name);
    git(`add ${name}.txt`, path);
    git(`commit -q -m ${name}`, path);
    if (name !== 'shipped') git(`push -q origin ${name}`, path);
    heads[name] = git('rev-parse HEAD', path);
    upsertProject(path, { metroPort: null });
  }
  writeFileSync(join(worktrees.unsaved!, 'notes.txt'), 'x');
  git('commit -q --allow-empty -m local', worktrees.wip!);
  git('push -q origin --delete gone', worktrees.gone!);
  git('fetch -q --prune origin', worktrees.gone!);
  const pulls: Record<string, object[]> = {
    shipped: [
      {
        number: 1,
        url: 'https://github.com/o/r/pull/1',
        state: 'MERGED',
        headRefOid: heads.shipped,
        mergedAt: '2026-09-01T00:00:00Z',
      },
    ],
    abandoned: [
      {
        number: 2,
        url: 'https://github.com/o/r/pull/2',
        state: 'CLOSED',
        headRefOid: heads.abandoned,
        closedAt: '2026-09-01T00:00:00Z',
      },
    ],
    unsaved: [
      {
        number: 3,
        url: 'https://github.com/o/r/pull/3',
        state: 'MERGED',
        headRefOid: heads.unsaved,
        mergedAt: '2026-09-01T00:00:00Z',
      },
    ],
    wip: [
      {
        number: 4,
        url: 'https://github.com/o/r/pull/4',
        state: 'CLOSED',
        headRefOid: heads.wip,
        closedAt: '2026-09-01T00:00:00Z',
      },
    ],
    gone: [
      {
        number: 5,
        url: 'https://github.com/o/r/pull/5',
        state: 'CLOSED',
        headRefOid: heads.gone,
        closedAt: '2026-09-01T00:00:00Z',
      },
    ],
    noPr: [],
  };
  const current = getExecutor();
  const ghCalls: string[][] = [];
  setExecutor({
    ...current,
    findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : current.findExecutable(name)),
    runFile: (file, args: string[], opts) => {
      if (file !== 'gh') return current.runFile(file, args, opts);
      ghCalls.push(args);
      const branch = args[args.indexOf('--head') + 1]!;
      return JSON.stringify(pulls[branch] ?? []);
    },
  });

  const { payload } = await gcJson({});
  const byName = Object.fromEntries(
    payload.sections.linkedWorktrees.map((w: { path: string }) => [basename(w.path), w]),
  );
  expect(byName.shipped).toMatchObject({
    willRemove: true,
    detail: 'PR #1 merged',
    pullRequest: { number: 1, state: 'merged' },
  });
  expect(byName.abandoned).toMatchObject({ willRemove: true, detail: 'PR #2 closed' });
  expect(byName.unsaved).toMatchObject({ willRemove: false, reason: 'dirty', pullRequest: { state: 'merged' } });
  expect(byName.wip).toMatchObject({
    willRemove: false,
    reason: 'unpushed',
    pullRequest: { state: 'closed', containsHead: false },
  });
  expect(byName.gone).toMatchObject({
    willRemove: false,
    reason: 'unpushed',
    pullRequest: { state: 'closed', containsHead: true },
  });
  expect(byName.noPr).toMatchObject({ willRemove: false, pullRequest: null, pullRequestUnknown: null });
  expect(ghCalls).toContainEqual([
    'pr',
    'list',
    '--head',
    'shipped',
    '--state',
    'all',
    '--limit',
    '20',
    '--json',
    'number,state,url,headRefOid,mergedAt,closedAt,isCrossRepository',
  ]);

  await captureLog(() => runGc({ delete: true }));
  expect(existsSync(worktrees.shipped!)).toBe(false);
  expect(existsSync(worktrees.abandoned!)).toBe(false);
  for (const name of ['unsaved', 'wip', 'gone', 'noPr']) expect(existsSync(worktrees[name]!)).toBe(true);
}, 120_000);

test('a signed-out or unresponsive gh is asked once per gc run, and every worktree says why', async () => {
  const { worktrees } = gitRepoWithWorktrees(['one', 'two']);
  for (const path of Object.values(worktrees)) upsertProject(path, { metroPort: null });
  const current = getExecutor();
  for (const [failure, reason] of [
    [{ status: 4 }, 'gh is not signed in; run `gh auth login`'],
    [{ code: 'ETIMEDOUT' }, 'gh pr list did not answer within 20s'],
  ] as const) {
    let calls = 0;
    setExecutor({
      ...current,
      findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : current.findExecutable(name)),
      runFile: (file, args, opts) => {
        if (file !== 'gh') return current.runFile(file, args, opts);
        calls++;
        throw Object.assign(new Error('gh failed'), failure);
      },
    });
    const { payload } = await gcJson({});
    expect(calls).toBe(1);
    expect(payload.sections.linkedWorktrees.map((w: { pullRequestUnknown: string }) => w.pullRequestUnknown)).toEqual([
      reason,
      reason,
    ]);
  }
}, 60_000);

test('worktree remove accepts local-only commits that a merged pull request holds, not a closed one', async () => {
  const { worktrees } = gitRepoWithWorktrees(['squashed', 'closed']);
  const git = (args: string, cwd: string) =>
    execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  const heads: Record<string, string> = {};
  for (const name of ['squashed', 'closed']) {
    writeFileSync(join(worktrees[name]!, 'change.txt'), name);
    git('add change.txt', worktrees[name]!);
    git(`commit -q -m ${name}`, worktrees[name]!);
    heads[name] = git('rev-parse HEAD', worktrees[name]!);
  }
  const state: Record<string, string> = { squashed: 'MERGED', closed: 'CLOSED' };
  const current = getExecutor();
  setExecutor({
    ...current,
    findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : current.findExecutable(name)),
    runFile: (file, args: string[], opts) => {
      if (file !== 'gh') return current.runFile(file, args, opts);
      const branch = args[args.indexOf('--head') + 1]!;
      const pull = { number: 7, url: 'https://github.com/o/r/pull/7', state: state[branch], headRefOid: heads[branch] };
      return JSON.stringify([{ ...pull, mergedAt: '2026-09-01T00:00:00Z', closedAt: '2026-09-01T00:00:00Z' }]);
    },
  });

  await captureLog(async () => {
    expect(await removeWorktreeTarget(worktrees.squashed)).toBe(true);
    expect(await removeWorktreeTarget(worktrees.closed)).toBe(false);
  });
  expect(existsSync(worktrees.squashed!)).toBe(false);
  expect(existsSync(worktrees.closed!)).toBe(true);
}, 60_000);

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

  process.exitCode = 0;
  const { payload } = await gcJson({ cache: 'workspaces', worktrees: true, delete: true });
  expect(payload).toEqual({ code: 'STIM_BAD_ARG', message: expect.any(String), remedy: expect.any(String) });
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

function repoWithMergedBranches() {
  const repo = join(projects, 'origin-repo');
  const remote = join(projects, 'origin.git');
  const upstream = join(projects, 'upstream');
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 });
  const identity = (cwd: string) => {
    git('config user.email test@example.com', cwd);
    git('config user.name test', cwd);
  };
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    git(`add ${file}`, cwd);
    git(`commit -q -m ${file}`, cwd);
  };
  git(`init -q --bare -b main "${remote}"`, projects);
  mkdirSync(repo);
  git('init -q -b main');
  identity(repo);
  git(`remote add origin "${remote}"`);
  commit(repo, 'package.json');
  git('push -q -u origin main');
  git('remote set-head origin main');
  const worktrees: Record<string, string> = {};
  for (const [name, commits] of [
    ['merged', 1],
    ['squashed', 2],
    ['rebased', 1],
    ['evil', 1],
    ['fresh', 0],
    ['open', 1],
    ['dirty', 1],
  ] as const) {
    const path = join(projects, name);
    git(`worktree add -q "${path}" -b ${name}`);
    for (let i = 0; i < commits; i++) commit(path, `${name}-${i}.txt`);
    if (commits) git(`push -q -u origin ${name}`, path);
    worktrees[name] = realpathSync.native(path);
  }
  const spaced = join(projects, 'spaced');
  git(`worktree add -q "${spaced}" -b spaced`);
  writeFileSync(join(spaced, 'value.txt'), 'ab  \n');
  git('add value.txt', spaced);
  git('commit -q -m spaced', spaced);
  git('push -q -u origin spaced', spaced);
  worktrees.spaced = realpathSync.native(spaced);
  const followup = join(projects, 'followup');
  git(`worktree add -q "${followup}" -b followup merged`);
  worktrees.followup = realpathSync.native(followup);
  const reused = join(projects, 'reused');
  git(`worktree add -q "${reused}" -b reused`);
  commit(reused, 'reused-earlier-life.txt');
  git(`worktree remove "${reused}"`);
  git(`worktree add -q -B reused "${reused}" merged`);
  worktrees.reused = realpathSync.native(reused);
  git(`clone -q "${remote}" "${upstream}"`, projects);
  identity(upstream);
  commit(upstream, 'main-moved-on.txt');
  git('push -q origin main', upstream);
  git('fetch -q origin main', worktrees.evil);
  git('merge -q --no-ff --no-commit origin/main', worktrees.evil);
  commit(worktrees.evil!, 'not-on-main.txt');
  git('merge -q --no-ff origin/merged -m merge-merged', upstream);
  git('merge -q --no-ff origin/dirty -m merge-dirty', upstream);
  git('merge -q --squash origin/squashed', upstream);
  git('commit -q -m squash-squashed', upstream);
  git('cherry-pick origin/rebased', upstream);
  git('cherry-pick origin/evil', upstream);
  writeFileSync(join(upstream, 'value.txt'), 'ab\n');
  git('add value.txt', upstream);
  git('commit -q -m value-without-the-trailing-spaces', upstream);
  git('push -q origin main', upstream);
  for (const gone of ['squashed', 'rebased', 'evil', 'spaced']) {
    git(`push -q origin --delete ${gone}`, upstream);
    git(`update-ref -d refs/remotes/origin/${gone}`);
  }
  writeFileSync(join(worktrees.dirty!, 'notes.txt'), 'wip');
  for (const path of Object.values(worktrees)) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path);
  }
  return { repo, remote, worktrees, git };
}

test('plain gc --delete removes merged worktrees, squash merges included, after fetching the default branch', async () => {
  const { repo, worktrees, git } = repoWithMergedBranches();

  const { payload } = await gcJson({});
  expect(payload.worktreeSweep).toBe(null);
  const byPath = Object.fromEntries(
    payload.sections.linkedWorktrees.map((w: { path: string }) => [realpathSync.native(w.path), w]),
  );
  expect(Object.keys(byPath).toSorted()).toEqual(Object.values(worktrees).toSorted());
  expect(byPath[worktrees.merged!]).toMatchObject({
    mergedInto: 'origin/main',
    willRemove: true,
    reason: null,
    detail: 'merged into origin/main',
  });
  expect(byPath[worktrees.squashed!]).toMatchObject({ willRemove: true, detail: 'merged into origin/main' });
  expect(byPath[worktrees.rebased!]).toMatchObject({ willRemove: true, detail: 'merged into origin/main' });
  for (const name of ['fresh', 'followup', 'reused']) {
    expect(byPath[worktrees[name]!]).toMatchObject({
      willRemove: false,
      reason: 'not-merged',
      detail: 'no commits of its own beyond origin/main',
    });
  }
  for (const name of ['evil', 'spaced']) {
    expect(byPath[worktrees[name]!]).toMatchObject({ willRemove: false, reason: 'unpushed', mergedInto: null });
  }
  expect(byPath[worktrees.open!]).toMatchObject({ willRemove: false, reason: 'not-merged' });
  expect(byPath[worktrees.dirty!]).toMatchObject({ willRemove: false, reason: 'dirty' });

  const output = await captureLog(() => runGc({ delete: true }));
  expect(output).toContain(`Removed the worktree ${worktrees.merged} (merged into origin/main)`);
  expect(output).toContain(`Removed the worktree ${worktrees.squashed} (merged into origin/main)`);
  for (const name of ['merged', 'squashed', 'rebased']) expect(existsSync(worktrees[name]!)).toBe(false);
  for (const name of ['fresh', 'followup', 'reused', 'evil', 'spaced', 'open', 'dirty']) {
    expect(existsSync(worktrees[name]!)).toBe(true);
  }
  expect(existsSync(join(repo, 'package.json'))).toBe(true);
  expect(git('branch --list squashed')).toContain('squashed');
  expect(process.exitCode).not.toBe(1);
}, 120_000);

test('gc keeps a merged worktree when the fetch fails, and when its HEAD moves after the report', async () => {
  const { repo, remote, worktrees, git } = repoWithMergedBranches();
  git('fetch -q origin');
  const stale = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(repo, '.git', 'FETCH_HEAD'), stale, stale);
  renameSync(remote, `${remote}.moved`);

  const { payload } = await gcJson({ delete: true });
  const merged = payload.sections.linkedWorktrees.find(
    (w: { path: string }) => realpathSync.native(w.path) === worktrees.merged,
  );
  expect(merged).toMatchObject({ willRemove: false, reason: 'merge-unknown' });
  expect(merged.detail).toMatch(/^merge state unknown: git fetch origin main failed/);
  expect(existsSync(worktrees.merged!)).toBe(true);

  renameSync(`${remote}.moved`, remote);
  const lines: string[] = [];
  const original = console.log;
  const originalError = console.error;
  console.error = () => {};
  console.log = (...args) => {
    lines.push(args.join(' '));
    if (String(args[0]).startsWith('Linked worktrees')) {
      writeFileSync(join(worktrees.merged!, 'late.txt'), 'x');
      git('add late.txt', worktrees.merged);
      git('commit -q -m late', worktrees.merged);
      git('push -q', worktrees.merged);
    }
  };
  try {
    await runGc({ delete: true });
  } finally {
    console.log = original;
    console.error = originalError;
  }
  expect(existsSync(worktrees.merged!)).toBe(true);
  expect(lines.join('\n')).toContain(`Kept the worktree ${worktrees.merged}: its HEAD moved since gc checked it`);
  expect(existsSync(worktrees.squashed!)).toBe(false);
}, 120_000);

test('gc --delete keeps a just-merged worktree for the grace period, then removes it and tears down its device', async () => {
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '120';
  const repo = join(projects, 'grace-repo');
  const remote = join(projects, 'grace.git');
  const upstream = join(projects, 'grace-upstream');
  const git = (args: string, cwd = repo, env: NodeJS.ProcessEnv = {}) =>
    execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    }).trim();
  const identity = (cwd: string) => {
    git('config user.email test@example.com', cwd);
    git('config user.name test', cwd);
  };
  git(`init -q --bare -b main "${remote}"`, projects);
  mkdirSync(repo);
  git('init -q -b main');
  identity(repo);
  git(`remote add origin "${remote}"`);
  writeFileSync(join(repo, 'package.json'), '{}');
  git('add package.json');
  git('commit -q -m init');
  git('push -q -u origin main');
  git('remote set-head origin main');
  git(`clone -q "${remote}" "${upstream}"`, projects);
  identity(upstream);
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000);
  const worktrees: Record<string, string> = {};
  for (const name of ['fresh', 'landed', 'old', 'booted']) {
    const path = join(projects, name);
    git(`worktree add -q "${path}" -b ${name}`);
    writeFileSync(join(path, `${name}.txt`), name);
    git(`add ${name}.txt`, path);
    git(`commit -q -m ${name}`, path);
    git(`push -q -u origin ${name}`, path);
    worktrees[name] = realpathSync.native(path);
    git(`fetch -q origin ${name}`, upstream);
    git(`merge -q --squash origin/${name}`, upstream);
    const date = name === 'fresh' || name === 'landed' ? {} : { GIT_COMMITTER_DATE: threeHoursAgo.toISOString() };
    git(`commit -q -m squash-${name}`, upstream, date);
    upsertProject(worktrees[name]!, { metroPort: null });
    recordWorkspaceUse(worktrees[name]!);
  }
  git('push -q origin main', upstream);
  upsertProject(worktrees.old!, { platforms: { ios: { deviceUdid: 'U-OLD', owned: true, deviceName: 'stim-old' } } });
  upsertProject(worktrees.booted!, {
    platforms: { ios: { deviceUdid: 'U-BOOTED', owned: true, deviceName: 'stim-booted' } },
  });
  recordCreatedDevice('ios', 'U-OLD');
  recordCreatedDevice('ios', 'U-BOOTED');
  for (const name of ['landed', 'old', 'booted']) {
    const path = worktrees[name]!;
    const gitDir = git('rev-parse --path-format=absolute --git-dir', path);
    for (const file of [join(gitDir, 'index'), join(gitDir, 'HEAD'), join(gitDir, 'logs', 'HEAD')]) {
      utimesSync(file, threeHoursAgo, threeHoursAgo);
    }
    const state = join(workspaceDir(path), 'state.json');
    utimesSync(state, threeHoursAgo, threeHoursAgo);
  }

  const real = getExecutor();
  const iphone = 'com.apple.CoreSimulator.SimDeviceType.iPhone-15';
  const simctl = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
        { udid: 'U-OLD', name: 'stim-old', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: iphone },
        { udid: 'U-BOOTED', name: 'stim-booted', state: 'Booted', isAvailable: true, deviceTypeIdentifier: iphone },
      ],
    },
  });
  const simctlCalls: string[] = [];
  const fake = (command: string) => {
    if (/simctl/.test(command)) simctlCalls.push(command);
    return /simctl list/.test(command) ? simctl : '';
  };
  setExecutor({
    ...real,
    run: fake,
    runQuiet: fake,
    runFile: (file, args = [], opts) =>
      file === 'git' ? real.runFile(file, args, opts) : fake([file, ...args].join(' ')),
    runFileQuiet: (file, args = [], opts) =>
      file === 'git' ? real.runFileQuiet(file, args, opts) : fake([file, ...args].join(' ')),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
    findExecutable: () => null,
  });

  const { payload } = await gcJson({ delete: true });
  const byPath = Object.fromEntries(payload.sections.linkedWorktrees.map((w: { path: string }) => [w.path, w]));
  expect(byPath[worktrees.fresh!]).toMatchObject({
    mergedInto: 'origin/main',
    willRemove: false,
    reason: 'recent-activity',
    eligibleAt: expect.any(String),
  });
  expect(Date.parse(byPath[worktrees.fresh!].eligibleAt) - Date.now()).toBeGreaterThan(119 * 60_000);
  expect(byPath[worktrees.landed!]).toMatchObject({ willRemove: false, reason: 'recent-activity' });
  expect(byPath[worktrees.landed!].detail).toMatch(
    /^recent activity: merged into origin\/main \S+ ago; removable after /,
  );
  expect(byPath[worktrees.booted!]).toMatchObject({ willRemove: false, reason: 'in-use' });
  expect(byPath[worktrees.booted!].detail).toContain('its owned simulator stim-booted is Booted');
  expect(byPath[worktrees.old!]).toMatchObject({ willRemove: true, reason: null, eligibleAt: null });

  for (const name of ['fresh', 'landed', 'booted']) expect(existsSync(worktrees[name]!)).toBe(true);
  expect(existsSync(worktrees.old!)).toBe(false);
  expect(getProject(worktrees.old!)).toBe(null);
  expect(simctlCalls).toContain('xcrun simctl shutdown U-OLD');
  expect(simctlCalls).toContain('xcrun simctl delete U-OLD');
  expect(simctlCalls.some((call) => /(shutdown|delete) U-BOOTED/.test(call))).toBe(false);
  expect(getProject(worktrees.booted!)?.platforms?.ios).toMatchObject({ deviceUdid: 'U-BOOTED', owned: true });
}, 120_000);

test('mergedAt is the merge commit date, also when the merged branch moved past the local HEAD', () => {
  const repo = join(projects, 'merge-time');
  const git = (args: string, env: NodeJS.ProcessEnv = {}) =>
    execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...env } }).trim();
  mkdirSync(repo);
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  git('commit -q --allow-empty -m init');
  git('checkout -q -b feature');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add a.txt');
  git('commit -q -m a');
  const localHead = git('rev-parse HEAD');
  writeFileSync(join(repo, 'b.txt'), 'b');
  git('add b.txt');
  git('commit -q -m b');
  git('checkout -q main');
  git('commit -q --allow-empty -m main-moved');
  git('merge -q --no-ff feature -m merge-feature', { GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' });
  git('commit -q --allow-empty -m after', { GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z' });
  git(`checkout -q -B feature ${localHead}`);

  expect(mergeState(repo, { ref: 'refs/heads/main', name: 'main' })).toMatchObject({
    merged: true,
    mergedAt: Date.parse('2026-01-02T03:04:05Z'),
  });
});

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
