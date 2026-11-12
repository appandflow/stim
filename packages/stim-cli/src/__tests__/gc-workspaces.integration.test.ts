import { execSync } from 'node:child_process';

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
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
import { basename, dirname, join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { deleteGcItem } from '../commands/gc/item.ts';
import * as maintenancePreview from '../stimd/passes/preview.ts';
import { collectWorkspaceLogs, trimWorkspaceLogs } from '../commands/gc/logs.ts';
import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';
import { removeWorktreeTarget } from '../commands/worktree.ts';
import { matchWorktreeEntry } from '../workspace/worktree.ts';
import * as agentSessions from '../agent-sessions.ts';
import { classifyStatusCaches, deleteStaleStatusCaches } from '../commands/gc/status-caches.ts';
import {
  classifyWorkspaceDirs,
  listWorkspaceDirs,
  planWorkspaceOutputs,
  collectOrphanedWorkspaces,
  collectWorkspaceOutputs,
} from '../commands/gc/workspaces.ts';
import {
  collectWorktreeSweep,
  worktreeRemovalReason,
  worktreeSkipReason,
  type WorktreeFacts,
} from '../commands/gc/worktrees.ts';
import { planWorktrees } from '../stimd/passes/sweep.ts';
import * as sweepPasses from '../stimd/passes/sweep.ts';
import * as maintenanceMeasure from '../stimd/passes/measure.ts';
import { runMaintenance } from '../stimd/passes/run.ts';
import { mergeState, type MergeState } from '../workspace/merge-state.ts';
import {
  parseRemoteRepo,
  selectPullRequest,
  type GhPullRequest,
  type PullRequestFact,
  type PullRequestLookup,
} from '../workspace/pull-request.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { register } from '../cache/cache-manifest.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceName } from '../workspace/paths.ts';
import { workspaceInUse, withIdleWorkspace } from '../workspace/in-use.ts';
import {
  clearArtifact,
  collectArtifacts,
  collectArtifactsAsync,
  artifactWorktrees,
  artifactWorktreesAsync,
} from '../stimd/passes/artifacts.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { withManagedRemoteWorktreeLock, withManagedTunnelLock } from '../engine/tunnel.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import {
  exclusiveClaimDir,
  tryAcquireClaim,
  releaseClaim,
  readClaimSet,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { recordDeferredShutdown } from '../devices/deferred-shutdown.ts';
import { registerCollector } from '../stimd/logs/state.ts';
import { LOG_ROTATE_BYTES, buildCacheRoot, withAmbientContext, withDirLock } from '@stim-cli/core';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import {
  diskUsageCacheFile,
  gitMergeCacheFile,
  maintenanceStateFile,
  pullRequestCacheFile,
  readMaintenanceState,
  worktreeArchiveRoot,
} from '@stim-cli/core/state';
import { liveClaimOwner, plantClaim, writeDerivedData } from './_factories.ts';
import { gcReportSections } from '../commands/gc/report.ts';

vi.mock('../devices/machine-cache-usage.ts', () => ({ getMachineCacheReport: async () => null }));

const logIo = vi.hoisted(
  (): {
    afterWrite?: (path: unknown) => void;
    afterRename?: (from: unknown, to: unknown) => void;
    afterRemove?: (path: unknown) => void;
    beforeRead?: (path: unknown) => Promise<void>;
  } => ({}),
);
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const result = fs.writeFileSync(...args);
      logIo.afterWrite?.(args[0]);
      return result;
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const result = fs.renameSync(...args);
      logIo.afterRename?.(...args);
      return result;
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      const result = fs.rmSync(...args);
      logIo.afterRemove?.(args[0]);
      return result;
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      await logIo.beforeRead?.(args[0]);
      return fs.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await fs.writeFile(...args);
      logIo.afterWrite?.(args[0]);
      return result;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const result = await fs.rename(...args);
      logIo.afterRename?.(...args);
      return result;
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const result = await fs.rm(...args);
      logIo.afterRemove?.(args[0]);
      return result;
    },
  };
});

// Each Git child of a removal starts Windows PowerShell 5.1 for its report job (#4103), about 0.5 s apiece.
const GIT_REMOVAL_TIMEOUT_MS = process.platform === 'win32' ? 240_000 : undefined;
let tmpHome: string;
let projects: string;
let scope: ReturnType<typeof vi.spyOn> | undefined;

function unscopedHome() {
  scope = vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
}

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '0';
  projects = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-projects-')));
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
  scope?.mockRestore();
  scope = undefined;
  logIo.afterWrite = undefined;
  logIo.afterRename = undefined;
  logIo.afterRemove = undefined;
  logIo.beforeRead = undefined;
  vi.unstubAllEnvs();
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

describe('residue-only workspace directories', () => {
  const entry = (residue: { projectRoot: string | null; empty?: boolean; blocked?: string | null }) => ({
    dir: `/h/workspaces/${residue.projectRoot ?? 'x'}`,
    projectRoot: null,
    problem: 'it has no workspace.json',
    residue: { empty: false, blocked: null, ...residue },
  });
  const classify = (entries: ReturnType<typeof entry>[], existing: string[] = []) =>
    classifyWorkspaceDirs(entries, {
      registryKeys: [],
      exists: (path) => existing.includes(path),
      isMounted: () => true,
      inUse: () => [],
    });

  test('residue naming a gone root is orphaned, and one naming an existing root is not', () => {
    expect(classify([entry({ projectRoot: '/w/gone' })]).orphaned).toMatchObject([
      { projectRoot: '/w/gone', residue: true },
    ]);
    expect(classify([entry({ projectRoot: '/w/here' })], ['/w/here'])).toEqual({ orphaned: [], skipped: [] });
  });

  test('empty residue with no root is orphaned, and non-empty residue with no root is skipped', () => {
    expect(classify([entry({ projectRoot: null, empty: true })]).orphaned).toMatchObject([
      { projectRoot: null, residue: true },
    ]);
    expect(classify([entry({ projectRoot: null })]).skipped[0]?.reason).toMatch(/name no project root/);
  });

  test('residue that is blocked stays skipped with the reason', () => {
    const result = classify([entry({ projectRoot: '/w/gone', blocked: 'it holds state.json' })]);
    expect(result.orphaned).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/it holds state\.json/);
  });
});

describe('workspace directories without workspace.json', () => {
  function husk(root: string, entries: Record<string, string> = {}, logRoot: string | null = root): string {
    const dir = join(tmpHome, 'workspaces', workspaceName(root));
    mkdirSync(dir, { recursive: true });
    if (logRoot !== null) {
      mkdirSync(join(dir, 'logs'));
      writeFileSync(join(dir, 'logs', 'maintenance.ndjson'), `${JSON.stringify({ workspace: logRoot })}\n`);
    }
    for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text);
    return dir;
  }

  test('a real metadata dir lock blocks workspace residue inspection while held', () => {
    const dir = husk(join(projects, 'held'));
    withDirLock(join(dir, 'metadata.lock'), () => {
      expect(listWorkspaceDirs().find((entry) => entry.dir === dir)?.residue?.blocked).toBe('metadata.lock is held');
    });
  });

  test('gc --delete removes the leftovers of a removed workspace and keeps everything else', async () => {
    const gone = husk(join(projects, 'gone'), { 'log-error-index.json': '{}' });
    const empty = husk(join(projects, 'empty'), {}, null);
    const live = join(projects, 'live');
    mkdirSync(live);
    const present = husk(live);
    const stateful = husk(join(projects, 'stateful'), { 'state.json': '{}' });
    const renamed = husk(join(projects, 'renamed'), {}, join(projects, 'other'));
    const held = husk(join(projects, 'held'));
    plantClaim(join(held, 'metadata.lock.claims'), 'exclusive', liveClaimOwner());
    const unnamed = husk(join(projects, 'unnamed'), { 'ended-agents.json': '{}' }, null);

    const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
    expect(payload.sections.orphanedWorkspaces.map((entry: { dir: string }) => entry.dir).toSorted()).toEqual(
      [gone, empty].toSorted(),
    );
    for (const dir of [gone, empty, present, stateful, renamed, held, unnamed]) expect(existsSync(dir)).toBe(true);

    await gcJson({ pressure: 'normal' });
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(empty)).toBe(false);
    for (const dir of [present, stateful, renamed, held, unnamed]) expect(existsSync(dir)).toBe(true);
  });
});

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

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

test.each(['orphan', 'output'] as const)(
  'cancelling a slow %s workspace scan leaves later metadata and bytes untouched',
  async (kind) => {
    const first = goneWorkspace('a-scan');
    const second = goneWorkspace('z-scan');
    for (const entry of [first, second]) {
      mkdirSync(join(entry.dir, 'derived-data'));
      writeFileSync(join(entry.dir, 'derived-data', 'original'), 'keep');
    }
    const markers = [first, second].map((entry) => join(entry.dir, 'workspace.json'));
    const originals = markers.map((file) => readFileSync(file, 'utf8'));
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads: unknown[] = [];
    logIo.beforeRead = async (path) => {
      if (!markers.includes(String(path))) return;
      reads.push(path);
      if (path === markers[0]) {
        entered();
        await gate;
      }
    };
    const controller = new AbortController();
    const operation = testContext({ signal: controller.signal });
    const result =
      kind === 'orphan'
        ? collectOrphanedWorkspaces([], ['/'], { measure: false, operation })
        : collectWorkspaceOutputs({
            olderThan: null,
            now: Date.now(),
            measure: false,
            signal: controller.signal,
            operation,
          });
    const reason = new Error('cancel workspace discovery');
    try {
      expect(await Promise.race([started.then(() => 'reading'), result.then(() => 'settled')])).toBe('reading');
      controller.abort(reason);
      release();
      await expect(result).rejects.toBe(reason);
      expect(reads).toEqual([markers[0]]);
      expect(markers.map((file) => readFileSync(file, 'utf8'))).toEqual(originals);
      for (const entry of [first, second])
        expect(readFileSync(join(entry.dir, 'derived-data', 'original'), 'utf8')).toBe('keep');
    } finally {
      controller.abort(reason);
      release();
      await result.catch(() => {});
      logIo.beforeRead = undefined;
    }
  },
);

test('gc reports an orphaned workspace directory and removes only the confirmed ones', async () => {
  const orphan = goneWorkspace('deleted-worktree');
  const busy = goneWorkspace('building-worktree');
  holdNativeRun(busy.root);
  const unresolved = join(tmpHome, 'workspaces', 'bare--0000000000000000');
  mkdirSync(join(unresolved, 'derived-data'), { recursive: true });

  const preview = (await gcJson({ dryRun: true, pressure: 'normal' })).payload;
  expect(preview.sections.orphanedWorkspaces).toEqual([
    { dir: orphan.dir, projectRoot: orphan.root, bytes: expect.any(Number) },
  ]);
  expect(preview.sections.skipped).toContainEqual(
    expect.objectContaining({ path: busy.dir, detail: expect.stringContaining('native-run.lock') }),
  );
  expect(existsSync(orphan.dir)).toBe(true);

  const { payload } = await gcJson({ pressure: 'normal' });
  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'remove-orphan', target: orphan.dir, outcome: 'done' }),
  );
  expect(existsSync(orphan.dir)).toBe(false);
  expect(existsSync(busy.dir)).toBe(true);
  expect(existsSync(unresolved)).toBe(true);
});

test('a gc dry run reports orphaned workspace directories and workspace build outputs with stable reasons', async () => {
  const orphan = goneWorkspace('deleted-worktree');
  const stale = builtWorkspace('stale', { usedDaysAgo: 10 });
  const busy = builtWorkspace('busy', { usedDaysAgo: 30 });
  holdNativeRun(busy.root);

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });

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
  expect(outputs[busy.root]).toMatchObject({
    willClear: false,
    reason: 'in-use',
    detail: expect.stringMatching(/^in use: /),
  });
  expect(existsSync(orphan.dir)).toBe(true);
  expect(existsSync(join(stale.dir, 'derived-data'))).toBe(true);
});

test('gc at high reports what it removed apart from what it kept', async () => {
  const orphan = goneWorkspace('deleted-worktree');
  const stale = builtWorkspace('stale', { usedDaysAgo: 10 });
  const busy = builtWorkspace('busy', { usedDaysAgo: 30 });
  holdNativeRun(busy.root);
  const claims = join(tmpHome, 'build-claims');
  plantClaim(claims, 'exclusive', liveClaimOwner(), { claimId: 'build-1' });
  const at = new Date().toISOString();
  writeWorkspaceState(busy.root, {
    activeBuild: {
      platform: 'ios',
      phase: 'compile',
      startedAt: at,
      phaseStartedAt: at,
      claim: { root: claims, claimId: 'build-1' },
    },
  });

  const preview = (await gcJson({ dryRun: true, pressure: 'high' })).payload;
  expect(preview.results).toEqual([]);
  expect(preview.actions).toContainEqual(
    expect.objectContaining({
      rung: 1,
      kind: 'delete-build-outputs',
      target: stale.root,
      outcome: 'would',
      bytes: expect.any(Number),
    }),
  );
  expect(
    preview.actions.find(
      (action: { kind: string; target: string }) =>
        action.kind === 'delete-build-outputs' && action.target === stale.root,
    ).bytes,
  ).toBeGreaterThan(0);
  for (const output of OUTPUTS) expect(existsSync(join(stale.dir, output))).toBe(true);
  const { payload } = await gcJson({ pressure: 'high' });

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
    ]),
  );
  expect(payload.results.filter((r: { status: string }) => r.status === 'failed')).toEqual([]);
  expect(payload.results.filter((r: { label: string }) => r.label === busy.root)).toEqual([]);
  for (const output of OUTPUTS) expect(existsSync(join(busy.dir, output))).toBe(true);
  expect(existsSync(orphan.dir)).toBe(false);
});

