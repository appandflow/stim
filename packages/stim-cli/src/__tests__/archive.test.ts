import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readArchives,
  archiveDir,
  linkReplacedArchives,
  pullRequestCacheFile,
  type ArchivedWorkspace,
  maintenanceRunClaims,
} from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { createStim } from '../api.ts';
import { archiveWorkspace, enforceArchiveRetention, sweepArchiveStaging } from '../archive.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';
import { testContext } from './_context.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

const archiveIo = vi.hoisted(
  (): {
    afterRename?: (from: unknown, to: unknown) => void;
    afterRemove?: (path: unknown) => void;
    afterWrite?: (path: unknown) => Promise<void>;
  } => ({}),
);
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const result = fs.renameSync(...args);
      archiveIo.afterRename?.(...args);
      return result;
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const result = await fs.rename(...args);
      archiveIo.afterRename?.(...args);
      return result;
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const result = await fs.rm(...args);
      archiveIo.afterRemove?.(args[0]);
      return result;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await fs.writeFile(...args);
      await archiveIo.afterWrite?.(args[0]);
      return result;
    },
  };
});

const archiveClaimFault = vi.hoisted(() => ({ unavailable: false }));
vi.mock('@stim-cli/core/ownership-claim', async (importOriginal) => {
  const claims = await importOriginal<typeof import('@stim-cli/core/ownership-claim')>();
  return {
    ...claims,
    tryAcquireClaim: (options: Parameters<typeof claims.tryAcquireClaim>[0]) => {
      if (archiveClaimFault.unavailable && options.root.includes('.incoming-'))
        throw new claims.ClaimUnavailableError('identity unavailable');
      return claims.tryAcquireClaim(options);
    },
  };
});

let home: string;
let root: string;
const DAY = 86_400_000;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-archive-')));
  root = join(home, 'project');
  mkdirSync(root);
  process.env.STIM_HOME = home;
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  setExecutor({ runQuiet: () => null, runFileQuiet: () => null, runFile: () => '', run: () => '' });
});
afterEach(() => {
  archiveIo.afterRename = undefined;
  archiveIo.afterRemove = undefined;
  archiveIo.afterWrite = undefined;
  archiveClaimFault.unavailable = false;
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key === 'STIM_HOME' || key.startsWith('STIM_ARCHIVE_') || key === 'STIM_RECORDING') delete process.env[key];
});

function live() {
  upsertProject(root, {});
  const dir = ensureWorkspaceStorage(root);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      lastUsedAt: '2026-01-01T00:00:00Z',
      collectors: {},
      warm: {},
      launches: { ios: { pid: 4, bundleId: 'app' } },
    }),
  );
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'metro.ndjson'), 'saved logs');
  return dir;
}

function fixture(
  id: string,
  at: number,
  kinds: Partial<Record<'logs' | 'recordings' | 'agentActions', number>> = {},
): ArchivedWorkspace {
  const dir = archiveDir(id);
  mkdirSync(dir, { recursive: true });
  const bytes = { logs: 0, recordings: 0, agentActions: 0, record: 100, total: 100, ...kinds };
  for (const [kind, path] of [
    ['logs', 'logs/a.ndjson'],
    ['recordings', 'recordings/ios-default/1-2.seg'],
    ['agentActions', 'agent-device/sessions/a/requests/1.json'],
  ] as const) {
    if (!bytes[kind]) continue;
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), Buffer.alloc(bytes[kind]));
    bytes.total += bytes[kind];
  }
  writeFileSync(join(dir, 'state.json'), '{}');
  const archive: ArchivedWorkspace = {
    id,
    projectRoot: root,
    project: 'project',
    workspace: 'project',
    removedAt: new Date(at).toISOString(),
    removedBy: 'gc',
    lastUsedAt: null,
    worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes,
    expires: { logs: null, recordings: null, agentActions: null, record: null },
    version: 1,
  };
  writeFileSync(join(dir, 'archive.json'), JSON.stringify(archive));
  return archive;
}

