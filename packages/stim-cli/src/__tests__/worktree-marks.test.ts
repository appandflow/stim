import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoveryScanFile, gcMarkFile, readGcMark, worktreeArchiveRoot, type Config } from '@stim-cli/core/state';
import * as worktrees from '../commands/gc/worktrees.ts';
import * as discovery from '../workspace/discovery.ts';
import * as pullRequests from '../pull-request-state.ts';
import * as mergeState from '../workspace/merge-state.ts';
import * as gitWorktrees from '../workspace/worktree.ts';
import * as iosDevices from '../devices/ios.ts';
import * as agentSessions from '../agent-sessions.ts';
import * as discoveredRemoval from '../workspace/discovered-removal.ts';
import * as dependencyEdits from '../workspace/dependency-edits.ts';
import { saveConfig } from '../workspace/config.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { worktreeMarkObserver } from '../daemon/worktree-marks.ts';
import { savedWorktreeReports } from '../daemon/worktree-reports.ts';
import { markWriter } from '../daemon/marks.ts';
import { testContext } from './_context.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { planWorktrees } from '../stimd/passes/sweep.ts';
import { executeAction } from '../stimd/passes/act.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import * as cacheFiles from '../cache-file.ts';

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

let base: string;
let source: string;
let linked: string;
let config: Config;
const day = 86_400_000;
const git = (path: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      path,
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
const reading = () => ({ devices: [], simsFailed: false, operation: testContext() });

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-worktree-mark-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('STIM_GC_WORKTREE_GRACE_MINUTES', '60');
  vi.stubEnv('STIM_MAINTENANCE_PROTECT_RECENT_HOURS', '0');
  source = join(base, 'source');
  linked = join(base, 'linked');
  mkdirSync(source);
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(source, 'init', '-q', '-b', 'main');
  writeFileSync(join(source, 'package.json'), '{}');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'initial');
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', '-q', '-u', 'origin', 'main');
  git(source, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(source, 'worktree', 'add', '-q', '-b', 'feature', linked);
  config = { projects: { [linked]: {} }, repos: {}, maintenance: { autoDiscover: false } };
  saveConfig(config);
  recordWorkspaceUse(linked, new Date(Date.now() - 10 * day));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const observe = () =>
  worktrees.collectWorktreeSweep({
    idle: false,
    olderThan: null,
    now: Date.now(),
    refresh: false,
    operation: testContext(),
    onObservation: worktreeMarkObserver(config, reading()),
  });

test('the existing read-only worktree inventory publishes no mark without its normal observer', async () => {
  finished();
  await worktrees.collectWorktreeSweep({
    idle: false,
    olderThan: null,
    now: Date.now(),
    refresh: false,
    operation: testContext(),
  });
  expect(readGcMark(linked)).toBeNull();
});

function finished() {
  writeFileSync(join(linked, 'feature.txt'), 'feature');
  git(linked, 'add', '-A');
  git(linked, 'commit', '-q', '-m', 'feature');
  git(source, 'merge', '-q', '--no-ff', 'feature', '-m', 'merged');
  git(source, 'push', '-q', 'origin', 'main');
}

test('saves a clean finished worktree still inside normal grace, reports it only at critical, and performs no pressure discovery or refresh', async () => {
  finished();
  await observe();
  expect(readGcMark(linked)?.worktree).toMatchObject({
    clean: true,
    finished: { reason: 'merged into origin/main' },
    keep: { code: 'recent-activity' },
  });
  const before = readFileSync(gcMarkFile(linked), 'utf8');
  const collect = vi.spyOn(worktrees, 'collectWorktreeSweep').mockRejectedValue(new Error('must not collect'));
  const discover = vi.spyOn(discovery, 'discoverCheckouts').mockRejectedValue(new Error('must not discover'));
  const refresh = vi.spyOn(pullRequests, 'refreshPullRequests').mockImplementation(() => {
    throw new Error('must not refresh PRs');
  });
  const fetch = vi.spyOn(mergeState, 'fetchDefaultBranchAsync').mockRejectedValue(new Error('must not fetch'));
  const edits = vi
    .spyOn(dependencyEdits, 'dependencyEditsHold')
    .mockRejectedValue(new Error('must not check dependency edits'));

  const high = await savedWorktreeReports(config, reading(), 'high', false);
  const critical = await savedWorktreeReports(config, reading(), 'critical', false);

  expect(high).toEqual([
    expect.objectContaining({ target: linked, detail: expect.stringContaining('inside the current grace') }),
  ]);
  expect(critical).toEqual([
    expect.objectContaining({ target: linked, detail: expect.stringContaining('report only:') }),
  ]);
  expect(collect).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(edits).not.toHaveBeenCalled();
  expect(readFileSync(gcMarkFile(linked), 'utf8')).toBe(before);
  expect(existsSync(linked)).toBe(true);
}, 20_000);

test('reports a finished worktree from a stim gc run outside any project, whose protected root does not exist', async () => {
  finished();
  await observe();
  const outside = { ...reading(), protectedRoot: join(base, 'home', 'maintenance', 'no-project') };

  expect(await savedWorktreeReports(config, outside, 'critical', false)).toEqual([
    expect.objectContaining({ target: linked, detail: expect.stringContaining('report only:') }),
  ]);
});

test('records actual dirty work separately from archive eligibility and keeps it in a critical report', async () => {
  finished();
  writeFileSync(join(linked, 'feature.txt'), 'uncommitted');
  await observe();
  expect(readGcMark(linked)?.worktree?.clean).toBe(false);
  expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain(
    'uncommitted changes',
  );
});

test('preserves the existing empty-branch activity floor', async () => {
  await observe();
  expect(readGcMark(linked)?.worktree?.emptyBranch).toBe(true);
  expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain(
    'empty branch is inside its activity grace',
  );
  vi.setSystemTime(Date.now() + 6 * 60_000);
  expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain('report only:');
});

test('new actual Git finish activity advances only the worktree observation of a previously dormant mark', async () => {
  await observe();
  const previous = readGcMark(linked);
  if (!previous?.worktree) throw new Error('fixture observation missing');
  const outputAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const worktreeAt = new Date(Date.now() - 60 * 60_000).toISOString();
  writeFileSync(
    gcMarkFile(linked),
    JSON.stringify({
      ...previous,
      markedAt: outputAt,
      lastActivityAt: new Date(Date.now() - 10 * day).toISOString(),
      worktree: { ...previous.worktree, markedAt: worktreeAt },
    }),
  );

  finished();
  await observe();

  expect(readGcMark(linked)?.markedAt).toBe(outputAt);
  expect(readGcMark(linked)?.lastActivityAt).toBe(new Date(Date.now() - 10 * day).toISOString());
  expect(readGcMark(linked)?.worktree?.markedAt).not.toBe(worktreeAt);
  expect(readGcMark(linked)?.worktree?.finished).toMatchObject({ reason: 'merged into origin/main' });
});

test.each(['pin', 'lock', 'volume'])(
  'keeps a saved finished worktree after its current %s protection changes',
  async (change) => {
    finished();
    await observe();
    if (change === 'pin') writeFileSync(join(linked, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    if (change === 'lock') git(source, 'worktree', 'lock', linked);
    if (change === 'volume') {
      const mark = readGcMark(linked);
      if (!mark) throw new Error('fixture mark missing');
      writeFileSync(gcMarkFile(linked), JSON.stringify({ ...mark, device: mark.device + 1 }));
    }
    const report = await savedWorktreeReports(config, reading(), 'critical', false);
    expect(report[0]?.detail).toContain(change === 'pin' ? 'pinned' : change === 'lock' ? 'locked' : 'changed volume');
    expect(existsSync(linked)).toBe(true);
  },
);

test('reports the optional pushed-idle policy without requiring the normal collector to select an idle deletion', async () => {
  writeFileSync(join(linked, 'feature.txt'), 'unfinished');
  git(linked, 'add', '-A');
  git(linked, 'commit', '-q', '-m', 'unfinished');
  git(linked, 'push', '-q', '-u', 'origin', 'feature');
  await observe();
  expect(readGcMark(linked)?.worktree).toMatchObject({ clean: true, pushed: true, finished: null });
  expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain(
    'not observed finished',
  );
  expect((await savedWorktreeReports(config, reading(), 'critical', true))[0]?.detail).toContain('report only:');
});

test('keeps changed HEAD and independent dirty generations explicit, while malformed optional worktree data leaves output marks valid', async () => {
  finished();
  await observe();
  const original = readGcMark(linked);
  writeFileSync(
    gcMarkFile(linked),
    JSON.stringify({ ...original, worktree: { ...original?.worktree, clean: 'unknown' } }),
  );
  expect(readGcMark(linked)).toMatchObject({ markedAt: original?.markedAt, candidates: original?.candidates });
  expect(readGcMark(linked)?.worktree).toBeUndefined();
  writeFileSync(gcMarkFile(linked), JSON.stringify({ ...original, dirtyAt: new Date(Date.now() + 1).toISOString() }));
  const at = Date.now() + 2;
  await markWriter(config)({ path: linked, at, lastActivityAt: null, kept: null });
  expect(readGcMark(linked)?.worktree?.markedAt).toBe(original?.worktree?.markedAt);
  expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain('due or dirty');
  writeFileSync(gcMarkFile(linked), JSON.stringify(original));
  git(linked, 'commit', '-q', '--allow-empty', '-m', 'moved');
  expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain('HEAD moved');
});

test('saved reports share one device and agent inventory across currently authorized worktrees', async () => {
  finished();
  const other = join(base, 'other');
  git(source, 'worktree', 'add', '-q', '-b', 'feature-two', other, git(linked, 'rev-parse', 'HEAD'));
  writeFileSync(join(other, 'other.txt'), 'other feature');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'other feature');
  git(source, 'merge', '-q', '--no-ff', 'feature-two', '-m', 'other merged');
  git(source, 'push', '-q', 'origin', 'main');
  config.projects[other] = {};
  saveConfig(config);
  recordWorkspaceUse(other, new Date(Date.now() - 10 * day));
  await observe();
  for (const path of [linked, other])
    config.projects[path] = { platforms: { ios: { owned: true, deviceUdid: path, deviceName: 'stim-test' } } };
  saveConfig(config);
  const devices = vi.spyOn(iosDevices, 'listAllIosSimsAsync').mockResolvedValue(
    [linked, other].map((udid) => ({
      udid,
      name: 'stim-test',
      state: 'Shutdown',
      runtime: 'test',
      deviceTypeIdentifier: 'test',
      available: true,
    })),
  );
  const agents = vi.spyOn(agentSessions, 'discoverAgentSessions').mockResolvedValue([]);
  const rows = await savedWorktreeReports(config, reading(), 'critical', false);
  expect(rows).toEqual([
    expect.objectContaining({ detail: expect.stringContaining('report only:') }),
    expect.objectContaining({ detail: expect.stringContaining('report only:') }),
  ]);
  expect(agents).toHaveBeenCalledTimes(1);
  expect(devices).toHaveBeenCalledTimes(1);
}, 20_000);

test.each(['custom ignored', 'hidden index'])(
  'saved reports keep %s layouts without filesystem edit walks',
  async (layout) => {
    finished();
    await observe();
    if (layout === 'custom ignored') {
      writeFileSync(join(source, '.git', 'info', 'exclude'), 'custom-cache/\n');
      mkdirSync(join(linked, 'custom-cache'));
      writeFileSync(join(linked, 'custom-cache', 'private.txt'), 'keep');
    } else git(linked, 'update-index', '--assume-unchanged', 'package.json');
    const ignored = vi
      .spyOn(discoveredRemoval, 'ignoredFilesHold')
      .mockRejectedValue(new Error('must not walk ignored paths'));
    const removal = vi
      .spyOn(discoveredRemoval, 'discoveredRemovalHold')
      .mockRejectedValue(new Error('must not walk dependencies'));
    const edits = vi
      .spyOn(dependencyEdits, 'checkDependencyEdits')
      .mockRejectedValue(new Error('must not inspect dependencies'));
    const rows = await savedWorktreeReports(config, reading(), 'critical', false);
    expect(rows).toEqual([
      expect.objectContaining({ target: linked, detail: expect.stringContaining('normal eligibility check') }),
    ]);
    expect(ignored).not.toHaveBeenCalled();
    expect(removal).not.toHaveBeenCalled();
    expect(edits).not.toHaveBeenCalled();
  },
  20_000,
);

test('an unrelated proven missing registration does not hide a saved worktree report', async () => {
  finished();
  await observe();
  config.projects[join(base, 'removed-registration')] = {};
  saveConfig(config);
  const rows = await savedWorktreeReports(config, reading(), 'critical', false);
  expect(rows).toContainEqual(
    expect.objectContaining({ target: linked, detail: expect.stringContaining('report only:') }),
  );
}, 20_000);

test('malformed optional worktree evidence leaves the existing output mark readable', async () => {
  await observe();
  const mark = readGcMark(linked);
  if (!mark) throw new Error('fixture mark missing');
  writeFileSync(gcMarkFile(linked), JSON.stringify({ ...mark, worktree: { ...mark.worktree, clean: 'unknown' } }));
  expect(readGcMark(linked)).toEqual({ ...mark, worktree: undefined });
});

test('a registered nested app authorizes its worktree-only saved Git-holder evidence', async () => {
  const app = join(linked, 'apps', 'mobile');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  finished();
  config.projects = { [app]: {} };
  saveConfig(config);
  recordWorkspaceUse(app, new Date(Date.now() - 10 * day));
  await observe();
  const mark = readGcMark(linked);
  expect(mark?.dependencies).toBeUndefined();
  expect(mark?.candidates.some(({ kind }) => kind === 'cargo-target')).toBe(false);
  expect(mark?.worktree?.clean).toBe(true);
  const rows = await savedWorktreeReports(config, reading(), 'critical', false);
  expect(rows).toContainEqual(
    expect.objectContaining({ target: linked, detail: expect.stringContaining('report only:') }),
  );
}, 20_000);

test.each(['dirty', 'expired'])(
  '%s worktree evidence reports uncertainty before its saved blocker',
  async (change) => {
    finished();
    git(source, 'worktree', 'lock', linked);
    await observe();
    const mark = readGcMark(linked);
    if (!mark?.worktree) throw new Error('fixture observation missing');
    expect(mark.worktree.keep?.reason).toContain('locked');
    git(source, 'worktree', 'unlock', linked);
    if (change === 'dirty') mark.dirtyAt = new Date(Date.now() + 1).toISOString();
    else mark.worktree.markedAt = new Date(Date.now() - 2 * day).toISOString();
    writeFileSync(gcMarkFile(linked), JSON.stringify(mark));
    expect((await savedWorktreeReports(config, reading(), 'critical', false))[0]?.detail).toContain('due or dirty');
  },
  20_000,
);

test.each([false, true])(
  'the shared report deadline keeps evidence and awaits cleanup (refusal %s)',
  async (refuse) => {
    finished();
    await observe();
    config.projects[linked] = { platforms: { ios: { owned: true, deviceUdid: 'U1', deviceName: 'stim-test' } } };
    saveConfig(config);
    const before = readFileSync(gcMarkFile(linked), 'utf8');
    const failure = Object.assign(new Error('controlled cleanup refusal'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const cleanup = new AbortController();
    let settled = false;
    let enter = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const agents = vi.spyOn(agentSessions, 'discoverAgentSessions');
    vi.spyOn(iosDevices, 'listAllIosSimsAsync').mockImplementation(async (options) => {
      enter();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener(
          'abort',
          () => {
            settled = true;
            reject(refuse ? failure : options.signal?.reason);
          },
          { once: true },
        ),
      );
      return [];
    });
    const pending = savedWorktreeReports(
      config,
      { ...reading(), operation: testContext({ signal: cleanup.signal }) },
      'critical',
      false,
    );
    const result = pending.then(
      (rows) => ({ rows, error: null }),
      (error: unknown) => ({ rows: null, error }),
    );
    try {
      await entered;
      await vi.advanceTimersByTimeAsync(3000);
      const observed = await result;
      expect(observed.error).toBe(refuse ? failure : null);
      expect(observed.rows?.[0]?.detail).toBe(refuse ? undefined : 'current device or agent use is unknown; it stays');
      expect(settled).toBe(true);
      expect(agents).not.toHaveBeenCalled();
      expect(readFileSync(gcMarkFile(linked), 'utf8')).toBe(before);
    } finally {
      cleanup.abort();
      await result;
    }
  },
  20_000,
);

const normalPlan = (idleDays: number | null = null) =>
  planWorktrees({
    protectedRoot: '',
    pinned: () => false,
    now: Date.now(),
    refresh: false,
    operation: testContext(),
    deviceActivity: async () => [],
    idleDays,
    onObservation: worktreeMarkObserver(config, reading()),
    normalMarks: true,
  });

const normalRemove = async (plan: Awaited<ReturnType<typeof normalPlan>>) => {
  const action = plan.actions.find(({ target }) => target === linked);
  if (!action) throw new Error('fixture worktree removal action missing');
  return executeAction(action, {
    settings: resolveMaintenanceSettings(config),
    protectedRoot: '',
    background: true,
    worktreeSweep: plan.sweep,
    operation: testContext(),
    normalWorktreeMarks: true,
  });
};

describe('normal saved worktree reconciliation', () => {
  test(
    'publishes a missing generation before a current clean finished removal',
    async () => {
      finished();
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      expect(readGcMark(linked)).toBeNull();
      const plan = await normalPlan();
      expect(readGcMark(linked)?.worktree).toMatchObject({
        clean: true,
        finished: { reason: 'merged into origin/main' },
      });
      expect((await normalRemove(plan)).status).toBe('done');
      expect(existsSync(linked)).toBe(false);
    },
    process.platform === 'win32' ? 60_000 : 20_000,
  );

  test('keeps a clean finished removal when generation publication fails', async () => {
    finished();
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    vi.spyOn(cacheFiles, 'writeCacheFile').mockImplementation(() => {});
    const plan = await normalPlan();
    expect(readGcMark(linked)).toBeNull();
    expect((await normalRemove(plan)).status).toBe('kept');
    expect(existsSync(join(linked, 'feature.txt'))).toBe(true);
  }, 20_000);

  test.each(['expired', 'dirty', 'device', 'membership', 'recorded-member', 'scope', 'head'] as const)(
    'preserves a planned worktree when current %s proof changes before removal',
    async (change) => {
      const app = join(linked, 'apps', 'mobile');
      if (change === 'membership' || change === 'recorded-member') {
        mkdirSync(app, { recursive: true });
        writeFileSync(join(app, 'package.json'), '{}');
      }
      finished();
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      const plan = await normalPlan();
      const mark = readGcMark(linked);
      if (!mark?.worktree) throw new Error('fixture worktree mark missing');
      if (change === 'expired') vi.setSystemTime(Date.now() + 2 * day);
      else if (change === 'dirty') {
        vi.setSystemTime(Date.now() + 20 * 60_000);
        mark.dirtyAt = new Date().toISOString();
        writeFileSync(gcMarkFile(linked), JSON.stringify(mark));
      } else if (change === 'device') {
        mark.device++;
        writeFileSync(gcMarkFile(linked), JSON.stringify(mark));
      } else if (change === 'membership' || change === 'recorded-member') {
        if (change === 'membership') {
          config.projects[app] = {};
          saveConfig(config);
        }
        recordWorkspaceUse(app, new Date());
      } else if (change === 'scope') {
        config.projects = {};
        saveConfig(config);
        rmSync(workspaceDir(linked), { recursive: true, force: true });
      } else {
        writeFileSync(join(linked, 'feature.txt'), 'new commit after selection');
        git(linked, 'add', '-A');
        git(linked, 'commit', '-q', '-m', 'new HEAD');
      }
      expect((await normalRemove(plan)).status).toBe(change === 'head' ? 'failed' : 'kept');
      expect(existsSync(join(linked, 'feature.txt'))).toBe(true);
    },
    20_000,
  );

  test('removes an unregistered discovered plain Node worktree with current finished evidence', async () => {
    config.projects = {};
    config.maintenance = { autoDiscover: false, discoverRoots: [base] };
    saveConfig(config);
    rmSync(workspaceDir(linked), { recursive: true, force: true });
    writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'cli' }));
    finished();
    vi.setSystemTime(Date.now() + 10 * day);
    const plan = await normalPlan();
    expect(readGcMark(linked)?.worktree?.finished).toBeTruthy();
    expect((await normalRemove(plan)).status).toBe('done');
    expect(existsSync(linked)).toBe(false);
  }, 20_000);

  test('keeps a discovered worktree when only a reduce-only route remains', async () => {
    config.projects = {};
    config.maintenance = { autoDiscover: false, discoverRoots: [base] };
    saveConfig(config);
    rmSync(workspaceDir(linked), { recursive: true, force: true });
    writeFileSync(join(linked, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    finished();
    vi.setSystemTime(Date.now() + 10 * day);
    const plan = await normalPlan();
    const saved = readFileSync(gcMarkFile(linked));
    vi.stubEnv('HOME', join(base, 'host'));
    vi.stubEnv('USERPROFILE', join(base, 'host'));
    vi.stubEnv('STIM_HOME', '');
    config.maintenance = { autoDiscover: true, discoverRoots: [base] };
    saveConfig(config);
    mkdirSync(dirname(gcMarkFile(linked)), { recursive: true });
    writeFileSync(gcMarkFile(linked), saved);
    mkdirSync(dirname(discoveryScanFile()), { recursive: true });
    writeFileSync(
      discoveryScanFile(),
      JSON.stringify({
        version: 2,
        completedAt: 1,
        lowScanAt: 0,
        ranAt: 1,
        durationMs: 1,
        trigger: 'weekly',
        visited: 1,
        found: [linked],
        dotFolderFound: [],
        unreadable: [],
        truncated: false,
        truncation: 'none',
      }),
    );
    const broad = vi.spyOn(discovery, 'discoverCheckouts').mockRejectedValue(new Error('must not rediscover'));
    const result = await normalRemove(plan);
    expect(result.status).toBe('kept');
    expect(result.detail).toContain('saved discovery classification');
    expect(broad).not.toHaveBeenCalled();
    expect(existsSync(linked)).toBe(true);
  }, 20_000);

  test('keeps the real claimed checkout when its current exact route becomes reduce-only', async () => {
    finished();
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    const plan = await normalPlan();
    config.projects = {};
    config.maintenance = { autoDiscover: false, discoverRoots: [base] };
    saveConfig(config);
    rmSync(workspaceDir(linked), { recursive: true, force: true });
    vi.spyOn(discovery, 'targetedCheckouts').mockResolvedValue([
      { path: linked, from: base, origin: 'worktree', reduceOnly: true },
    ]);
    expect((await normalRemove(plan)).status).toBe('kept');
    expect(existsSync(linked)).toBe(true);
  }, 20_000);

  test('does not promote a reduce-only normal inventory row to whole-worktree removal', async () => {
    finished();
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    const plan = await normalPlan();
    const candidate = plan.sweep.worktrees.find(({ path }) => path === linked);
    if (!candidate) throw new Error('fixture worktree candidate missing');
    candidate.reduceOnly = true;
    expect((await normalRemove(plan)).status).toBe('kept');
    expect(existsSync(linked)).toBe(true);
  }, 20_000);

  test('uses current planner holder facts once for nested-app shortlisting', async () => {
    const roots = [linked];
    for (let i = 1; i < 3; i++) {
      const root = join(base, `linked-${i}`);
      git(source, 'worktree', 'add', '-q', '-b', `feature-${i}`, root);
      roots.push(root);
    }
    config.projects = {};
    rmSync(workspaceDir(linked), { recursive: true, force: true });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    for (const root of roots) {
      const app = join(root, 'apps', 'mobile');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'package.json'), '{}');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'unfinished app');
      git(root, 'push', '-q', '-u', 'origin', 'HEAD');
      config.projects[app] = {};
      recordWorkspaceUse(app, new Date(Date.now() - 10 * day));
    }
    saveConfig(config);
    await observe();
    for (const root of roots) expect(readGcMark(root)?.worktree?.finished).toBeNull();
    const holder = vi.spyOn(gitWorktrees, 'resolveSourceCheckoutAsync');
    const plan = await normalPlan();
    expect(plan.actions).toEqual([]);
    expect(holder.mock.calls.filter(([, options]) => options?.cache === false).length).toBeLessThanOrEqual(
      roots.length,
    );
  }, 30_000);

  test('defers external completion of a fresh unfinished generation without rewriting it, then refreshes when due', async () => {
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    writeFileSync(join(linked, 'feature.txt'), 'feature');
    git(linked, 'add', '-A');
    git(linked, 'commit', '-q', '-m', 'feature');
    git(linked, 'push', '-q', '-u', 'origin', 'feature');
    await observe();
    expect(readGcMark(linked)?.worktree).toMatchObject({ clean: true, finished: null, emptyBranch: false });
    const before = readFileSync(gcMarkFile(linked), 'utf8');
    git(source, 'merge', '-q', '--no-ff', 'feature', '-m', 'merged externally');
    git(source, 'push', '-q', 'origin', 'main');
    const merge = vi.spyOn(mergeState, 'mergeStateAsync');
    const markModule = await import('../daemon/worktree-marks.ts');
    const publish = vi.fn<ReturnType<typeof worktreeMarkObserver>>(async () => {});
    const producer = vi.spyOn(markModule, 'worktreeMarkObserver').mockReturnValue(publish);
    const plan = await normalPlan();
    expect(plan.actions).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(readFileSync(gcMarkFile(linked), 'utf8')).toBe(before);
    producer.mockRestore();
    expect(existsSync(linked)).toBe(true);
    vi.setSystemTime(Date.now() + 2 * day);
    const refreshed = await normalPlan();
    expect(readGcMark(linked)?.worktree?.finished).not.toBeNull();
    expect((await normalRemove(refreshed)).status).toBe('done');
    expect(existsSync(linked)).toBe(false);
  }, 20_000);

  test.each(['empty', 'pushed-idle'] as const)(
    'preserves the existing %s path without saved publication',
    async (mode) => {
      if (mode === 'pushed-idle') {
        writeFileSync(join(linked, 'feature.txt'), 'feature');
        git(linked, 'add', '-A');
        git(linked, 'commit', '-q', '-m', 'feature');
        git(linked, 'push', '-q', '-u', 'origin', 'feature');
        config.maintenance = { autoDiscover: false, removeIdleWorktrees: true };
        saveConfig(config);
      }
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      vi.spyOn(cacheFiles, 'writeCacheFile').mockImplementation(() => {});
      const plan = await normalPlan(mode === 'pushed-idle' ? 1 : null);
      expect(readGcMark(linked)).toBeNull();
      expect((await normalRemove(plan)).status).toBe('done');
      expect(existsSync(linked)).toBe(false);
    },
    20_000,
  );

  describe.skipIf(process.platform === 'win32')('POSIX archive tooling', () => {
    test('preserves the existing dirty-archive path without saved publication', async () => {
      vi.stubEnv('STIM_ARCHIVE_ENABLED', 'true');
      finished();
      writeFileSync(join(linked, 'loose.txt'), 'preserve this edit');
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      vi.spyOn(cacheFiles, 'writeCacheFile').mockImplementation(() => {});
      const plan = await normalPlan();
      expect(readGcMark(linked)).toBeNull();
      expect((await normalRemove(plan)).status).toBe('done');
      expect(existsSync(linked)).toBe(false);
      const archive = readdirSync(worktreeArchiveRoot(), { recursive: true })
        .map(String)
        .find((file) => file.endsWith('untracked.tar'));
      if (!archive) throw new Error('fixture archive missing');
      expect(
        execFileSync('tar', ['-xOf', join(worktreeArchiveRoot(), archive), 'loose.txt'], { encoding: 'utf8' }),
      ).toBe('preserve this edit');
    }, 20_000);
  });
});