test('gc removes a symlinked orphaned workspace directory as a link and leaves its target', async () => {
  const orphan = goneWorkspace('linked-away');
  const target = join(projects, 'workspace-target');
  renameSync(orphan.dir, target);
  symlinkSync(target, orphan.dir, 'junction');

  await gcJson({ pressure: 'normal' });
  expect(existsSync(orphan.dir)).toBe(false);
  expect(existsSync(join(target, 'workspace.json'))).toBe(true);
  expect(existsSync(join(target, 'state.json'))).toBe(true);
});

test('clearing the build outputs of a symlinked workspace directory keeps the link', async () => {
  const { dir } = builtWorkspace('linked-outputs', { usedDaysAgo: 10 });
  const target = join(projects, 'outputs-target');
  renameSync(dir, target);
  symlinkSync(target, dir, 'junction');

  await deleteGcItem({ kind: 'workspace-outputs' });
  expect(existsSync(join(target, 'derived-data'))).toBe(false);
  expect(lstatSync(dir).isSymbolicLink()).toBe(true);
  expect(existsSync(join(dir, 'workspace.json'))).toBe(true);
});

test('gc keeps an orphan whose native run started after the plan', async () => {
  const orphan = goneWorkspace('raced');
  const plan = maintenancePreview.plannedMaintenance;
  let held = false;
  const spy = vi.spyOn(maintenancePreview, 'plannedMaintenance').mockImplementation(async (...args) => {
    const planned = await plan(...args);
    holdNativeRun(orphan.root);
    held = true;
    return planned;
  });
  try {
    await gcJson({ pressure: 'normal' });
  } finally {
    spy.mockRestore();
  }
  expect(held).toBe(true);
  expect(existsSync(join(orphan.dir, 'workspace.json'))).toBe(true);
});

describe('workspaceInUse', () => {
  test('an admitted cleanup refusal remains an operation failure instead of a skipped workspace', async () => {
    const { root } = goneWorkspace('cleanup-refusal');
    const claim = tryAcquireClaim({
      root: join(tmpHome, 'cleanup.claims'),
      mode: 'exclusive',
      label: 'fixture cleanup',
    }).acquired;
    if (!claim) throw new Error('The private fixture claim was not acquired');
    const failure = new WorkspaceProcessCleanupError(
      [claim],
      'Native cleanup is unresolved',
      'Verify the fixture child.',
    );
    const entered = join(tmpHome, 'entered-cleanup');
    try {
      await expect(
        withIdleWorkspace(
          root,
          () => {
            writeFileSync(entered, 'admitted');
            throw failure;
          },
          {
            purpose: 'fixture cleanup',
            supervisor: false,
            hosted: false,
            managedLocks: false,
          },
        ),
      ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', remedy: expect.stringContaining(claim.path) });
      expect(existsSync(entered)).toBe(true);
    } finally {
      releaseClaim(claim);
    }
  });

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

  test('a build lock that names no workspace does not mark every workspace in use, and gc reports it unresolved', async () => {
    const { root } = goneWorkspace('unknown');
    const lock = exclusiveClaimDir(join(tmpHome, 'build-locks', 'ios-unknown.lock'));
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'torn.claim'), '{');
    expect(workspaceInUse(root)).toEqual([]);
    const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
    expect(payload.sections.unresolvedBuildClaims).toContainEqual(
      expect.objectContaining({ kind: 'lock', path: expect.stringContaining('ios-unknown.lock') }),
    );
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
const MACOS_OUTPUTS = ['macos/build', 'macos/Sample.app', 'macos/staging-x'];
const OUTPUTS = ['derived-data', 'gradle-build', 'android-cas', 'cache-provider', 'js-swap-tmp', ...MACOS_OUTPUTS];

function builtWorkspace(
  name: string,
  { usedDaysAgo = 0, outputs = OUTPUTS }: { usedDaysAgo?: number; outputs?: readonly string[] } = {},
) {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  const dir = ensureWorkspaceStorage(root);
  for (const output of outputs) {
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
    nativeUsed: NaN,
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

  test('an age limit keeps a workspace used more recently, and one whose last use is unknown', () => {
    const [old, recent, unknown] = planWorkspaceOutputs(
      [entry(), entry({ lastUsed: now - 2 * DAY_MS }), entry({ lastUsed: NaN })],
      { olderThan: 3, now },
    );
    expect(old?.willClear).toBe(true);
    expect(recent).toMatchObject({ keptCode: 'recently-used', keptReason: 'used 2d ago, within 3 days' });
    expect(unknown).toMatchObject({ keptCode: 'last-use-unknown', keptReason: 'its last use is unknown' });
  });

  test('a workspace that ran ios, android or macos within 15 minutes keeps its outputs; an older run does not', () => {
    const [recent, older] = planWorkspaceOutputs(
      [entry({ nativeUsed: now - 14 * 60_000 }), entry({ nativeUsed: now - 16 * 60_000 })],
      { olderThan: null, now },
    );
    expect(recent).toMatchObject({ willClear: false, keptCode: 'recently-used' });
    expect(older?.willClear).toBe(true);
  });

  test('an unresolved workspace directory is never cleared', () => {
    const [unresolved] = planWorkspaceOutputs([entry({ projectRoot: null, problem: 'it has no workspace.json' })], {
      olderThan: null,
      now,
    });
    expect(unresolved).toMatchObject({ willClear: false, keptCode: 'unresolved' });
  });
});

test('the workspace-outputs item measures and clears macOS outputs while preserving runtime and workspace state', async () => {
  const { root, dir } = builtWorkspace('app', { usedDaysAgo: 1 });
  mkdirSync(join(dir, 'macos', 'runtime.lock'));
  writeFileSync(join(dir, 'macos', 'runtime.lock', 'marker'), 'runtime');
  mkdirSync(join(dir, 'macos', 'runtime.lock.claims'));
  mkdirSync(join(dir, 'macos', 'other'));
  writeFileSync(join(dir, 'macos', 'other', 'Nested.app'), 'keep');
  writeFileSync(join(dir, 'macos', 'staging-note'), 'keep');
  mkdirSync(join(root, '.build'));
  writeFileSync(join(root, '.build', 'blob'), 'project build');
  const cacheDir = join(projects, 'shared-cache');
  mkdirSync(join(cacheDir, 'entry'), { recursive: true });
  writeFileSync(join(cacheDir, 'entry', 'blob'), 'x'.repeat(4096));
  register({ dir: cacheDir, name: 'Shared cache' });

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  expect(payload.sections.workspaceBuildOutputs).toEqual([
    expect.objectContaining({ projectRoot: root, willClear: true, bytes: expect.any(Number) }),
  ]);
  expect(payload.sections.workspaceBuildOutputs[0].bytes).toBeGreaterThanOrEqual(OUTPUTS.length * 64 * 1024);

  await deleteGcItem({ kind: 'workspace-outputs' });
  for (const output of OUTPUTS) expect(existsSync(join(dir, output))).toBe(false);
  expect(statSync(join(dir, 'macos')).isDirectory()).toBe(true);
  expect(readFileSync(join(dir, 'macos', 'runtime.lock', 'marker'), 'utf8')).toBe('runtime');
  expect(existsSync(join(dir, 'macos', 'runtime.lock.claims'))).toBe(true);
  expect(readFileSync(join(dir, 'macos', 'other', 'Nested.app'), 'utf8')).toBe('keep');
  expect(readFileSync(join(dir, 'macos', 'staging-note'), 'utf8')).toBe('keep');
  expect(readFileSync(join(root, '.build', 'blob'), 'utf8')).toBe('project build');
  expect(existsSync(join(dir, 'workspace.json'))).toBe(true);
  expect(existsSync(join(dir, 'state.json'))).toBe(true);
  expect(existsSync(join(dir, 'logs', 'build-ios.ndjson'))).toBe(true);
  expect(getProject(root)?.platforms?.ios).toEqual({ deviceUdid: 'U-app', owned: true });
  expect(existsSync(join(cacheDir, 'entry', 'blob'))).toBe(true);
});

test.each(['running', 'building', 'unverified', 'claimed'])(
  'the workspace-outputs item keeps all outputs of a %s macOS session',
  async (session) => {
    const { root, dir } = builtWorkspace('macos-busy', { usedDaysAgo: 30 });
    const owner = { ...liveClaimOwner(), startedAtMicros: 1 };
    writeWorkspaceState(root, {
      macos: {
        launchId: 'test-launch',
        arguments: [],
        product: 'Sample',
        bundle: join(dir, 'macos', 'Sample.app'),
        bundleId: 'dev.sample.stim.test',
        executable: join(dir, 'macos', 'Sample.app', 'Contents', 'MacOS', 'Sample'),
        build: { state: session === 'building' ? 'running' : 'ok', startedAt: new Date().toISOString() },
        ...(session === 'running' || session === 'building' ? { supervisor: owner } : {}),
        ...(session === 'running' ? { app: owner } : {}),
        ...(session === 'unverified' ? { app: { ...owner, processToken: 'invalid' } } : {}),
      },
    });
    if (session === 'claimed') plantClaim(join(dir, 'macos', 'runtime.lock'), 'exclusive', liveClaimOwner());

    const { results } = await deleteGcItem({ kind: 'workspace-outputs' });
    expect(results).toContainEqual(expect.objectContaining({ kind: 'workspaceOutputs', status: 'kept', label: root }));
    for (const output of OUTPUTS) expect(existsSync(join(dir, output, 'nested', 'blob'))).toBe(true);
  },
);

test('the workspace-outputs item never follows a symlinked macos directory', async () => {
  const { dir } = builtWorkspace('macos-linked', { outputs: ['derived-data'] });
  const target = join(projects, 'macos-target');
  mkdirSync(join(target, 'build'), { recursive: true });
  writeFileSync(join(target, 'build', 'blob'), 'keep');
  symlinkSync(target, join(dir, 'macos'), 'junction');

  await deleteGcItem({ kind: 'workspace-outputs' });
  expect(existsSync(join(dir, 'derived-data'))).toBe(false);
  expect(lstatSync(join(dir, 'macos')).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(target, 'build', 'blob'), 'utf8')).toBe('keep');
});

test('gc lists, and the workspace-outputs item clears, a workspace with only macOS outputs', async () => {
  const { root, dir } = builtWorkspace('macos-only', { outputs: MACOS_OUTPUTS });

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  expect(payload.sections.workspaceBuildOutputs).toEqual([
    expect.objectContaining({ projectRoot: root, willClear: true, bytes: expect.any(Number) }),
  ]);
  expect(payload.sections.workspaceBuildOutputs[0].bytes).toBeGreaterThanOrEqual(3 * 64 * 1024);

  await deleteGcItem({ kind: 'workspace-outputs' });
  for (const output of MACOS_OUTPUTS) expect(existsSync(join(dir, output))).toBe(false);
  expect(existsSync(join(dir, 'workspace.json'))).toBe(true);
});

test('the workspace-outputs item clears idle workspaces and keeps one in use', async () => {
  const recent = builtWorkspace('recent', { usedDaysAgo: 1 });
  const stale = builtWorkspace('stale', { usedDaysAgo: 10 });
  const busy = builtWorkspace('busy', { usedDaysAgo: 30 });
  holdNativeRun(busy.root);

  const { results } = await deleteGcItem({ kind: 'workspace-outputs' });
  for (const output of OUTPUTS) {
    expect(existsSync(join(stale.dir, output))).toBe(false);
    expect(existsSync(join(recent.dir, output))).toBe(false);
    expect(existsSync(join(busy.dir, output))).toBe(true);
  }
  expect(results).toContainEqual(
    expect.objectContaining({ kind: 'workspaceOutputs', status: 'kept', label: busy.root }),
  );
});

test('gc at high leaves a workspace whose dev server runs, and the workspace-outputs item lightens it, but never a building or just-built one, or the build cache', async () => {
  const iosBuild = (minutesAgo: number) => ({
    lastIosBuild: {
      platform: 'ios',
      status: 'success',
      startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      durationMs: 0,
    },
  });
  const active = builtWorkspace('active');
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: active.root });
  writeFileSync(join(active.root, '.gitignore'), 'ios/build/\nandroid/\n.build/*\n!.build/keep\n.dd/\nbuild-device/\n');
  writeDerivedData(join(active.root, '.dd'));
  writeDerivedData(join(active.root, 'build-device'));
  mkdirSync(join(active.root, 'android', 'app', '.cxx'), { recursive: true });
  writeFileSync(join(active.root, 'android', 'app', '.cxx', 'blob'), 'cmake');
  mkdirSync(join(active.root, '.build'));
  writeFileSync(join(active.root, '.build', 'keep'), 'untracked, not ignored');
  mkdirSync(join(active.root, 'ios', 'build', 'rncore-facades'), { recursive: true });
  writeFileSync(join(active.root, 'ios', 'build', 'rncore-facades', 'React-Core.podspec.json'), 'pod install output');
  mkdirSync(join(active.root, 'android', 'app', 'build'), { recursive: true });
  writeFileSync(join(active.root, 'android', 'app', 'build', 'blob'), 'regenerable');
  mkdirSync(join(active.root, 'android', 'build'), { recursive: true });
  writeFileSync(join(active.root, 'android', 'build', 'tracked'), 'committed');
  execSync('git add .gitignore && git add -f android/build/tracked && git commit -qm init', { cwd: active.root });
  writeWorkspaceState(active.root, { supervisor: { ...liveClaimOwner(), port: 8100 }, ...iosBuild(60) });
  expect(workspaceInUse(active.root).join('\n')).toMatch(/supervisor \(pid \d+\) is running/);
  const building = builtWorkspace('building');
  holdNativeRun(building.root);
  const recent = builtWorkspace('recent');
  writeWorkspaceState(recent.root, iosBuild(5));
  const artifact = join(buildCacheRoot(), 'app-ios-key', 'App.app');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, 'binary'), 'artifact');

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  expect(
    payload.sections.workspaceBuildOutputs.find((w: { projectRoot: string }) => w.projectRoot === active.root),
  ).toMatchObject({
    willClear: true,
    inTreeDirs: expect.arrayContaining([
      join(active.root, 'android', 'app', 'build'),
      join(active.root, 'android', 'app', '.cxx'),
      join(active.root, '.dd'),
    ]),
  });

  await gcJson({ pressure: 'high' });
  for (const output of OUTPUTS) expect(existsSync(join(active.dir, output))).toBe(true);
  expect(existsSync(join(active.root, 'android', 'app', 'build'))).toBe(true);
  expect(existsSync(join(active.root, '.dd'))).toBe(true);

  const { results } = await deleteGcItem({ kind: 'workspace-outputs' });
  for (const output of OUTPUTS) {
    expect(existsSync(join(active.dir, output))).toBe(false);
    expect(existsSync(join(building.dir, output))).toBe(true);
    expect(existsSync(join(recent.dir, output))).toBe(true);
  }
  expect(existsSync(join(active.root, 'android', 'app', 'build'))).toBe(false);
  expect(existsSync(join(active.root, 'android', 'app', '.cxx'))).toBe(false);
  expect(existsSync(join(active.root, '.dd'))).toBe(false);
  expect(existsSync(join(active.root, 'build-device', 'Build'))).toBe(true);
  expect(existsSync(join(active.root, 'ios', 'build', 'rncore-facades', 'React-Core.podspec.json'))).toBe(true);
  expect(readFileSync(join(active.root, 'android', 'build', 'tracked'), 'utf8')).toBe('committed');
  expect(readFileSync(join(active.root, '.build', 'keep'), 'utf8')).toBe('untracked, not ignored');
  expect(readFileSync(join(artifact, 'binary'), 'utf8')).toBe('artifact');
  expect(results).toContainEqual(
    expect.objectContaining({ kind: 'workspaceOutputs', status: 'done', label: active.root }),
  );
  for (const root of [building.root, recent.root])
    expect(results).toContainEqual(expect.objectContaining({ kind: 'workspaceOutputs', status: 'kept', label: root }));
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
  writeFileSync(file, `${line.repeat(Math.ceil((2 * LOG_ROTATE_BYTES + 64 * 1024) / line.length))}{"msg":"last"}\n`);
}