test('a cancelled archive request leaves live history untouched', async () => {
  const dir = live();
  const controller = new AbortController();
  const cancelled = new Error('cancel archive admission');
  controller.abort(cancelled);
  await expect(
    Promise.resolve().then(() => archiveWorkspace(root, 'gc', undefined, testContext({ signal: controller.signal }))),
  ).rejects.toBe(cancelled);
  expect(readFileSync(join(dir, 'logs', 'metro.ndjson'), 'utf8')).toBe('saved logs');
  expect(readArchives()).toEqual([]);
});

test.each(['show', 'merge-base'])('an unresolved Git %s probe cannot start moving history', async (command) => {
  const dir = live();
  const refusal = new WorkspaceProcessCleanupError([], 'Git child cannot be verified.', 'Inspect the child.');
  setExecutor({
    runFileAsync: async (_file, args) => {
      if (args.includes(command)) throw refusal;
      if (args.includes('symbolic-ref')) return 'refs/remotes/origin/main';
      if (args.includes('show')) return 'head\nsubject';
      return 'head';
    },
  });
  await expect(archiveWorkspace(root, 'gc', undefined, testContext())).rejects.toBe(refusal);
  expect(readFileSync(join(dir, 'logs', 'metro.ndjson'), 'utf8')).toBe('saved logs');
  expect(readArchives()).toEqual([]);
});

test('cancellation after history moves publishes it and skips retention', async () => {
  const dir = live();
  fixture('retained', Date.now() - DAY, { logs: 5 });
  process.env.STIM_ARCHIVE_MAX_COUNT = '1';
  const controller = new AbortController();
  const cancelled = new Error('cancel after moving history');
  archiveIo.afterRename = (from) => {
    if (String(from) === join(dir, 'logs')) controller.abort(cancelled);
  };
  await expect(
    Promise.resolve().then(() => archiveWorkspace(root, 'gc', undefined, testContext({ signal: controller.signal }))),
  ).rejects.toBe(cancelled);
  expect(controller.signal.aborted).toBe(true);
  const published = readArchives().find((entry) => entry.id !== 'retained');
  if (!published) throw new Error('The moved history was not published.');
  expect(readFileSync(join(archiveDir(published.id), 'logs', 'metro.ndjson'), 'utf8')).toBe('saved logs');
  expect(existsSync(archiveDir('retained'))).toBe(true);
  expect(readdirSync(join(home, 'archive')).filter((name) => name.startsWith('.incoming-'))).toEqual([]);
});

test('archive publication keeps the archive lock while its filesystem writes are pending', async () => {
  live();
  let enter = () => {};
  let finish = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  archiveIo.afterWrite = async (file) => {
    if (!String(file).includes('.incoming-')) return;
    enter();
    await release;
  };
  const publishing = archiveWorkspace(root, 'gc');
  try {
    await entered;
    await expect(sweepArchiveStaging(false)).rejects.toMatchObject({ code: 'STIM_LOCK_TIMEOUT' });
  } finally {
    finish();
    await publishing;
  }
  expect(readArchives()).toHaveLength(1);
  expect(readdirSync(join(home, 'archive')).filter((name) => name.startsWith('.incoming-'))).toEqual([]);
});

test('public archive GC cancellation stops after the completed deletion and releases admission', async () => {
  fixture('first', Date.now(), { logs: 5 });
  fixture('later', Date.now() - DAY, { logs: 5 });
  const controller = new AbortController();
  const moved: string[] = [];
  archiveIo.afterRename = (from) => {
    if (String(from) === archiveDir('first') || String(from) === archiveDir('later')) {
      moved.push(String(from));
      controller.abort();
    }
  };
  const client = createStim({ projectRoot: root, home, env: { ...process.env } });
  await expect(
    client.collectGarbage({ cache: 'archived', delete: true, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(moved).toHaveLength(1);
  expect(readArchives().map((entry) => entry.id)).toEqual(['later']);
  expect(readFileSync(join(archiveDir('later'), 'logs', 'a.ndjson'))).toEqual(Buffer.alloc(5));
  const admission = readClaimSet(maintenanceRunClaims());
  expect(admission.live).toEqual([]);
  expect(admission.unresolved).toEqual([]);
});

test('removal keeps history and closed footage while deleting open footage and outputs', async () => {
  const dir = live();
  writeFileSync(join(dir, 'ended-agents.json'), '{"sessions":[]}');
  writeFileSync(join(dir, 'log-error-index.json'), '{"files":{}}');
  mkdirSync(join(dir, 'recordings', 'ios-default'), { recursive: true });
  writeFileSync(join(dir, 'recordings', 'ios-default', '1-2.seg'), 'closed');
  writeFileSync(join(dir, 'recordings', 'ios-default', '3.part'), 'open');
  mkdirSync(join(dir, 'derived-data'));
  writeFileSync(join(dir, 'derived-data', 'app'), 'discard');
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await reclaimProject(root, { archive: { removedBy: 'worktree-remove' } });
  const [archive] = readArchives();
  expect(archive?.id).toMatch(/^project--[\da-f]+--\d+$/);
  expect(archive?.removedBy).toBe('worktree-remove');
  const archived = archiveDir(archive!.id);
  expect(JSON.parse(readFileSync(join(archived, 'state.json'), 'utf8'))).toEqual({
    lastUsedAt: '2026-01-01T00:00:00Z',
    launches: { ios: { bundleId: 'app' } },
  });
  for (const name of [
    'ended-agents.json',
    'log-error-index.json',
    'logs/metro.ndjson',
    'recordings/ios-default/1-2.seg',
  ])
    expect(existsSync(join(archived, name))).toBe(true);
  expect(existsSync(join(archived, 'recordings/ios-default/3.part'))).toBe(false);
  expect(existsSync(dir)).toBe(false);
  expect(out).not.toHaveBeenCalled();
  expect(err).not.toHaveBeenCalled();
});

function cachePullRequest(worktree: string, state: 'merged' | 'open') {
  const file = pullRequestCacheFile(worktree);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      path: worktree,
      branch: 'feat/12-gone',
      head: 'a'.repeat(40),
      checkedAt: '2026-01-01T00:00:00Z',
      pullRequest: {
        number: 12,
        url: 'https://example.test/pull/12',
        title: 'Gone',
        state,
        checkedAt: '2026-01-01T00:00:00Z',
      },
    }),
  );
}

test('a workspace whose worktree folder is gone keeps the branch and pull request the cache saw', async () => {
  const worktree = join(home, 'gone-worktree');
  root = join(worktree, 'apps', 'mobile');
  live();
  cachePullRequest(worktree, 'merged');
  await archiveWorkspace(root, 'gc');
  expect(readArchives()[0]?.worktree).toEqual({
    repository: null,
    branch: 'feat/12-gone',
    head: 'a'.repeat(40),
    subject: null,
    merged: true,
    pullRequest: { number: 12, state: 'merged', title: 'Gone', url: 'https://example.test/pull/12' },
  });
});

test("a gone project inside a checkout that still exists does not take that checkout's pull request", async () => {
  const checkout = join(home, 'checkout');
  mkdirSync(checkout);
  root = join(checkout, 'apps', 'mobile');
  live();
  cachePullRequest(checkout, 'open');
  await archiveWorkspace(root, 'gc');
  expect(readArchives()[0]?.worktree).toEqual({
    repository: null,
    branch: null,
    head: null,
    subject: null,
    merged: null,
    pullRequest: null,
  });
});

test('scoped homes do not archive unless explicitly enabled', async () => {
  live();
  delete process.env.STIM_ARCHIVE_ENABLED;
  await archiveWorkspace(root, 'worktree-remove');
  expect(readArchives()).toEqual([]);
});