test.each(['before replacement', 'after replacement'])(
  'log trim cancellation %s keeps later logs and releases its claims',
  async (boundary) => {
    const workspace = loggedWorkspace('cancel-trim');
    const first = join(workspace.logs, 'metro.ndjson');
    const later = join(workspace.logs, 'client.ndjson');
    oversizedLog(first);
    oversizedLog(later);
    const original = readFileSync(first);
    const laterOriginal = readFileSync(later);
    const report = await collectWorkspaceLogs();
    const controller = new AbortController();
    const reason = new Error('cancel log trim');
    logIo.afterWrite = (file) => {
      if (
        boundary === 'before replacement' &&
        dirname(String(file)) === workspace.logs &&
        String(file).endsWith('.tmp')
      )
        controller.abort(reason);
    };
    logIo.afterRename = (_from, to) => {
      if (boundary === 'after replacement' && String(to) === first) controller.abort(reason);
    };
    await expect(trimWorkspaceLogs(report, undefined, testContext({ signal: controller.signal }))).rejects.toBe(reason);
    const kept = readFileSync(first);
    expect(kept.equals(original)).toBe(boundary === 'before replacement');
    expect(kept.length <= LOG_ROTATE_BYTES).toBe(boundary === 'after replacement');
    expect(kept.toString().endsWith('{"msg":"last"}\n')).toBe(true);
    expect(readFileSync(later).equals(laterOriginal)).toBe(true);
    expect(readdirSync(workspace.logs).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
    for (const root of [join(workspaceDir(workspace.root), 'native-run.lock'), `${first}.lock.claims`]) {
      const claims = readClaimSet(root);
      expect(claims.live).toEqual([]);
      expect(claims.unresolved).toEqual([]);
    }
  },
);

test('gc reports the logs of every workspace, and trims oversized capped logs of idle workspaces', async () => {
  const quiet = loggedWorkspace('quiet');
  writeFileSync(join(quiet.logs, 'metro.ndjson'), '{}\n');
  const big = loggedWorkspace('big');
  oversizedLog(join(big.logs, 'device.ndjson'));
  oversizedLog(join(big.logs, 'metro.ndjson.1'));
  const rotated = `${'x'.repeat(LOG_ROTATE_BYTES + LOG_ROTATE_BYTES / 16)}\n`;
  writeFileSync(join(quiet.logs, 'device.ndjson.1'), rotated);
  oversizedLog(join(big.logs, 'build-ios.ndjson'));
  const busy = loggedWorkspace('busy');
  oversizedLog(join(busy.logs, 'device.ndjson'));
  holdNativeRun(busy.root);
  const collecting = loggedWorkspace('collecting');
  oversizedLog(join(collecting.logs, 'device.ndjson'));
  registerCollector(collecting.root, 'ios', { pid: 1 });

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  const byRoot = Object.fromEntries(
    payload.sections.workspaceLogs.map((w: { projectRoot: string }) => [w.projectRoot, w]),
  );
  expect(byRoot[quiet.root]).toMatchObject({ bytes: 3 + rotated.length, trimBytes: 0, willTrim: false, reason: null });
  expect(byRoot[big.root]).toMatchObject({ willTrim: true, reason: null });
  expect(byRoot[big.root].trimBytes).toBeGreaterThan(0);
  expect(byRoot[big.root].bytes).toBeGreaterThan(3 * LOG_ROTATE_BYTES);
  expect(byRoot[busy.root]).toMatchObject({ willTrim: false, reason: 'in-use' });
  expect(byRoot[collecting.root]).toMatchObject({ willTrim: false, reason: 'collector' });
  expect(payload.actionable).toBe(true);

  const longAgo = new Date(Math.floor((Date.now() - 30 * DAY_MS) / 1000) * 1000);
  utimesSync(join(big.logs, 'device.ndjson'), longAgo, longAgo);
  const buildBytes = statSync(join(big.logs, 'build-ios.ndjson')).size;
  const acted = (await gcJson({ pressure: 'normal' })).payload;
  expect(acted.actions).toContainEqual(
    expect.objectContaining({ kind: 'trim-workspace-logs', workspace: big.root, outcome: 'done' }),
  );
  for (const name of ['device.ndjson', 'metro.ndjson.1']) {
    const text = readFileSync(join(big.logs, name), 'utf8');
    expect(text.length).toBeLessThanOrEqual(LOG_ROTATE_BYTES);
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('{"msg":"last"}\n')).toBe(true);
  }
  expect(statSync(join(big.logs, 'build-ios.ndjson')).size).toBe(buildBytes);
  expect(statSync(join(big.logs, 'device.ndjson')).mtimeMs).toBe(longAgo.getTime());
  expect(statSync(join(quiet.logs, 'device.ndjson.1')).size).toBe(rotated.length);
  expect(statSync(join(busy.logs, 'device.ndjson')).size).toBeGreaterThan(LOG_ROTATE_BYTES);
  expect(statSync(join(collecting.logs, 'device.ndjson')).size).toBeGreaterThan(LOG_ROTATE_BYTES);
});