test('empty workspace stubs do not create archives', async () => {
  ensureWorkspaceStorage(root);
  await archiveWorkspace(root, 'gc');
  expect(readArchives()).toEqual([]);
});

test('disabled archive override preserves no history', async () => {
  live();
  process.env.STIM_ARCHIVE_ENABLED = 'false';
  await reclaimProject(root, { archive: { removedBy: 'gc' } });
  expect(readArchives()).toEqual([]);
  expect(existsSync(workspaceDir(root))).toBe(false);
});

test('a deleted root whose repo layer could disable archives fails closed', async () => {
  live();
  saveConfig({ ...loadConfig(), repos: { '/elsewhere/.git': { settings: { archive: { enabled: false } } } } } as never);
  rmSync(root, { recursive: true, force: true });
  await archiveWorkspace(root, 'gc');
  expect(readArchives()).toEqual([]);
});

test('a mid-archive failure removes staging and does not block removal or print stdout', async () => {
  const dir = live();
  const sessions = join(dir, 'agent-device', 'sessions');
  mkdirSync(join(sessions, '..'), { recursive: true });
  symlinkSync(root, sessions, process.platform === 'win32' ? 'junction' : 'dir');
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await reclaimProject(root, { archive: { removedBy: 'gc' } });
  expect(result.keptEntry).toBe(false);
  expect(readArchives()).toEqual([]);
  expect(readdirSync(join(home, 'archive')).filter((name) => name.startsWith('.incoming-'))).toEqual([]);
  expect(existsSync(dir)).toBe(false);
  expect(out).not.toHaveBeenCalled();
  expect(err.mock.calls.map(([line]) => line)).toEqual([expect.stringMatching(/^could not archive: /)]);
});

test('symlink workspace storage is not moved into an archive', async () => {
  const dir = workspaceDir(root);
  mkdirSync(join(dir, '..'), { recursive: true });
  writeFileSync(join(root, 'state.json'), '{}');
  symlinkSync(root, dir, process.platform === 'win32' ? 'junction' : 'dir');
  await archiveWorkspace(root, 'gc');
  expect(readArchives()).toEqual([]);
  expect(lstatSync(dir).isSymbolicLink()).toBe(true);
  expect(existsSync(join(root, 'state.json'))).toBe(true);
});

test('recreating a path starts fresh and links two different removals to the live environment', async () => {
  live();
  await reclaimProject(root, { archive: { removedBy: 'gc' } });
  ensureWorkspaceStorage(root);
  expect(existsSync(join(workspaceDir(root), 'state.json'))).toBe(false);
  const [first] = readArchives();
  expect(linkReplacedArchives(readArchives(), [root])[0]?.replacedBy).toBe(root);
  writeFileSync(join(workspaceDir(root), 'state.json'), '{}');
  await reclaimProject(root, { archive: { removedBy: 'gc' } });
  expect(readArchives()).toHaveLength(2);
  expect(new Set(readArchives().map((entry) => entry.id)).size).toBe(2);
  expect(readArchives().some((entry) => entry.id === first!.id)).toBe(true);
});

test('recording disabled for the workspace leaves closed footage out of its archive', async () => {
  const dir = live();
  upsertProject(root, { settings: { recording: { enabled: false } } });
  mkdirSync(join(dir, 'recordings', 'ios-default'), { recursive: true });
  writeFileSync(join(dir, 'recordings', 'ios-default', '1-2.seg'), 'closed');
  await archiveWorkspace(root, 'gc');
  expect(readArchives()[0]?.bytes.recordings).toBe(0);
});