test.skipIf(process.platform === 'win32')(
  'a workspace whose project root is on an unmounted volume keeps its build outputs (macOS /Volumes; skipped on win32)',
  async () => {
    const root = '/Volumes/StimTestVolumeThatDoesNotExist/offline-app';
    const dir = ensureWorkspaceStorage(root);
    mkdirSync(join(dir, 'derived-data', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'derived-data', 'nested', 'blob'), 'x');
    upsertProject(root, { metroPort: 8100 });

    await gcJson({ pressure: 'normal' });
    await deleteGcItem({ kind: 'workspace-outputs' });
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
  const noOwnCommits: MergeState = {
    merged: false,
    unknown: false,
    detail: 'no commits of its own beyond origin/main',
    noOwnCommits: true,
  };
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

  test('a merged worktree the scoped home does not list is kept', () => {
    const facts = linked({ idleDays: 0, merge: merged() });
    expect(worktreeSkipReason({ ...facts, unregistered: true }, null)).toMatchObject({ code: 'not-registered' });
    expect(worktreeSkipReason({ ...facts, unregistered: false }, null)).toBe(null);
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
    ['pinned', linked({ pinned: true, merge: merged() }), 'pinned'],
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

  test('a dirty finished worktree is removable when its changes can be archived and nothing else keeps it', () => {
    const dirty = { porcelain: ['?? notes.txt'], archiveDirty: true };
    const notMerged: MergeState = { merged: false, unknown: false, detail: 'not merged into origin/main' };
    const idle = { activity: { at: 0, basis: 'a git index write' } };
    expect(worktreeSkipReason(linked({ ...dirty, merge: merged() }), null)).toBe(null);
    expect(worktreeSkipReason(linked({ ...dirty, merge: notMerged }), null)?.code).toBe('dirty');
    expect(
      worktreeSkipReason(linked({ ...dirty, ...idle, merge: noOwnCommits }), null, { ms: 0, now: DAY_MS }, 60_000)
        ?.code,
    ).toBe('dirty');
    expect(worktreeSkipReason(linked({ ...dirty, merge: merged(), unpushed: ['abc wip'] }), null)?.code).toBe('dirty');
    expect(worktreeSkipReason(linked({ ...dirty, merge: merged(), locked: true }), null)?.code).toBe('locked');
    expect(
      worktreeSkipReason(linked({ ...dirty, merge: merged(), inUse: ['it holds the running stim (/w/cli.mjs)'] }), null)
        ?.code,
    ).toBe('in-use');
    expect(
      worktreeRemovalReason(
        { merge: merged(), pullRequest: null, idleDays: 0, activity: null, dirty: 2 },
        { now: 0, noOwnCommitsIdleMs: null },
      ),
    ).toBe('merged into origin/main, 2 uncommitted files archived first');
  });

  test('pod install churn alone does not keep a worktree', () => {
    expect(
      worktreeSkipReason(linked({ porcelain: [' M ios/Podfile.lock', ' M ios/App.xcodeproj/project.pbxproj'] }), 7),
    ).toBe(null);
  });

  test('watchman cookies alone do not keep a worktree', () => {
    expect(
      worktreeSkipReason(
        linked({ porcelain: ['?? .watchman-cookie-host-1-2', '?? apps/m/.watchman-cookie-h-3-4'] }),
        7,
      ),
    ).toBe(null);
  });

  test('a watchman cookie beside another untracked file still keeps the worktree', () => {
    expect(worktreeSkipReason(linked({ porcelain: ['?? .watchman-cookie-host-1-2', '?? notes.txt'] }), 7)?.code).toBe(
      'dirty',
    );
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
    ['an unchecked submodule state', linked({ submodules: null }), 'submodules', /could not be checked/],
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
        draft: false,
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
      expect(skip).toEqual({ code: 'dirty', text: 'dirty: 2 uncommitted or untracked files (a.ts, b.ts)' });
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

  describe('a worktree with no commits of its own beyond the default branch', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const days = (n: number) => ({ at: now - n * DAY_MS, basis: 'a git index write' });
    const facts = (overrides: Partial<WorktreeFacts>) => linked({ idleDays: null, merge: noOwnCommits, ...overrides });

    test('without --worktrees, is removable once its activity is older than the idle window, unless a pull request is open', () => {
      const open: PullRequestLookup = {
        pullRequest: {
          number: 12,
          state: 'open',
          draft: false,
          url: 'https://github.com/o/r/pull/12',
          head: 'abc',
          containsHead: true,
          endedAt: null,
        },
      };
      const window = 2 * 60 * 60_000;
      const grace = { ms: 0, now };
      const hourAgo = { at: now - 60 * 60_000, basis: 'a git index write' };
      expect(worktreeSkipReason(facts({ activity: days(1) }), null, grace, window)).toBe(null);
      expect(worktreeSkipReason(facts({ activity: hourAgo }), null, grace, window)?.code).toBe('recent-activity');
      expect(worktreeSkipReason(facts({ activity: days(1), pullRequest: open }), null, grace, window)?.code).toBe(
        'not-merged',
      );
      expect(
        worktreeRemovalReason(
          { merge: noOwnCommits, pullRequest: null, idleDays: null, activity: days(1) },
          { now, noOwnCommitsIdleMs: window },
        ),
      ).toBe('no commits of its own beyond origin/main, idle 1d');
    });

    test('with --worktrees, its recorded Stim use still decides first', () => {
      expect(worktreeSkipReason(facts({ idleDays: 2, activity: days(30) }), 7, { ms: 0, now })?.code).toBe(
        'recently-used',
      );
    });

    test('a worktree with commits of its own and no recorded Stim use is not idle by activity', () => {
      const own = linked({
        idleDays: null,
        activity: days(30),
        merge: { merged: false, unknown: false, detail: 'not merged into origin/main' },
      });
      expect(worktreeSkipReason(own, 7, { ms: 0, now })?.code).toBe('last-use-unknown');
    });

    test('is removed with a reason that names it', () => {
      expect(
        worktreeRemovalReason(
          {
            merge: noOwnCommits,
            pullRequest: null,
            idleDays: null,
            activity: days(9),
          },
          { now, noOwnCommitsIdleMs: null },
        ),
      ).toBe('no commits of its own beyond origin/main, idle 9d');
      const reason = (candidate: Partial<Parameters<typeof worktreeRemovalReason>[0]>, idleMs: number | null) =>
        worktreeRemovalReason(
          { merge: noOwnCommits, pullRequest: null, idleDays: null, activity: null, ...candidate },
          { now, noOwnCommitsIdleMs: idleMs },
        );
      expect(reason({ idleDays: 12 }, null)).toBe('no commits of its own beyond origin/main, idle 12d');
      expect(reason({ idleDays: 0, activity: { at: now - 12 * 60_000, basis: 'a git index write' } }, 600_000)).toBe(
        'no commits of its own beyond origin/main, inactive for 12m',
      );
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

    test('decides a worktree with no commits of its own by its activity, and never without it', () => {
      const ownless = linked({ idleDays: 0, merge: noOwnCommits, activity: activity(30) });
      const off = { ms: 0, now };
      expect(worktreeSkipReason(ownless, null, off, 10 * 60_000)).toBe(null);
      expect(worktreeSkipReason(ownless, null, off, 60 * 60_000)).toMatchObject({
        code: 'recent-activity',
        eligibleAt: ago(30) + 60 * 60_000,
      });
      expect(worktreeSkipReason({ ...ownless, activity: null }, null, off, 10 * 60_000)?.code).toBe('activity-unknown');
      expect(worktreeSkipReason(ownless, null, { ms: 10 * 60_000, now })?.code).toBe('not-merged');
      const notMerged = linked({ merge: { merged: false, unknown: false, detail: 'not merged into origin/main' } });
      expect(worktreeSkipReason(notMerged, null, off, 10 * 60_000)?.code).toBe('not-merged');
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

  test("a pull request unrelated to HEAD, or from a stranger's fork that reuses the branch name, is ignored", () => {
    expect(selectPullRequest([gh(4, 'MERGED', 'unrelated')], 'head', isAncestor)).toBe(null);
    expect(selectPullRequest([{ ...gh(5, 'MERGED', 'head'), isCrossRepository: true }], 'head', isAncestor)).toBe(null);
    const foreignFork = {
      ...gh(6, 'OPEN', 'head'),
      isCrossRepository: true,
      headRepository: { name: 'r' },
      headRepositoryOwner: { login: 'stranger' },
    };
    expect(selectPullRequest([foreignFork], 'head', isAncestor, new Set(['me/r']))).toBe(null);
  });

  test("a pull request from the checkout's own fork is accepted", () => {
    const ownFork = {
      ...gh(7, 'OPEN', 'head'),
      isCrossRepository: true,
      headRepository: { name: 'r' },
      headRepositoryOwner: { login: 'Me' },
    };
    expect(selectPullRequest([ownFork], 'head', isAncestor, new Set(['me/r']))).toMatchObject({ number: 7 });
    expect(selectPullRequest([ownFork], 'head', isAncestor)).toBe(null);
  });

  test('a cross-repository pull request with no head repository data (a deleted fork) is ignored', () => {
    const deletedFork = { ...gh(8, 'OPEN', 'head'), isCrossRepository: true };
    expect(selectPullRequest([deletedFork], 'head', isAncestor, new Set(['me/r']))).toBe(null);
  });
});

describe('parsing a repository out of a git remote URL', () => {
  test.each([
    ['https://github.com/janicduplessis/expo.git', 'janicduplessis/expo'],
    ['https://github.com/janicduplessis/expo', 'janicduplessis/expo'],
    ['https://x-access-token:abc123@github.com/Janic/Expo.git', 'janic/expo'],
    ['git@github.com:janicduplessis/expo.git', 'janicduplessis/expo'],
    ['ssh://git@github.com/janicduplessis/expo.git', 'janicduplessis/expo'],
    ['https://github.com/janicduplessis/expo.git/', 'janicduplessis/expo'],
  ])('parses %s as %s', (url, repo) => {
    expect(parseRemoteRepo(url)).toBe(repo);
  });

  test.each([['not-a-url'], [''], ['https://github.com/onlyowner']])('rejects %s', (url) => {
    expect(parseRemoteRepo(url)).toBe(null);
  });
});

function gitRepoWithWorktrees(names: string[], repoName = 'repo', files: Record<string, string> = {}) {
  const repo = join(projects, repoName);
  const remote = join(projects, `${repoName}-remote.git`);
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 });
  git(`init -q --bare -b main "${remote}"`, projects);
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  git(`remote add origin "${remote}"`);
  writeFileSync(join(repo, 'package.json'), '{}');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
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
  return { repo, remote, worktrees, git };
}

function repoWithTwoBranches({ registerWorktrees = true }: { registerWorktrees?: boolean } = {}) {
  const { repo, remote, worktrees, git } = gitRepoWithWorktrees(['merged', 'open'], 'repo', {
    '.gitignore': '.claude/\n',
  });
  git('remote set-head origin --auto');
  for (const [name, path] of Object.entries(worktrees)) {
    writeFileSync(join(path, `${name}.txt`), name);
    git(`add ${name}.txt`, path);
    git(`commit -q -m ${name}`, path);
    git(`push -q -u origin ${name}`, path);
  }
  for (const path of registerWorktrees ? Object.values(worktrees) : [repo]) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path);
  }
  const upstream = join(projects, 'upstream');
  git(`clone -q "${remote}" "${upstream}"`, projects);
  git('config user.email test@example.com', upstream);
  git('config user.name test', upstream);
  git('merge -q --no-ff origin/merged -m merge-merged', upstream);
  git('push -q origin HEAD', upstream);
  return { repo, remote, worktrees, git, upstream };
}

function killIfSame(target: { pid: number; processToken: string }): void {
  if (inspectProcessIdentity(target) !== 'same') return;
  try {
    process.kill(target.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

test.each(['remove', 'branch delete', 'pod restore'] as const)(
  'unverifiable Git cleanup during %s retains the actual worktree removal claims',
  async (phase) => {
    const { repo, worktrees } = gitRepoWithWorktrees(
      ['cleanup-refusal'],
      'repo',
      phase === 'pod restore' ? { 'ios/Podfile.lock': 'original' } : {},
    );
    const path = worktrees['cleanup-refusal'];
    if (!path) throw new Error('The fixture worktree is missing');
    if (phase === 'pod restore') writeFileSync(join(path, 'ios', 'Podfile.lock'), 'pod churn');
    upsertProject(path, { metroPort: null, worktreeBranch: 'cleanup-refusal', worktreeBranchOwned: true });
    resetExecutor();
    const executor = getExecutor();
    const original = executor.runFileAsync.bind(executor);
    const controller = new AbortController();
    const operation = testContext({ cwd: repo, projectRoot: repo, signal: controller.signal });
    let owned: { pid: number; processToken: string } | undefined;
    const targets: { pid: number; processToken: string }[] = [];
    let handles: ClaimHandle[] = [];
    let closed: Promise<void> = Promise.resolve();
    const inspect = vi
      .spyOn(identities, 'inspectProcessIdentity')
      .mockImplementation((record) =>
        owned && record?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(record),
      );
    const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
      const wanted =
        file === 'git' &&
        (phase === 'remove'
          ? args.includes('worktree') && args.includes('remove')
          : phase === 'pod restore'
            ? args.includes('checkout')
            : args.includes('update-ref') && args.includes('-d'));
      if (!wanted) return file === 'git' ? original(file, args, options) : Promise.resolve('');
      return original(
        process.execPath,
        ['-e', 'console.log(JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000)'],
        {
          ...options,
          onSpawn: (child) => {
            options.onSpawn?.(child);
            const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
            if (child.pid === undefined || !birth?.ok) throw new Error('The fixture Git child has no identity');
            owned = { pid: child.pid, processToken: birth.token };
            targets.push(owned);
            handles = [...operationState(operation).declaring];
            closed = new Promise<void>((resolve) => child.once('close', resolve));
            child.stdout?.once('data', (data) => {
              const metadata = JSON.parse(String(data));
              for (const pid of process.platform === 'win32' ? [metadata.pid, metadata.parent] : [metadata.pid]) {
                if (targets.some((record) => record.pid === pid)) continue;
                const captured = captureProcessIdentity(pid);
                if (!captured.ok) throw new Error(captured.reason);
                targets.push({ pid, processToken: captured.token });
              }
              controller.abort(new Error('cancel worktree removal'));
            });
          },
        },
      );
    });
    const output = { error: () => {}, fail: () => {} };
    try {
      await expect(
        withAmbientContext(operation, () => removeWorktreeTarget(path, { operation, output })),
      ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      if (!owned) throw new Error('The controlled Git mutation did not start');
      expect(inspectProcessIdentity(owned)).toBe('same');
      for (const handle of handles)
        expect(readClaimSet(handle.root).live).toMatchObject([{ child: { pid: owned.pid } }]);
      await expect(withManagedRemoteWorktreeLock(path, async () => {}, { waitMs: 0 })).rejects.toMatchObject({
        code: 'STIM_LOCK_REFUSED',
      });
      await expect(withManagedTunnelLock(path, async () => {}, { waitMs: 0 })).rejects.toMatchObject({
        code: 'STIM_LOCK_REFUSED',
      });
      expect(existsSync(path)).toBe(phase !== 'branch delete');
    } finally {
      inspect.mockRestore();
      probe.mockRestore();
      controller.abort();
      for (const target of targets.toReversed()) killIfSame(target);
      await closed;
      for (const target of targets) expect(await waitForProcessExit(target, 5000)).toBe(true);
      for (const handle of handles) releaseClaim(handle);
    }
  },
  GIT_REMOVAL_TIMEOUT_MS,
);

test(
  'removing the invoking worktree finishes branch cleanup from a surviving checkout',
  async () => {
    const { repo, worktrees } = gitRepoWithWorktrees(['invoking']);
    const path = worktrees.invoking;
    if (!path) throw new Error('The fixture worktree is missing');
    upsertProject(path, { metroPort: null, worktreeBranch: 'invoking', worktreeBranchOwned: true });
    resetExecutor();
    const executor = getExecutor();
    const real = executor.runFileAsync.bind(executor);
    const probe = vi
      .spyOn(executor, 'runFileAsync')
      .mockImplementation((file, args, options) => (file === 'git' ? real(file, args, options) : Promise.resolve('')));
    const operation = testContext({ cwd: path, projectRoot: path });
    const fail = vi.fn<() => void>();
    try {
      expect(
        await withAmbientContext(operation, () =>
          removeWorktreeTarget(path, { operation, output: { error: () => {}, fail } }),
        ),
      ).toBe(true);
      expect(fail).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);
      expect(getProject(path)).toBe(null);
      expect(execSync('git for-each-ref refs/heads/invoking', { cwd: repo, encoding: 'utf8' }).trim()).toBe('');
    } finally {
      probe.mockRestore();
    }
  },
  GIT_REMOVAL_TIMEOUT_MS,
);

function answerGh(pullsOf: (branch: string) => object[], calls: { cwd?: string; args: string[] }[] = []) {
  const current = getExecutor();
  setExecutor({
    ...current,
    findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : current.findExecutable(name)),
    runFile: (file, args: string[], opts) => {
      if (file !== 'gh') return current.runFile(file, args, opts);
      calls.push({ cwd: opts?.cwd, args });
      return JSON.stringify(pullsOf(args[args.indexOf('--head') + 1]!));
    },
    runFileAsync: async (file, args: string[], opts) => {
      if (file !== 'gh') return current.runFileAsync(file, args, opts);
      calls.push({ cwd: opts?.cwd, args });
      const fields = args.flatMap((arg) => {
        const variable = /^(b\d+)=(.*)$/s.exec(arg);
        return variable ? [[variable[1], { nodes: pullsOf(variable[2]!) }]] : [];
      });
      return JSON.stringify({ data: { repository: Object.fromEntries(fields) } });
    },
  });
  return calls;
}

test.each([
  ['status', 'status-unreadable', /could not be read/],
  ['--not', 'unpushed-unchecked', /could not be checked/],
  ['--stage', 'submodules', /could not be checked/],
])(
  'gc keeps an idle worktree whose %s check times out and says it could not run',
  async (marker, reason, detail) => {
    const { repo, worktrees } = gitRepoWithWorktrees(['slow']);
    if (!worktrees.slow) throw new Error('missing slow worktree');
    const slow = realpathSync.native(worktrees.slow);
    upsertProject(slow, { metroPort: null });
    recordWorkspaceUse(slow, new Date(Date.now() - 10 * DAY_MS));
    upsertProject(repo, { metroPort: null });
    const real = getExecutor();
    setExecutor({
      ...real,
      runFile: (file, args: string[], opts) => {
        if (file === 'git' && args.includes(slow) && args.includes(marker)) {
          throw Object.assign(new Error(`Command timed out after 60000ms: git ${args.join(' ')}`), {
            code: 'ETIMEDOUT',
          });
        }
        return real.runFile(file, args, opts);
      },
      runFileAsync: async (file, args: string[], opts) => {
        if (file === 'git' && args.includes(slow) && args.includes(marker)) {
          throw Object.assign(new Error(`Command timed out after 60000ms: git ${args.join(' ')}`), {
            code: 'ETIMEDOUT',
          });
        }
        return real.runFileAsync(file, args, opts);
      },
    });

    const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
    await gcJson({ pressure: 'critical' });

    const entry = payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === slow);
    expect(entry).toMatchObject({ willRemove: false, reason, detail: expect.stringMatching(detail) });
    expect(existsSync(slow)).toBe(true);
  },
  60_000,
);

test('gc at critical removes only the clean idle linked worktrees, and only while maintenance.removeIdleWorktrees is on', async () => {
  const { repo, worktrees } = gitRepoWithWorktrees(['idle', 'fresh', 'dirty']);
  for (const [name, path] of Object.entries(worktrees)) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path, new Date(Date.now() - (name === 'fresh' ? 1 : 10) * DAY_MS));
  }
  upsertProject(repo, { metroPort: null });
  recordWorkspaceUse(repo, new Date(Date.now() - 30 * DAY_MS));
  writeFileSync(join(worktrees.dirty!, 'scratch.txt'), 'wip');

  await gcJson({ pressure: 'critical' });
  expect(existsSync(worktrees.idle ?? '')).toBe(true);

  vi.stubEnv('STIM_MAINTENANCE_REMOVE_IDLE_WORKTREES', 'true');
  const { payload } = await gcJson({ pressure: 'critical' });
  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'remove-worktree', target: worktrees.idle, outcome: 'done' }),
  );
  expect(existsSync(worktrees.idle!)).toBe(false);
  expect(getProject(worktrees.idle!)).toBe(null);
  for (const name of ['fresh', 'dirty']) expect(existsSync(worktrees[name]!)).toBe(true);
  expect(existsSync(join(repo, 'package.json'))).toBe(true);
}, 30_000);

test('gc reports the in-tree build state of each worktree with its size', async () => {
  const { repo, worktrees } = gitRepoWithWorktrees(['built']);
  const built = realpathSync.native(worktrees.built ?? '');
  upsertProject(repo, { metroPort: null });
  upsertProject(built, { metroPort: null });
  recordWorkspaceUse(built, new Date(Date.now() - 10 * DAY_MS));
  for (const [dir, bytes] of [
    ['node_modules', 300_000],
    ['.pnpm-store/v11', 200_000],
    ['android/app/build', 100_000],
  ] as const) {
    mkdirSync(join(built, dir), { recursive: true });
    writeFileSync(join(built, dir, 'blob'), Buffer.alloc(bytes));
  }

  const nested = join(repo, '.worktrees', 'nested');
  execSync(`git worktree add -q "${nested}" -b nested`, { cwd: repo, timeout: 15_000 });
  mkdirSync(join(nested, 'node_modules'), { recursive: true });
  writeFileSync(join(nested, 'node_modules', 'blob'), Buffer.alloc(10_000));
  upsertProject(nested, { metroPort: null });

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });

  const entry = payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === built);
  const dirs: { path: string; bytes: number }[] = entry.buildState.dirs;
  expect(dirs.map((dir) => dir.path)).toEqual(['node_modules', '.pnpm-store', 'android/app/build']);
  for (const dir of dirs) expect(dir.bytes).toBeGreaterThan(0);
  expect(entry.buildState.bytes).toBe(dirs.reduce((sum, dir) => sum + dir.bytes, 0));
}, 30_000);

test('gc lists DerivedData, CMake and other xcodebuild output in a worktree, with the other-named output marked report-only', async () => {
  const { repo, worktrees } = gitRepoWithWorktrees(['built', 'loose']);
  const built = realpathSync.native(worktrees.built ?? '');
  const loose = realpathSync.native(worktrees.loose ?? '');
  upsertProject(repo, { metroPort: null });
  upsertProject(built, { metroPort: null });
  recordWorkspaceUse(built, new Date(Date.now() - 10 * DAY_MS));
  for (const root of [built, loose]) {
    writeDerivedData(join(root, '.dd'), 300_000);
    writeDerivedData(join(root, 'packages', 'rn-tester', 'build-device'), 200_000);
    mkdirSync(join(root, 'android', 'app', '.cxx'), { recursive: true });
    writeFileSync(join(root, 'android', 'app', '.cxx', 'blob'), Buffer.alloc(100_000));
  }

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });

  for (const root of [built, loose]) {
    const entry = payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === root);
    const dirs: { path: string; bytes: number; privateBytes: number | null; reportOnly?: true }[] =
      entry.buildState.dirs;
    expect(dirs.map((dir) => dir.path)).toEqual(['.dd', 'packages/rn-tester/build-device', 'android/app/.cxx']);
    expect(dirs.filter((dir) => dir.reportOnly).map((dir) => dir.path)).toEqual(['packages/rn-tester/build-device']);
  }
}, 30_000);

test('the maintenance ladder collects .dd and CMake output of a registered worktree only, and never other-named xcodebuild output', async () => {
  const { repo, worktrees } = gitRepoWithWorktrees(['registered', 'loose']);
  const registered = realpathSync.native(worktrees.registered ?? '');
  const loose = realpathSync.native(worktrees.loose ?? '');
  upsertProject(repo, { metroPort: null });
  upsertProject(registered, { metroPort: null });
  recordWorkspaceUse(registered, new Date(Date.now() - 10 * DAY_MS));
  for (const root of [registered, loose]) {
    writeDerivedData(join(root, '.dd'));
    writeDerivedData(join(root, 'build-device'));
    mkdirSync(join(root, 'android', 'app', '.cxx'), { recursive: true });
  }

  const found = collectArtifacts('build', { now: Date.now(), windowMs: 0, protectedRoot: '', pinned: () => false });

  expect(found.candidates.map((candidate) => candidate.path).toSorted()).toEqual(
    [join(registered, '.dd'), join(registered, 'android', 'app', '.cxx')].toSorted(),
  );
  expect(found.skips.map((skip) => skip.target)).not.toContain(join(registered, 'build-device'));

  const clear = (target: string) =>
    clearArtifact({ kind: 'would-clear-build-dirs', target, bytes: 0, reason: 'test' }, 'build', {
      windowMs: 0,
      protectedRoot: '',
      pinned: () => false,
      worktrees: artifactWorktrees(),
    });
  expect(await clear(join(registered, '.dd'))).toMatchObject({ status: 'done' });
  expect(existsSync(join(registered, '.dd'))).toBe(false);
  expect(await clear(join(registered, 'build-device'))).toMatchObject({ status: 'kept' });
  expect(existsSync(join(registered, 'build-device', 'Build'))).toBe(true);
  expect(await clear(join(registered, 'android', 'app', '.cxx'))).toMatchObject({ status: 'done' });
});

function maintenanceArtifactFixture(sessions: Awaited<ReturnType<typeof agentSessions.discoverAgentSessions>>) {
  const { repo, worktrees } = gitRepoWithWorktrees(['registered']);
  const registered = realpathSync.native(worktrees.registered ?? '');
  upsertProject(repo, { metroPort: null });
  upsertProject(registered, { metroPort: null });
  recordWorkspaceUse(registered, new Date(Date.now() - 10 * DAY_MS));
  writeDerivedData(join(registered, '.dd'));
  vi.spyOn(agentSessions, 'discoverAgentSessions').mockResolvedValue(sessions);
  const signal = new AbortController().signal;
  const options = { now: Date.now(), windowMs: 0, protectedRoot: '', pinned: () => false };
  const dd = join(registered, '.dd');
  return {
    registered,
    dd,
    collect: () => collectArtifactsAsync('build', options, signal),
    clear: async () =>
      clearArtifact({ kind: 'would-clear-build-dirs', target: dd, bytes: 0, reason: 'test' }, 'build', {
        ...options,
        worktrees: await artifactWorktreesAsync(signal),
      }),
  };
}

test('maintenance keeps the build output of a registered worktree a running agent session works in', async () => {
  const probe = maintenanceArtifactFixture([]);
  vi.mocked(agentSessions.discoverAgentSessions).mockResolvedValue([
    { tool: 'codex', sessionId: 'live-thread', cwd: join(probe.registered, 'src') },
  ]);

  const found = await probe.collect();
  const cleared = await probe.clear();

  expect(found.candidates).toEqual([]);
  expect(found.skips).toContainEqual({
    target: probe.dd,
    reason: 'in use: an agent session (codex:live-thread) is working in it',
  });
  expect(cleared).toMatchObject({ status: 'kept', detail: expect.stringContaining('agent session') });
  expect(existsSync(probe.dd)).toBe(true);
});

test('maintenance clears the build output of a registered worktree no agent session works in', async () => {
  const probe = maintenanceArtifactFixture([]);

  expect((await probe.collect()).candidates.map((candidate) => candidate.path)).toEqual([probe.dd]);
  expect(await probe.clear()).toMatchObject({ status: 'done' });
});

test('worktree remove drops the registration of a worktree known only by its app directory', async () => {
  const { worktrees } = repoWithTwoBranches({ registerWorktrees: false });
  const merged = worktrees.merged ?? '';
  const app = join(merged, 'app');
  mkdirSync(app);
  upsertProject(app, { metroPort: null });
  ensureWorkspaceStorage(app);

  expect(await removeWorktreeTarget(merged, { linkedOnly: true })).toBe(true);

  expect(existsSync(merged)).toBe(false);
  expect(loadConfig()?.projects[app]).toBeUndefined();
}, 240_000);

test.skipIf(process.platform !== 'darwin')(
  'worktree remove that git refuses keeps the registration of a worktree known only by its app directory',
  async () => {
    const { worktrees } = repoWithTwoBranches({ registerWorktrees: false });
    const merged = worktrees.merged ?? '';
    const app = join(merged, 'app');
    mkdirSync(app);
    upsertProject(app, { metroPort: null });
    ensureWorkspaceStorage(app);
    const locked = join(merged, 'package.json');
    execSync(`chflags uchg "${locked}"`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await removeWorktreeTarget(merged, { linkedOnly: true })).toBe(false);
    } finally {
      execSync(`chflags nouchg "${locked}"`);
    }

    expect(loadConfig()?.projects[app]).toBeDefined();
  },
  240_000,
);

function builtWorktree(dirs: readonly string[]) {
  const { repo, worktrees } = gitRepoWithWorktrees(['built']);
  const built = realpathSync.native(worktrees.built ?? '');
  upsertProject(repo, { metroPort: null });
  upsertProject(built, { metroPort: null });
  for (const dir of dirs) {
    mkdirSync(join(built, dir), { recursive: true });
    writeFileSync(join(built, dir, 'blob'), Buffer.alloc(50_000));
  }
  return built;
}

function countDu(calls: string[][], fail?: (args: string[]) => string | null) {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args: string[], opts) => {
      const walk = file === 'nice' ? args.slice(2) : [file, ...args];
      if (walk[0] === 'du') {
        calls.push(walk.slice(1));
        const stdout = fail?.(walk.slice(1));
        if (stdout != null)
          throw Object.assign(new Error('Command timed out after 10000ms: du'), { signal: 'SIGTERM', stdout });
      }
      return real.runFileAsync(file, args, opts);
    },
  });
}

async function buildStateOf(built: string) {
  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  return payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === built)
    ?.buildState;
}

test('gc reuses cached build-state sizes and measures again only a directory that changed', async () => {
  const built = builtWorktree(['android/app/build', '.build']);
  const calls: string[][] = [];
  countDu(calls);

  const first = await buildStateOf(built);
  expect(calls).toHaveLength(2);
  const second = await buildStateOf(built);
  expect(calls).toHaveLength(2);
  expect(second).toEqual(first);

  const later = new Date(Date.now() + 5000);
  writeFileSync(join(built, 'android', 'app', 'build', 'added'), Buffer.alloc(200_000));
  utimesSync(join(built, 'android', 'app', 'build'), later, later);
  const third = await buildStateOf(built);
  expect(calls).toHaveLength(3);
  expect(calls[2]).toEqual(['-sk', join(built, 'android', 'app', 'build')]);
  expect(third.bytes).toBeGreaterThan(first.bytes);
}, 30_000);

test('a du that times out leaves only its own directory unmeasured, and gc measures it again next time', async () => {
  const built = builtWorktree(['android/app/build', '.build']);
  const calls: string[][] = [];
  countDu(calls, (args) => (args.includes(join(built, '.build')) ? '' : null));

  const state = await buildStateOf(built);

  expect(state.bytes).toBe(null);
  expect(state.dirs).toEqual([
    { path: 'android/app/build', bytes: expect.any(Number), privateBytes: null },
    { path: '.build', bytes: null, privateBytes: null },
  ]);
  expect(state.dirs[0].bytes).toBeGreaterThan(0);
  await gcJson({ dryRun: true, pressure: 'normal' });
  expect(calls.filter((args) => args.includes(join(built, '.build')))).toHaveLength(2);
  expect(calls.filter((args) => args.includes(join(built, 'android', 'app', 'build')))).toHaveLength(1);
}, 30_000);