test('archiving uses the requesting environment for archive and recording settings', async () => {
  const dir = live();
  mkdirSync(join(dir, 'recordings', 'ios-default'), { recursive: true });
  writeFileSync(join(dir, 'recordings', 'ios-default', '1-2.seg'), 'closed footage');
  const env = { ...process.env, STIM_ARCHIVE_ENABLED: 'true', STIM_RECORDING: 'true' };
  process.env.STIM_ARCHIVE_ENABLED = 'false';
  process.env.STIM_RECORDING = 'false';
  await archiveWorkspace(root, 'gc', undefined, testContext({ env }));
  const published = readArchives()[0];
  if (!published) throw new Error('The requesting environment did not enable archiving.');
  expect(readFileSync(join(archiveDir(published.id), 'logs', 'metro.ndjson'), 'utf8')).toBe('saved logs');
  expect(readFileSync(join(archiveDir(published.id), 'recordings', 'ios-default', '1-2.seg'), 'utf8')).toBe(
    'closed footage',
  );
});

test('expired kinds disappear in age order while the record survives', async () => {
  const now = Date.now();
  fixture('old', now - 8 * DAY, { recordings: 8, agentActions: 7, logs: 6 });
  await enforceArchiveRetention(now);
  expect(readArchives()[0]?.bytes).toMatchObject({ recordings: 0, agentActions: 0, logs: 6 });
  await enforceArchiveRetention(now + 7 * DAY);
  expect(readArchives()[0]?.bytes).toMatchObject({ recordings: 0, agentActions: 0, logs: 0 });
  expect(existsSync(join(archiveDir('old'), 'state.json'))).toBe(true);
  expect(readArchives()[0]?.expires.logs).toBeNull();
});

test('log caps remove oldest rotation then build logs before other files', async () => {
  fixture('logs', Date.now(), { logs: 50 });
  const dir = join(archiveDir('logs'), 'logs');
  rmSync(join(dir, 'a.ndjson'));
  for (const name of ['device.ndjson.2', 'device.ndjson.1', 'build-ios.ndjson', 'other-old.log', 'other-new.log']) {
    writeFileSync(join(dir, name), Buffer.alloc(10));
    utimesSync(join(dir, name), new Date(0), new Date(name === 'other-new.log' ? 1000 : 0));
  }
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(40 / 1024 ** 2);
  await enforceArchiveRetention();
  expect(readdirSync(dir)).not.toContain('device.ndjson.2');
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(20 / 1024 ** 2);
  await enforceArchiveRetention();
  expect(readdirSync(dir).toSorted()).toEqual(['other-new.log', 'other-old.log']);
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(10 / 1024 ** 2);
  await enforceArchiveRetention();
  expect(readdirSync(dir)).toEqual(['other-new.log']);
});

test('cancelling log trimming saves the byte count of completed removals', async () => {
  fixture('logs', Date.now(), { logs: 8 });
  const dir = join(archiveDir('logs'), 'logs');
  writeFileSync(join(dir, 'a.ndjson'), Buffer.alloc(4));
  writeFileSync(join(dir, 'b.ndjson'), Buffer.alloc(4));
  utimesSync(join(dir, 'a.ndjson'), new Date(0), new Date(0));
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(4 / 1024 ** 2);
  const controller = new AbortController();
  const cancelled = new Error('cancel log trimming');
  archiveIo.afterRemove = (path) => {
    if (String(path) === join(dir, 'a.ndjson')) controller.abort(cancelled);
  };
  await expect(enforceArchiveRetention(undefined, testContext({ signal: controller.signal }))).rejects.toBe(cancelled);
  expect(readdirSync(dir)).toEqual(['b.ndjson']);
  expect(readArchives()[0]?.bytes.logs).toBe(4);
});

test('total cap removes the oldest archive largest kind before touching newer artifacts', async () => {
  const now = Date.now();
  fixture('old', now - DAY, { logs: 100_000, agentActions: 50_000 });
  fixture('new', now, { logs: 100_000 });
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(160_000 / 1024 ** 3);
  await enforceArchiveRetention(now);
  expect(readArchives().find((entry) => entry.id === 'old')?.bytes).toMatchObject({ logs: 0, agentActions: 50_000 });
  expect(readArchives().find((entry) => entry.id === 'new')?.bytes.logs).toBe(100_000);
});