test('gc reports a directory under .worktrees that git does not list, and never removes it', async () => {
  const { repo } = gitRepoWithWorktrees([]);
  upsertProject(repo, { metroPort: null });
  const listed = join(repo, '.worktrees', 'listed');
  execSync(`git worktree add -q "${listed}" -b listed`, { cwd: repo, timeout: 15_000 });
  const lost = join(realpathSync.native(repo), '.worktrees', 'lost');
  mkdirSync(join(lost, 'src'), { recursive: true });
  writeFileSync(join(lost, 'src', 'work.ts'), Buffer.alloc(50_000));
  writeFileSync(join(lost, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'lost')}\n`);
  const other = join(projects, 'other');
  mkdirSync(other);
  const inOther = (args: string) => execSync(`git ${args}`, { cwd: other, timeout: 15_000 });
  inOther('init -q');
  inOther('-c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init');
  const foreign = join(repo, '.worktrees', 'foreign');
  inOther(`worktree add -q "${foreign}" -b foreign`);

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });

  expect(payload.sections.unlistedWorktreeDirectories).toEqual([
    {
      path: lost,
      repository: realpathSync.native(repo),
      bytes: expect.any(Number),
      remedy: `rm -rf '${lost}'`,
    },
  ]);
  expect(payload.sections.unlistedWorktreeDirectories[0].bytes).toBeGreaterThan(0);
  await gcJson({ pressure: 'critical' });
  expect(existsSync(join(lost, 'src', 'work.ts'))).toBe(true);
  expect(existsSync(listed)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
}, 30_000);

test('gc removes a worktree whose pull request merged or closed only when nothing would be lost', async () => {
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
  const ghCalls = answerGh((branch) => pulls[branch] ?? []);

  const { payload } = (await checkWorktrees(), await gcJson({ dryRun: true, pressure: 'normal' }));
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
  expect(ghCalls).toHaveLength(1);
  const { args } = ghCalls[0]!;
  expect(args.slice(0, 6)).toEqual(['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}']);
  const branches = args.filter((arg) => /^b\d+=/.test(arg)).map((arg) => arg.replace(/^b\d+=/, ''));
  expect(branches.toSorted()).toEqual(names.toSorted());
  expect(args.at(-1)).toMatch(
    /^query=.*b0: pullRequests\(headRefName: \$b0, states: \[OPEN, CLOSED, MERGED\], first: 20,.*headRefOid/,
  );

  await gcJson({ pressure: 'normal' });
  expect(existsSync(worktrees.shipped!)).toBe(false);
  expect(existsSync(worktrees.abandoned!)).toBe(false);
  for (const name of ['unsaved', 'wip', 'gone', 'noPr']) expect(existsSync(worktrees[name]!)).toBe(true);
}, 240_000);

test('a signed-out or unresponsive gh is asked once per repository per worktree check, and every worktree says why', async () => {
  const { worktrees } = gitRepoWithWorktrees(['one', 'two']);
  for (const path of Object.values(worktrees)) upsertProject(path, { metroPort: null });
  const current = getExecutor();
  for (const [failure, reason] of [
    [{ status: 4 }, 'gh is not signed in; run `gh auth login`'],
    [{ code: 'ETIMEDOUT' }, 'gh api graphql did not answer within 20s'],
  ] as const) {
    let calls = 0;
    setExecutor({
      ...current,
      findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : current.findExecutable(name)),
      runFileAsync: async (file, args, opts) => {
        if (file !== 'gh') return current.runFileAsync(file, args, opts);
        calls++;
        throw Object.assign(new Error('gh failed'), failure);
      },
    });
    const sweep = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now() });
    expect(calls).toBe(1);
    expect(
      sweep.worktrees.map((w) => (w.pullRequest && 'unavailable' in w.pullRequest ? w.pullRequest.unavailable : null)),
    ).toEqual([reason, reason]);
  }
}, 60_000);

test('the worktree check asks GitHub once per repository, and a repository whose query fails leaves the others answered', async () => {
  const first = gitRepoWithWorktrees(['alpha', 'beta'], 'first');
  const second = gitRepoWithWorktrees(['gamma'], 'second');
  const heads: Record<string, string> = {};
  for (const [name, path] of Object.entries({ ...first.worktrees, ...second.worktrees })) {
    upsertProject(path, { metroPort: null });
    heads[name] = execSync('git rev-parse HEAD', { cwd: path, encoding: 'utf-8' }).trim();
  }
  const merged = (branch: string) => [
    {
      number: branch.length,
      url: `https://github.com/o/r/pull/${branch.length}`,
      state: 'MERGED',
      headRefOid: heads[branch],
      mergedAt: '2026-09-01T00:00:00Z',
      closedAt: '2026-09-01T00:00:00Z',
    },
  ];
  const calls = answerGh(merged);
  const answering = getExecutor();
  setExecutor({
    ...answering,
    runFileAsync: async (file, args, opts) => {
      if (file === 'gh' && opts?.cwd === realpathSync.native(second.repo)) {
        calls.push({ cwd: opts.cwd, args: args ?? [] });
        throw Object.assign(new Error('Command failed: gh api graphql'), { status: 1, stderr: 'HTTP 502' });
      }
      return answering.runFileAsync(file, args, opts);
    },
  });

  const sweep = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now() });
  const byName = Object.fromEntries(
    gcReportSections({ worktreeSweep: sweep }).linkedWorktrees.map((w) => [basename(w.path), w]),
  );
  expect(calls.map(({ cwd }) => cwd).toSorted()).toEqual(
    [realpathSync.native(first.repo), realpathSync.native(second.repo)].toSorted(),
  );
  expect(byName.alpha).toMatchObject({ pullRequest: { number: 5, state: 'merged' }, pullRequestUnknown: null });
  expect(byName.beta).toMatchObject({ pullRequest: { number: 4, state: 'merged' }, pullRequestUnknown: null });
  expect(byName.gamma).toMatchObject({ pullRequest: null, pullRequestUnknown: 'gh api graphql failed: HTTP 502' });
}, 60_000);

test('a gc dry run lists simulators and AVDs the same number of times however many worktrees own devices', async () => {
  const { worktrees } = gitRepoWithWorktrees(['one', 'two', 'three']);
  for (const path of Object.values(worktrees)) upsertProject(path, { metroPort: null });
  const real = getExecutor();
  const iphone = 'com.apple.CoreSimulator.SimDeviceType.iPhone-15';
  const simctl = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-0': ['one', 'two', 'three'].map((name) => ({
        udid: `U-${name}`,
        name: `stim-${name}`,
        state: name === 'two' ? 'Booted' : 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: iphone,
      })),
    },
  });
  let lists = { sims: 0, avds: 0 };
  const fake = (command: string) => {
    if (/simctl list/.test(command)) {
      lists.sims++;
      return simctl;
    }
    if (/-list-avds/.test(command)) lists.avds++;
    return '';
  };
  setExecutor({
    ...real,
    run: fake,
    runQuiet: fake,
    runFile: (file, args = [], opts) =>
      file === 'git' || file === 'du' ? real.runFile(file, args, opts) : fake([file, ...args].join(' ')),
    runFileQuiet: (file, args = [], opts) =>
      file === 'git' ? real.runFileQuiet(file, args, opts) : fake([file, ...args].join(' ')),
    runFileAsync: async (file, args = [], opts) =>
      file === 'git' || file === 'du' ? real.runFileAsync(file, args, opts) : fake([file, ...args].join(' ')),
  });
  const baseline = async () => {
    lists = { sims: 0, avds: 0 };
    return (await gcJson({ dryRun: true, pressure: 'normal' })).payload;
  };
  const own = (name: string) =>
    upsertProject(worktrees[name]!, {
      platforms: {
        ios: { deviceUdid: `U-${name}`, owned: true, deviceName: `stim-${name}` },
        android: { avdName: `stim-${name}`, owned: true },
      },
    });
  own('two');
  await baseline();
  const one = lists;
  own('one');
  own('three');

  const payload = await baseline();

  expect(lists).toEqual(one);
  const byName = Object.fromEntries(
    payload.sections.linkedWorktrees.map((w: { path: string }) => [basename(w.path), w]),
  );
  expect(byName.two).toMatchObject({ willRemove: false, reason: 'in-use' });
  expect(byName.two.detail).toContain('its owned simulator stim-two is Booted');
  expect(byName.one.reason).not.toBe('in-use');

  await recordDeferredShutdown(byName.two.path, 'default', {
    udid: 'U-two',
    until: new Date(Date.now() + 600_000).toISOString(),
  });
  const afterStop = (await gcJson({ dryRun: true, pressure: 'normal' })).payload.sections.linkedWorktrees.find(
    (w: { path: string }) => basename(w.path) === 'two',
  );
  expect(afterStop.reason).not.toBe('in-use');
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
  const runFile: typeof current.runFile = (file, args, opts) => {
    if (file !== 'gh') return current.runFile(file, args, opts);
    const branch = args.find((arg) => arg.startsWith('b0='))!.slice(3);
    const pull = { number: 7, url: 'https://github.com/o/r/pull/7', state: state[branch], headRefOid: heads[branch] };
    const nodes = [{ ...pull, mergedAt: '2026-09-01T00:00:00Z', closedAt: '2026-09-01T00:00:00Z' }];
    return JSON.stringify({ data: { repository: { b0: { nodes } } } });
  };
  setExecutor({
    ...current,
    findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : current.findExecutable(name)),
    runFile,
    runFileAsync: async (file, args, opts) =>
      file === 'gh' ? runFile(file, args, opts) : current.runFileAsync(file, args, opts),
  });

  await captureLog(async () => {
    expect(await removeWorktreeTarget(worktrees.squashed)).toBe(true);
    expect(await removeWorktreeTarget(worktrees.closed)).toBe(false);
  });
  expect(existsSync(worktrees.squashed!)).toBe(false);
  expect(existsSync(worktrees.closed!)).toBe(true);
}, 60_000);

test('an idle worktree gc at critical keeps because it was used after the plan is not a failure', async () => {
  vi.stubEnv('STIM_MAINTENANCE_REMOVE_IDLE_WORKTREES', 'true');
  const { worktrees } = gitRepoWithWorktrees(['reused']);
  const reused = worktrees.reused!;
  upsertProject(reused, { metroPort: null });
  recordWorkspaceUse(reused, new Date(Date.now() - 10 * DAY_MS));
  const plan = sweepPasses.planWorktrees;
  const spy = vi.spyOn(sweepPasses, 'planWorktrees').mockImplementation(async (...args) => {
    const planned = await plan(...args);
    if (planned.actions.some((action) => action.target === reused)) recordWorkspaceUse(reused);
    return planned;
  });
  let payload;
  try {
    ({ payload } = await gcJson({ pressure: 'critical' }));
  } finally {
    spy.mockRestore();
  }
  expect(existsSync(reused)).toBe(true);
  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'remove-worktree', target: reused, outcome: 'kept' }),
  );
  expect(payload.failures).toBe(0);
  expect(process.exitCode).not.toBe(1);
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

function repoWithMergedBranches({ registerWorktrees = true }: { registerWorktrees?: boolean } = {}) {
  const repo = join(projects, 'origin-repo');
  const remote = join(projects, 'origin.git');
  const upstream = join(projects, 'upstream');
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 });
  const identity = (cwd: string) => {
    git('config user.email test@example.com', cwd);
    git('config user.name test', cwd);
  };
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file === 'package.json' ? JSON.stringify({ dependencies: { expo: '*' } }) : file);
    git(`add ${file}`, cwd);
    git(`commit -q -m ${file}`, cwd);
  };
  git(`init -q --bare -b main "${remote}"`, projects);
  mkdirSync(repo);
  git('init -q -b main');
  identity(repo);
  git(`remote add origin "${remote}"`);
  commit(repo, 'package.json');
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  git('add .gitignore');
  git('commit -q -m ignore');
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
  for (const path of registerWorktrees ? Object.values(worktrees) : [realpathSync.native(repo)]) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path);
  }
  return { repo, remote, worktrees, git };
}

test('gc keeps a merged worktree that holds another worktree under an ignored path', async () => {
  const { worktrees, git } = repoWithTwoBranches();
  const merged = worktrees.merged ?? '';
  const inner = join(merged, '.claude', 'worktrees', 'inner');
  git(`worktree add -q "${inner}" -b inner`);
  writeFileSync(join(inner, 'wip.txt'), 'work');

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  const entry = payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === merged);
  expect(entry).toMatchObject({ willRemove: false, reason: 'nested-worktree' });

  await gcJson({ pressure: 'normal' });
  expect(existsSync(join(inner, 'wip.txt'))).toBe(true);
  expect(existsSync(merged)).toBe(true);
}, 240_000);

test('gc keeps merged linked worktrees where no stim command ran, and removes the one a stim command used', async () => {
  const { repo, worktrees } = repoWithMergedBranches({ registerWorktrees: false });
  upsertProject(worktrees.merged ?? '', { metroPort: null });
  recordWorkspaceUse(worktrees.merged ?? '');

  await gcJson({ pressure: 'normal' });

  expect(existsSync(worktrees.merged ?? '')).toBe(false);
  for (const name of ['squashed', 'rebased']) expect(existsSync(worktrees[name] ?? name)).toBe(true);
  expect(existsSync(join(repo, 'package.json'))).toBe(true);
}, 240_000);

test('gc lists a merged worktree in a maintenance.discoverRoots folder and keeps it while it is recent, with no workspace directory', async () => {
  const { repo, worktrees } = repoWithMergedBranches({ registerWorktrees: false });
  const config = loadConfig();
  if (!config) throw new Error('no config');
  saveConfig({ ...config, maintenance: { discoverRoots: [projects] } });
  const before = listWorkspaceDirs().length;

  const { payload } = await gcJson({ pressure: 'normal' });

  for (const name of ['merged', 'squashed', 'rebased']) expect(existsSync(worktrees[name] ?? name)).toBe(true);
  expect(existsSync(join(repo, 'package.json'))).toBe(true);
  expect(payload.discovered.map((entry: { path: string }) => basename(entry.path))).toContain('merged');
  expect(listWorkspaceDirs()).toHaveLength(before);
}, 240_000);

test('a worktree only a workspace.json names counts as used', async () => {
  const { worktrees } = repoWithMergedBranches({ registerWorktrees: false });
  const merged = worktrees.merged ?? '';
  ensureWorkspaceStorage(merged);

  const { payload } = await gcJson({ pressure: 'normal' });

  expect(existsSync(merged)).toBe(false);
  expect(existsSync(worktrees.squashed ?? '')).toBe(true);
  expect(payload.actions).toContainEqual(expect.objectContaining({ kind: 'remove-worktree', outcome: 'done' }));
}, 240_000);