test('records evicted by count do not count against the total cap that trims survivors', async () => {
  const now = Date.now();
  fixture('old', now - DAY);
  fixture('new', now, { logs: 3000 });
  process.env.STIM_ARCHIVE_MAX_COUNT = '1';
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(3150 / 1024 ** 3);
  await enforceArchiveRetention(now);
  expect(readArchives().map((entry) => [entry.id, entry.bytes.logs])).toEqual([['new', 3000]]);
});

test('recording cap removes only recordings, oldest archive first', async () => {
  const now = Date.now();
  fixture('old', now - DAY, { recordings: 100_000, logs: 150_000 });
  fixture('new', now, { recordings: 100_000 });
  process.env.STIM_ARCHIVE_RECORDINGS_MAX_TOTAL_GB = String(110_000 / 1024 ** 3);
  await enforceArchiveRetention(now);
  expect(readArchives().find((entry) => entry.id === 'old')?.bytes).toMatchObject({ recordings: 0, logs: 150_000 });
  expect(readArchives().find((entry) => entry.id === 'new')?.bytes.recordings).toBe(100_000);
});

test('record age and count remove oldest records after artifacts are trimmed', async () => {
  const now = Date.now();
  fixture('expired', now - 31 * DAY);
  fixture('old', now - DAY);
  fixture('new', now);
  await enforceArchiveRetention(now);
  expect(readArchives().map((entry) => entry.id)).toEqual(['new', 'old']);
  process.env.STIM_ARCHIVE_MAX_COUNT = '1';
  await enforceArchiveRetention(now);
  expect(readArchives().map((entry) => entry.id)).toEqual(['new']);
  expect(readdirSync(join(home, 'archive')).filter((name) => name.startsWith('.removing-'))).toEqual([]);
});

test('turning machine recording off deletes archived footage on retention', async () => {
  fixture('record', Date.now(), { recordings: 10, logs: 8 });
  saveConfig({ version: 2, projects: {}, repos: {}, recording: { enabled: false } });
  await enforceArchiveRetention();
  expect(readArchives()[0]?.bytes).toMatchObject({ recordings: 0, logs: 8 });
});

test.each(['STIM_ARCHIVE_MAX_AGE_DAYS', 'STIM_ARCHIVE_MAX_COUNT'])(
  '%s zero prevents keeping any record',
  async (key) => {
    live();
    process.env[key] = '0';
    await archiveWorkspace(root, 'gc');
    expect(readArchives()).toEqual([]);
    fixture('record', Date.now(), { logs: 5 });
    await enforceArchiveRetention();
    expect(readArchives()).toEqual([]);
  },
);

test.each(['LOGS', 'RECORDINGS', 'AGENT_ACTIONS'])('%s age zero keeps the record without that kind', async (key) => {
  fixture('record', Date.now(), { logs: 5, recordings: 6, agentActions: 7 });
  process.env[`STIM_ARCHIVE_${key}_MAX_AGE_DAYS`] = '0';
  await enforceArchiveRetention();
  expect(readArchives()[0]?.bytes[key === 'LOGS' ? 'logs' : key === 'RECORDINGS' ? 'recordings' : 'agentActions']).toBe(
    0,
  );
  expect(readArchives()).toHaveLength(1);
});

test('staging sweep removes only dead claims and preserves live and unresolved holders', async () => {
  mkdirSync(join(home, 'archive'), { recursive: true });
  for (const id of ['dead', 'live', 'unknown', 'free']) mkdirSync(join(home, 'archive', `.incoming-${id}`));
  plantClaim(join(home, 'archive', '.incoming-dead.claims'), 'exclusive', goneClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-live.claims'), 'exclusive', liveClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-unknown.claims'), 'exclusive', {
    pid: process.pid,
    processToken: 'invalid',
  });
  const entries = await sweepArchiveStaging(true);
  expect(entries.map((entry) => entry.path)).toEqual([
    join(home, 'archive', '.incoming-live'),
    join(home, 'archive', '.incoming-unknown'),
  ]);
  expect(entries.find((entry) => entry.path.endsWith('unknown'))?.removeCommand).toContain('.incoming-unknown.claims');
  expect(existsSync(join(home, 'archive', '.incoming-dead'))).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'archived directories and copied or moved files restrict access to the owner',
  async () => {
    live();
    await archiveWorkspace(root, 'gc');
    const dir = archiveDir(readArchives()[0]!.id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'logs/metro.ndjson')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'archive.json')).mode & 0o777).toBe(0o600);
  },
);

test.each([false, true])(
  'invalid retention settings report once and preserve the archive with context %s',
  async (contextual) => {
    fixture('record', Date.now(), { logs: 5 });
    const env = { ...process.env, STIM_ARCHIVE_MAX_COUNT: '-1' };
    process.env.STIM_ARCHIVE_MAX_COUNT = contextual ? '1' : '-1';
    const messages: [string, string][] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enforceArchiveRetention(
      undefined,
      contextual
        ? testContext({
            env,
            output: (stream, text) => {
              messages.push([stream, text]);
            },
          })
        : undefined,
    );
    expect(readArchives()[0]?.bytes.logs).toBe(5);
    const warning = expect.stringMatching(/^could not enforce archive retention: Invalid STIM_ARCHIVE_MAX_COUNT/);
    expect(err.mock.calls).toEqual(contextual ? [] : [[warning]]);
    expect(messages).toEqual(contextual ? [['stderr', warning]] : []);
  },
);

test('zero total caps remove artifacts while preserving workspace history', async () => {
  fixture('record', Date.now(), { logs: 5, recordings: 6, agentActions: 7 });
  process.env.STIM_ARCHIVE_RECORDINGS_MAX_TOTAL_GB = '0';
  await enforceArchiveRetention();
  expect(readArchives()[0]?.bytes).toMatchObject({ logs: 5, recordings: 0, agentActions: 7 });
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = '0';
  await enforceArchiveRetention();
  expect(readArchives()[0]?.bytes).toMatchObject({ logs: 0, recordings: 0, agentActions: 0 });
  expect(existsSync(join(archiveDir('record'), 'state.json'))).toBe(true);
});

test('archive state drops volatile fields and copies workspace-local agent actions', async () => {
  const dir = live();
  mkdirSync(join(dir, 'agent-device', 'sessions', 'one', 'requests'), { recursive: true });
  writeFileSync(join(dir, 'agent-device', 'sessions', 'one', 'requests', 'action.json'), 'typed text');
  await archiveWorkspace(root, 'maintenance', {
    supervisor: { pid: 1 },
    collectors: { pid: 2 },
    warm: {},
    lastBuild: { pid: 3, cacheKey: 'key' },
  });
  const record = readArchives()[0]!;
  expect(record.removedBy).toBe('maintenance');
  expect(JSON.parse(readFileSync(join(archiveDir(record.id), 'state.json'), 'utf8'))).toEqual({
    lastBuild: { cacheKey: 'key' },
  });
  expect(record.bytes.agentActions).toBe(10);
  expect(readFileSync(join(archiveDir(record.id), 'agent-device/sessions/one/requests/action.json'), 'utf8')).toBe(
    'typed text',
  );
});

test('unavailable process identity skips archive writes and still removes the workspace', async () => {
  const dir = live();
  archiveClaimFault.unavailable = true;
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await reclaimProject(root, { archive: { removedBy: 'gc' } });
  expect(readArchives()).toEqual([]);
  expect(existsSync(dir)).toBe(false);
  expect(readdirSync(join(home, 'archive'))).toEqual([]);
  expect(err.mock.calls).toEqual([[expect.stringMatching(/^could not archive:/)]]);
});