test('gc keeps a finished worktree pinned with maintenance.keep', async () => {
  const { worktrees } = repoWithMergedBranches();
  writeFileSync(join(worktrees.merged ?? '', '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));

  await checkWorktrees();
  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  await gcJson({ pressure: 'normal' });

  const entry = payload.sections.linkedWorktrees.find(
    (w: { path: string }) => realpathSync.native(w.path) === worktrees.merged,
  );
  expect(entry).toMatchObject({ willRemove: false, reason: 'pinned', detail: 'pinned by maintenance.keep' });
  expect(existsSync(worktrees.merged ?? '')).toBe(true);
  expect(existsSync(worktrees.squashed ?? '')).toBe(false);
}, 240_000);

test('gc at critical keeps finished worktrees while maintenance.removeFinishedWorktrees is false', async () => {
  const { worktrees } = repoWithMergedBranches();
  vi.stubEnv('STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES', 'false');

  await checkWorktrees();
  await gcJson({ pressure: 'critical' });

  expect(existsSync(worktrees.merged ?? '')).toBe(true);
  expect(existsSync(worktrees.squashed ?? '')).toBe(true);
}, 240_000);

test('gc keeps a finished worktree a running agent session works in', async () => {
  const { worktrees } = repoWithMergedBranches();
  const merged = worktrees.merged ?? '';
  vi.spyOn(agentSessions, 'discoverAgentSessions').mockResolvedValue([
    { tool: 'claude-code', sessionId: 'live-session', cwd: join(merged, 'apps') },
  ]);

  await checkWorktrees();
  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  await gcJson({ pressure: 'normal' });

  const entry = payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === merged);
  expect(entry).toMatchObject({
    willRemove: false,
    reason: 'in-use',
    detail: 'in use: an agent session (claude-code:live-session) is working in it',
  });
  expect(existsSync(merged)).toBe(true);
  expect(existsSync(worktrees.squashed ?? '')).toBe(false);
}, 240_000);

test('worktree remove removes a clean linked worktree no stim command ran in', async () => {
  const { worktrees } = repoWithMergedBranches({ registerWorktrees: false });
  const merged = worktrees.merged ?? '';

  expect(await removeWorktreeTarget(merged, { linkedOnly: true })).toBe(true);
  expect(existsSync(merged)).toBe(false);
}, 240_000);

test('maintenance clears no node_modules or build output in a worktree no stim command ran in', async () => {
  const { repo, worktrees } = repoWithMergedBranches({ registerWorktrees: false });
  upsertProject(worktrees.merged ?? '', { metroPort: null });

  const paths = artifactWorktrees().map((w) => realpathSync.native(w.path));

  expect(paths).toContain(worktrees.merged);
  expect(paths).toContain(realpathSync.native(repo));
  expect(paths).not.toContain(worktrees.squashed);
  expect(paths).not.toContain(worktrees.rebased);
}, 240_000);

test('gc removes merged worktrees, squash merges included, after fetching the default branch', async () => {
  const { repo, worktrees, git } = repoWithMergedBranches();

  const { payload } = (await checkWorktrees(), await gcJson({ dryRun: true, pressure: 'normal' }));
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
      reason: 'recent-activity',
      detail: expect.stringMatching(/^recent activity: /),
    });
  }
  for (const name of ['evil', 'spaced']) {
    expect(byPath[worktrees[name]!]).toMatchObject({ willRemove: false, reason: 'unpushed', mergedInto: null });
  }
  expect(byPath[worktrees.open!]).toMatchObject({ willRemove: false, reason: 'not-merged' });
  expect(byPath[worktrees.dirty!]).toMatchObject({ willRemove: false, reason: 'dirty' });

  const acted = (await gcJson({ pressure: 'normal' })).payload;
  for (const name of ['merged', 'squashed'])
    expect(acted.actions).toContainEqual(
      expect.objectContaining({ kind: 'remove-worktree', target: worktrees[name], outcome: 'done' }),
    );
  for (const name of ['merged', 'squashed', 'rebased']) expect(existsSync(worktrees[name]!)).toBe(false);
  for (const name of ['fresh', 'followup', 'reused', 'evil', 'spaced', 'open', 'dirty']) {
    expect(existsSync(worktrees[name]!)).toBe(true);
  }
  expect(existsSync(join(repo, 'package.json'))).toBe(true);
  expect(git('branch --list squashed')).toContain('squashed');
  expect(process.exitCode).not.toBe(1);
}, 240_000);

test('the maintenance worktree check records a merged worktree it keeps for its grace period, and the check after the grace removes it and clears the record', async () => {
  const { merged, open } = repoWithTwoBranches().worktrees;
  if (!merged || !open) throw new Error('The fixture worktrees are missing');
  vi.stubEnv('STIM_DAEMON', 'on');
  const deferred = vi.spyOn(maintenanceMeasure, 'sizeScanDeferred').mockReturnValue(false);
  onTestFinished(() => deferred.mockRestore());
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '120';
  const started = Date.now();

  await runMaintenance('daemon');

  const waiting = readMaintenanceState()?.nextRemoval;
  expect(waiting?.target).toBe(merged);
  expect(waiting?.at).toBeGreaterThanOrEqual(started + 119 * 60_000);
  expect(existsSync(merged)).toBe(true);

  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '0';
  writeFileSync(maintenanceStateFile(), JSON.stringify({ ...readMaintenanceState(), lastAt: {} }));
  await runMaintenance('daemon');

  expect(existsSync(merged)).toBe(false);
  expect(existsSync(open)).toBe(true);
  expect(readMaintenanceState()?.nextRemoval).toBeUndefined();
}, 240_000);

async function checkWorktrees() {
  return (await planWorktrees({ protectedRoot: projects, pinned: () => false, now: Date.now() })).sweep;
}

function countFetches(): string[][] {
  const fetches: string[][] = [];
  const current = getExecutor();
  setExecutor({
    ...current,
    runFile: (file, args: string[], opts) => {
      if (file === 'git' && args.includes('fetch')) fetches.push(args);
      return current.runFile(file, args, opts);
    },
    runFileAsync: async (file, args = [], opts) => {
      if (file === 'git' && args.includes('fetch')) fetches.push([...args]);
      return current.runFileAsync(file, args, opts);
    },
  });
  return fetches;
}

function fetchHeadOf(repo: string): string {
  return execSync('git rev-parse --path-format=absolute --git-path FETCH_HEAD', {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
}

test('a gc dry run fetches nothing and asks gh nothing, shows what the maintenance worktree check last learned, and an acting gc asks again', async () => {
  const { repo, worktrees, git } = repoWithTwoBranches();
  const trackedMain = git('rev-parse refs/remotes/origin/main').trim();
  const ghCalls = answerGh(() => []);
  const fetches = countFetches();

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });

  expect(fetches).toEqual([]);
  expect(ghCalls).toEqual([]);
  expect(git('rev-parse refs/remotes/origin/main').trim()).toBe(trackedMain);
  expect(existsSync(fetchHeadOf(repo))).toBe(false);
  const byPath = Object.fromEntries(
    payload.sections.linkedWorktrees.map((w: { path: string }) => [realpathSync.native(w.path), w]),
  );
  for (const name of ['merged', 'open']) {
    expect(byPath[worktrees[name] ?? '']).toMatchObject({
      willRemove: false,
      reason: 'merge-unknown',
      pullRequestUnknown: 'not checked since the last maintenance worktree check',
      detail:
        'not merged into origin/main; merge state not refreshed: the repository has no recorded fetch, its pull request was not checked; the next maintenance worktree check, which a stim command starts when it is due, or `stim gc` checks again',
    });
  }

  await checkWorktrees();
  expect(fetches).toHaveLength(1);
  expect(ghCalls).toHaveLength(1);
  const checked = Object.fromEntries(
    (await gcJson({ dryRun: true, pressure: 'normal' })).payload.sections.linkedWorktrees.map((w: { path: string }) => [
      realpathSync.native(w.path),
      w,
    ]),
  );
  expect(fetches).toHaveLength(1);
  expect(ghCalls).toHaveLength(1);
  expect(checked[worktrees.merged ?? '']).toMatchObject({ willRemove: true, detail: 'merged into origin/main' });
  expect(checked[worktrees.open ?? '']).toMatchObject({
    willRemove: false,
    reason: 'not-merged',
    detail: 'not merged into origin/main',
    pullRequestUnknown: null,
  });

  await gcJson({ pressure: 'normal' });
  expect(ghCalls).toHaveLength(2);
  expect(existsSync(worktrees.merged ?? '')).toBe(false);
  expect(existsSync(worktrees.open ?? '')).toBe(true);
}, 240_000);

test('a gc dry run trusts a merge proven from existing refs and a fresh cached pull request lookup, never an old one', async () => {
  const names = ['landed', 'shipped', 'aged', 'abandoned', 'moved', 'legacy', 'quiet', 'unknown'];
  const { repo, worktrees } = gitRepoWithWorktrees(names);
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  const heads: Record<string, string> = {};
  for (const name of names) {
    const path = worktrees[name] ?? '';
    writeFileSync(join(path, `${name}.txt`), name);
    git(`add ${name}.txt`, path);
    git(`commit -q -m ${name}`, path);
    git(`push -q origin ${name}`, path);
    heads[name] = git('rev-parse HEAD', path);
    upsertProject(path, { metroPort: null });
  }
  git('merge -q --no-ff landed -m merge-landed');
  git('push -q origin HEAD');
  git('fetch -q origin');
  git('remote set-head origin --auto');
  const main = git('symbolic-ref --short refs/remotes/origin/HEAD');
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(fetchHeadOf(repo), hourAgo, hourAgo);
  const now = new Date().toISOString();
  const cache = (name: string, entry: object) => {
    const path = realpathSync.native(worktrees[name] ?? '');
    const file = pullRequestCacheFile(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ path, branch: name, head: heads[name], checkedAt: now, ...entry }));
  };
  const pr = (number: number, state: string) => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `pr ${number}`,
    state,
    checks: null,
    reviewDecision: null,
    checkedAt: now,
  });
  cache('shipped', { pullRequest: pr(1, 'merged'), containsHead: true, endedAt: Date.parse('2026-09-01T00:00:00Z') });
  cache('aged', {
    checkedAt: hourAgo.toISOString(),
    pullRequest: pr(5, 'merged'),
    containsHead: true,
    endedAt: Date.parse('2026-09-01T00:00:00Z'),
  });
  cache('abandoned', { pullRequest: pr(2, 'closed'), containsHead: true, endedAt: Date.parse('2026-09-01T00:00:00Z') });
  cache('moved', {
    head: heads.landed,
    pullRequest: pr(3, 'merged'),
    containsHead: true,
    endedAt: Date.parse('2026-09-01T00:00:00Z'),
  });
  cache('legacy', { pullRequest: pr(4, 'merged') });
  cache('quiet', { pullRequest: null });
  const ghCalls = answerGh(() => []);
  const fetches = countFetches();

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });

  expect(fetches).toEqual([]);
  expect(ghCalls).toEqual([]);
  const byName = Object.fromEntries(
    payload.sections.linkedWorktrees.map((w: { path: string }) => [basename(w.path), w]),
  );
  expect(byName.landed).toMatchObject({ willRemove: true, detail: `merged into ${main}` });
  expect(byName.shipped).toMatchObject({ willRemove: true, detail: 'PR #1 merged' });
  expect(byName.abandoned).toMatchObject({ willRemove: true, detail: 'PR #2 closed' });
  expect(byName.quiet).toMatchObject({
    willRemove: false,
    reason: 'merge-unknown',
    detail: `not merged into ${main}; merge state not refreshed: the repository was last fetched 1h ago; the next maintenance worktree check, which a stim command starts when it is due, or \`stim gc\` checks again`,
  });
  for (const name of ['aged', 'moved', 'legacy', 'unknown']) {
    expect(byName[name]).toMatchObject({
      willRemove: false,
      reason: 'merge-unknown',
      detail: `not merged into ${main}; merge state not refreshed: the repository was last fetched 1h ago, its pull request was not checked; the next maintenance worktree check, which a stim command starts when it is due, or \`stim gc\` checks again`,
    });
  }

  utimesSync(fetchHeadOf(repo), new Date(), new Date());
  const fresh = Object.fromEntries(
    (await gcJson({ dryRun: true, pressure: 'normal' })).payload.sections.linkedWorktrees.map((w: { path: string }) => [
      basename(w.path),
      w,
    ]),
  );
  expect(fresh.quiet).toMatchObject({ willRemove: false, reason: 'not-merged', detail: `not merged into ${main}` });
  expect(fresh.unknown).toMatchObject({
    reason: 'merge-unknown',
    detail: `not merged into ${main}; merge state not refreshed: its pull request was not checked; the next maintenance worktree check, which a stim command starts when it is due, or \`stim gc\` checks again`,
  });
  expect(fetches).toEqual([]);
  expect(ghCalls).toEqual([]);
}, 240_000);

function backdateWorktreeActivity(path: string, when: Date): void {
  const gitDir = execSync('git rev-parse --path-format=absolute --git-dir', { cwd: path, encoding: 'utf-8' }).trim();
  for (const file of [join(gitDir, 'index'), join(gitDir, 'HEAD'), join(gitDir, 'logs', 'HEAD')]) {
    utimesSync(file, when, when);
  }
}

test('gc at critical removes idle worktrees with no commits of their own that have a project and no recorded use', async () => {
  unscopedHome();
  const { worktrees, git } = repoWithMergedBranches({ registerWorktrees: false });
  const at = (name: string) => worktrees[name] ?? name;
  for (const path of Object.values(worktrees)) upsertProject(path, { metroPort: null });
  for (const name of ['fresh', 'followup', 'reused', 'open']) {
    backdateWorktreeActivity(at(name), new Date(Date.now() - 10 * DAY_MS));
  }

  const plan = sweepPasses.planWorktrees;
  let moved = false;
  const spy = vi.spyOn(sweepPasses, 'planWorktrees').mockImplementation(async (...args) => {
    const planned = await plan(...args);
    if (!moved && planned.actions.some((action) => action.target === at('followup'))) {
      git('checkout -q --detach HEAD~1', at('followup'));
      moved = true;
    }
    return planned;
  });
  let payload;
  try {
    ({ payload } = await gcJson({ pressure: 'critical' }));
  } finally {
    spy.mockRestore();
  }
  expect(moved).toBe(true);
  for (const name of ['fresh', 'reused']) {
    expect(existsSync(at(name))).toBe(false);
    expect(payload.actions).toContainEqual(
      expect.objectContaining({ kind: 'remove-worktree', target: at(name), outcome: 'done' }),
    );
  }
  expect(existsSync(at('followup'))).toBe(true);
  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'remove-worktree', target: at('followup'), outcome: 'kept' }),
  );
  for (const name of ['open', 'evil', 'dirty']) expect(existsSync(at(name))).toBe(true);
}, 240_000);

test('worktree removal keeps a worktree whose HEAD is not the one the caller approved', async () => {
  const { worktrees, git } = repoWithMergedBranches({ registerWorktrees: false });
  const fresh = worktrees.fresh ?? '';
  const head = git('rev-parse HEAD', fresh).trim();
  const other = git('rev-parse HEAD~1', fresh).trim();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await removeWorktreeTarget(fresh, { linkedOnly: true, expectedHead: other })).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(error.mock.calls.flat().join('\n')).toContain('its HEAD moved since it was checked');
    expect(await removeWorktreeTarget(fresh, { linkedOnly: true, expectedHead: head })).toBe(true);
  } finally {
    error.mockRestore();
  }
  expect(existsSync(fresh)).toBe(false);
}, 240_000);

test.skipIf(process.platform === 'win32')(
  'gc archives a dirty finished worktree, then removes it, and keeps it while archives are off',
  async () => {
    const { worktrees } = repoWithMergedBranches();
    const dirty = worktrees.dirty ?? '';
    onTestFinished(() => {
      delete process.env.STIM_ARCHIVE_ENABLED;
    });

    await gcJson({ pressure: 'normal' });
    expect(existsSync(dirty)).toBe(true);

    process.env.STIM_ARCHIVE_ENABLED = 'true';
    await gcJson({ pressure: 'normal' });

    expect(existsSync(dirty)).toBe(false);
    const repoDir = join(worktreeArchiveRoot(), 'origin-repo');
    const [entry] = readdirSync(repoDir);
    const archive = join(repoDir, entry ?? '');
    const manifest = JSON.parse(readFileSync(join(archive, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ branch: 'dirty', worktree: dirty, tracked: [], untracked: ['notes.txt'] });
    for (const command of manifest.restore) execSync(command, { stdio: 'pipe', timeout: 30_000 });
    expect(readFileSync(join(dirty, 'notes.txt'), 'utf8')).toBe('wip');
  },
  240_000,
);

test('the grace period of a dirty finished worktree counts changes to its uncommitted files', async () => {
  const { worktrees } = repoWithTwoBranches();
  const dirty = worktrees.merged ?? '';
  writeFileSync(join(dirty, 'notes.txt'), 'wip');
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  onTestFinished(() => {
    delete process.env.STIM_ARCHIVE_ENABLED;
  });
  const later = Date.now() + 3 * 60 * 60_000;
  const verdict = async () =>
    (await collectWorktreeSweep({ idle: false, olderThan: null, now: later, graceMs: 120 * 60_000 })).worktrees.find(
      (w) => realpathSync.native(w.path) === dirty,
    );

  expect(await verdict()).toMatchObject({ skipCode: null, dirty: 1 });
  const edited = new Date(later - 10 * 60_000);
  utimesSync(join(dirty, 'notes.txt'), edited, edited);
  expect(await verdict()).toMatchObject({
    skipCode: 'recent-activity',
    skipped: expect.stringMatching(/^recent activity: an uncommitted file change 10m ago/),
  });
}, 240_000);

test('gc removes a clean detached worktree on the default branch once idle, and keeps a fresh one', async () => {
  unscopedHome();
  const { worktrees, git } = repoWithTwoBranches({ registerWorktrees: false });
  const baseline = join(projects, 'baseline');
  git(`worktree add -q --detach "${baseline}" origin/main`);
  backdateWorktreeActivity(baseline, new Date(Date.now() - 3 * 60 * 60_000));
  const fresh = join(projects, 'fresh-baseline');
  git(`worktree add -q --detach "${fresh}" origin/main`);
  for (const path of [baseline, fresh]) upsertProject(path, { metroPort: null });

  const { payload } = await gcJson({ pressure: 'normal' });

  expect(existsSync(baseline)).toBe(false);
  expect(payload.actions).toContainEqual(
    expect.objectContaining({
      kind: 'remove-worktree',
      target: realpathSync.native(projects) + '/baseline',
      outcome: 'done',
    }),
  );
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(worktrees.open ?? '')).toBe(true);
}, 240_000);

test('gc keeps a finished worktree that holds the running stim, and worktree remove refuses it', async () => {
  unscopedHome();
  const { worktrees, git, upstream } = repoWithTwoBranches();
  git('merge -q --no-ff origin/open -m merge-control', upstream);
  git('push -q origin HEAD', upstream);
  const merged = worktrees.merged ?? '';
  const argv = process.argv[1] ?? '';
  process.argv[1] = join(merged, 'package.json');
  onTestFinished(() => {
    process.argv[1] = argv;
  });

  await checkWorktrees();
  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  await gcJson({ pressure: 'normal' });

  expect(
    payload.sections.linkedWorktrees.find((w: { path: string }) => realpathSync.native(w.path) === merged),
  ).toMatchObject({
    willRemove: false,
    reason: 'in-use',
    detail: expect.stringContaining('it holds the running stim'),
  });
  expect(existsSync(merged)).toBe(true);
  expect(existsSync(worktrees.open ?? '')).toBe(false);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await removeWorktreeTarget(merged, { linkedOnly: true, force: true })).toBe(false);
    expect(error.mock.calls.flat().join('\n')).toContain('it holds the running stim');
  } finally {
    error.mockRestore();
  }
  expect(existsSync(merged)).toBe(true);
}, 240_000);

test('gc keeps a merged worktree when the fetch fails, and when its HEAD moves after the report', async () => {
  const { repo, remote, worktrees, git, upstream } = repoWithTwoBranches();
  git('merge -q --no-ff origin/open -m merge-control', upstream);
  git('push -q origin HEAD', upstream);
  git('fetch -q origin');
  const stale = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(repo, '.git', 'FETCH_HEAD'), stale, stale);
  renameSync(remote, `${remote}.moved`);

  const failed = (await gcJson({ pressure: 'normal' })).payload;
  expect(failed.actions.filter((action: { kind: string }) => action.kind === 'remove-worktree')).toEqual([]);
  expect(existsSync(worktrees.merged!)).toBe(true);

  renameSync(`${remote}.moved`, remote);
  const plan = sweepPasses.planWorktrees;
  let moved = false;
  const spy = vi.spyOn(sweepPasses, 'planWorktrees').mockImplementation(async (...args) => {
    const planned = await plan(...args);
    if (!moved && planned.actions.some((action) => action.target === worktrees.merged)) {
      writeFileSync(join(worktrees.merged!, 'late.txt'), 'x');
      git('add late.txt', worktrees.merged);
      git('commit -q -m late', worktrees.merged);
      git('push -q', worktrees.merged);
      moved = true;
    }
    return planned;
  });
  let payload;
  try {
    ({ payload } = await gcJson({ pressure: 'normal' }));
  } finally {
    spy.mockRestore();
  }
  expect(moved).toBe(true);
  expect(existsSync(worktrees.merged!)).toBe(true);
  expect(payload.actions).toContainEqual(
    expect.objectContaining({ kind: 'remove-worktree', target: worktrees.merged, outcome: 'kept' }),
  );
  expect(existsSync(worktrees.open!)).toBe(false);
}, 240_000);

test('gc keeps a just-merged worktree for the grace period, then removes it and tears down its device', async () => {
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
    runFileAsync: async (file, args = [], opts) =>
      file === 'git' ? real.runFileAsync(file, args, opts) : fake([file, ...args].join(' ')),
    runFileQuietAsync: async (file, args = [], opts) =>
      file === 'git' ? real.runFileQuietAsync(file, args, opts) : fake([file, ...args].join(' ')),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
    findExecutable: () => null,
  });

  const freshActivityAt = statSync(join(workspaceDir(worktrees.fresh!), 'state.json')).mtimeMs;
  await checkWorktrees();
  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  await gcJson({ pressure: 'normal' });
  const byPath = Object.fromEntries(payload.sections.linkedWorktrees.map((w: { path: string }) => [w.path, w]));
  expect(byPath[worktrees.fresh!]).toMatchObject({
    mergedInto: 'origin/main',
    willRemove: false,
    reason: 'recent-activity',
    eligibleAt: expect.any(String),
  });
  expect(byPath[worktrees.fresh!].eligibleAt).toBe(new Date(freshActivityAt + 120 * 60_000).toISOString());
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
}, 240_000);

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
    runFileAsync: async (file, args, opts) => {
      if (file === 'du') throw new Error('Command timed out after 60000ms: du');
      return current.runFileAsync(file, args, opts);
    },
  });

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  expect(payload.sections.workspaceBuildOutputs).toContainEqual(
    expect.objectContaining({ projectRoot: root, bytes: null, willClear: true }),
  );
  await deleteGcItem({ kind: 'workspace-outputs' });
  expect(existsSync(join(dir, 'derived-data'))).toBe(false);
});

test('the workspace-outputs item leaves the build outputs of a directory the maintenance run removes whole', async () => {
  const live = builtWorkspace('live-app', { usedDaysAgo: 10 });
  const orphan = goneWorkspace('gone-app');
  mkdirSync(join(orphan.dir, 'derived-data'), { recursive: true });
  writeFileSync(join(orphan.dir, 'derived-data', 'blob'), 'x'.repeat(1024));
  const outputs = (payload: { sections: { workspaceBuildOutputs: { projectRoot: string }[] } }) =>
    payload.sections.workspaceBuildOutputs.map((entry) => entry.projectRoot);

  const unscoped = (await gcJson({ dryRun: true, pressure: 'normal' })).payload;
  expect(unscoped.sections.orphanedWorkspaces.map((entry: { dir: string }) => entry.dir)).toContain(orphan.dir);
  expect(outputs(unscoped)).toEqual([live.root]);

  await deleteGcItem({ kind: 'workspace-outputs' });
  expect(existsSync(join(live.dir, 'derived-data'))).toBe(false);
  expect(existsSync(join(orphan.dir, 'derived-data', 'blob'))).toBe(true);
});

test('the workspace-outputs item leaves the build outputs of a dead project to the maintenance run', async () => {
  const live = builtWorkspace('live-one', { usedDaysAgo: 10 });
  const dead = builtWorkspace('dead-one', { usedDaysAgo: 10 });
  rmSync(dead.root, { recursive: true, force: true });

  const { payload } = await gcJson({ dryRun: true, pressure: 'normal' });
  expect(payload.sections.workspaceBuildOutputs.map((entry: { projectRoot: string }) => entry.projectRoot)).toEqual([
    live.root,
  ]);

  await deleteGcItem({ kind: 'workspace-outputs' });
  expect(existsSync(join(live.dir, 'derived-data'))).toBe(false);
  expect(existsSync(join(dead.dir, 'derived-data'))).toBe(true);
});

describe('status cache entries of gone workspaces', () => {
  const seedDisk = (path: string) => {
    const file = diskUsageCacheFile(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ path, bytes: 10, measuredAt: '2026-09-01T00:00:00.000Z' }));
    return file;
  };
  const seedPullRequest = (path: string) => {
    const file = pullRequestCacheFile(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ path, branch: 'b', head: 'h', checkedAt: '2026-09-01T00:00:00.000Z', pullRequest: null }),
    );
    return file;
  };

  test('cancelling status-cache cleanup after one deletion preserves the later file', async () => {
    const firstPath = join(projects, 'gone-first');
    const laterPath = join(projects, 'gone-later');
    const first = seedDisk(firstPath);
    const later = seedDisk(laterPath);
    const original = readFileSync(later, 'utf8');
    const controller = new AbortController();
    const reason = new Error('cancel status-cache cleanup');
    logIo.afterRemove = (file) => {
      if (String(file) === first) controller.abort(reason);
    };
    const entries = [
      { kind: 'disk-usage' as const, file: first, path: firstPath, bytes: 10 },
      { kind: 'disk-usage' as const, file: later, path: laterPath, bytes: 10 },
    ];
    await expect(
      Promise.resolve().then(() => deleteStaleStatusCaches(entries, undefined, controller.signal)),
    ).rejects.toBe(reason);
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(later, 'utf8')).toBe(original);
  });

  const seedMerge = (path: string) => {
    const file = gitMergeCacheFile(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ path, head: 'h', target: 't', mergedInto: null }));
    return file;
  };

  test('gc reports and removes entries whose path is gone, and keeps the rest', async () => {
    const live = join(projects, 'live');
    mkdirSync(join(live, 'node_modules'), { recursive: true });
    const gone = join(projects, 'gone');
    const stale = [seedDisk(gone), seedDisk(join(gone, 'node_modules')), seedPullRequest(gone), seedMerge(gone)];
    const kept = [seedDisk(live), seedPullRequest(live), seedMerge(live), seedDisk(join(live, 'node_modules'))];
    const unreadable = join(dirname(diskUsageCacheFile(live)), `${'0'.repeat(32)}.json`);
    writeFileSync(unreadable, 'not json');
    const foreign = diskUsageCacheFile(join(projects, 'elsewhere'));
    writeFileSync(foreign, JSON.stringify({ path: join(projects, 'other'), bytes: 1, measuredAt: 'x' }));

    const dry = (await gcJson({ dryRun: true, pressure: 'normal' })).payload;
    expect(dry.sections.staleStatusCaches.map((e: { file: string }) => e.file).toSorted()).toEqual(stale.toSorted());
    expect(dry.sections.skipped).toContainEqual({
      path: dirname(unreadable),
      detail: '2 entries kept: the file records no readable path of its own',
    });
    expect(dry.actionable).toBe(true);
    for (const file of stale) expect(existsSync(file)).toBe(true);

    const { payload } = await gcJson({ pressure: 'normal' });
    for (const file of stale) expect(existsSync(file)).toBe(false);
    for (const file of [...kept, unreadable, foreign]) expect(existsSync(file)).toBe(true);
    expect(payload.results).toContainEqual(expect.objectContaining({ kind: 'statusCache', status: 'done' }));
    expect(payload.failures).toBe(0);
  });

  test('entries whose volume is not mounted are kept', () => {
    const file = seedDisk('/Volumes/never-mounted/app');
    const entry = { kind: 'disk-usage' as const, file, path: '/Volumes/never-mounted/app', bytes: 1 };
    expect(classifyStatusCaches([entry], [])).toEqual({
      stale: [],
      skipped: [{ dir: dirname(file), reason: '1 entry kept: the volume of the folder it measures is not mounted' }],
    });
  });

  test("worktree remove drops that worktree's entries and no other", async () => {
    const { worktrees } = gitRepoWithWorktrees(['going', 'staying']);
    const going = realpathSync.native(worktrees.going!);
    const staying = realpathSync.native(worktrees.staying!);
    const goingFiles = [
      seedDisk(going),
      seedDisk(join(going, 'node_modules')),
      seedDisk(workspaceDir(going)),
      seedPullRequest(going),
      seedMerge(going),
    ];
    const stayingFiles = [
      seedDisk(staying),
      seedDisk(workspaceDir(staying)),
      seedPullRequest(staying),
      seedMerge(staying),
    ];

    await captureLog(() => removeWorktreeTarget(going));

    expect(existsSync(going)).toBe(false);
    for (const file of goingFiles) expect(existsSync(file)).toBe(false);
    for (const file of stayingFiles) expect(existsSync(file)).toBe(true);
  }, 60_000);
});
