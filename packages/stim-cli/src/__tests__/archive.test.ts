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
import { readArchives, archiveDir, linkReplacedArchives, type ArchivedWorkspace } from '@stim-cli/core/state';
import { archiveWorkspace, enforceArchiveRetention, sweepArchiveStaging } from '../archive.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

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

test('scoped homes do not archive unless explicitly enabled', () => {
  live();
  delete process.env.STIM_ARCHIVE_ENABLED;
  archiveWorkspace(root, 'worktree-remove');
  expect(readArchives()).toEqual([]);
});

test('empty workspace stubs do not create archives', () => {
  ensureWorkspaceStorage(root);
  archiveWorkspace(root, 'gc');
  expect(readArchives()).toEqual([]);
});

test('disabled archive override preserves no history', async () => {
  live();
  process.env.STIM_ARCHIVE_ENABLED = 'false';
  await reclaimProject(root, { archive: { removedBy: 'gc' } });
  expect(readArchives()).toEqual([]);
  expect(existsSync(workspaceDir(root))).toBe(false);
});

test('a deleted root whose repo layer could disable archives fails closed', () => {
  live();
  saveConfig({ ...loadConfig(), repos: { '/elsewhere/.git': { settings: { archive: { enabled: false } } } } } as never);
  rmSync(root, { recursive: true, force: true });
  archiveWorkspace(root, 'gc');
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

test('symlink workspace storage is not moved into an archive', () => {
  const dir = workspaceDir(root);
  mkdirSync(join(dir, '..'), { recursive: true });
  writeFileSync(join(root, 'state.json'), '{}');
  symlinkSync(root, dir, process.platform === 'win32' ? 'junction' : 'dir');
  archiveWorkspace(root, 'gc');
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

test('recording disabled for the workspace leaves closed footage out of its archive', () => {
  const dir = live();
  upsertProject(root, { settings: { recording: { enabled: false } } });
  mkdirSync(join(dir, 'recordings', 'ios-default'), { recursive: true });
  writeFileSync(join(dir, 'recordings', 'ios-default', '1-2.seg'), 'closed');
  archiveWorkspace(root, 'gc');
  expect(readArchives()[0]?.bytes.recordings).toBe(0);
});

test('expired kinds disappear in age order while the record survives', () => {
  const now = Date.now();
  fixture('old', now - 8 * DAY, { recordings: 8, agentActions: 7, logs: 6 });
  enforceArchiveRetention(now);
  expect(readArchives()[0]?.bytes).toMatchObject({ recordings: 0, agentActions: 0, logs: 6 });
  enforceArchiveRetention(now + 7 * DAY);
  expect(readArchives()[0]?.bytes).toMatchObject({ recordings: 0, agentActions: 0, logs: 0 });
  expect(existsSync(join(archiveDir('old'), 'state.json'))).toBe(true);
  expect(readArchives()[0]?.expires.logs).toBeNull();
});

test('log caps remove oldest rotation then build logs before other files', () => {
  fixture('logs', Date.now(), { logs: 50 });
  const dir = join(archiveDir('logs'), 'logs');
  rmSync(join(dir, 'a.ndjson'));
  for (const name of ['device.ndjson.2', 'device.ndjson.1', 'build-ios.ndjson', 'other-old.log', 'other-new.log']) {
    writeFileSync(join(dir, name), Buffer.alloc(10));
    utimesSync(join(dir, name), new Date(0), new Date(name === 'other-new.log' ? 1000 : 0));
  }
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(40 / 1024 ** 2);
  enforceArchiveRetention();
  expect(readdirSync(dir)).not.toContain('device.ndjson.2');
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(20 / 1024 ** 2);
  enforceArchiveRetention();
  expect(readdirSync(dir).toSorted()).toEqual(['other-new.log', 'other-old.log']);
  process.env.STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE = String(10 / 1024 ** 2);
  enforceArchiveRetention();
  expect(readdirSync(dir)).toEqual(['other-new.log']);
});

test('total cap removes the oldest archive largest kind before touching newer artifacts', () => {
  const now = Date.now();
  fixture('old', now - DAY, { logs: 100_000, agentActions: 50_000 });
  fixture('new', now, { logs: 100_000 });
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(160_000 / 1024 ** 3);
  enforceArchiveRetention(now);
  expect(readArchives().find((entry) => entry.id === 'old')?.bytes).toMatchObject({ logs: 0, agentActions: 50_000 });
  expect(readArchives().find((entry) => entry.id === 'new')?.bytes.logs).toBe(100_000);
});

test('records evicted by count do not count against the total cap that trims survivors', () => {
  const now = Date.now();
  fixture('old', now - DAY);
  fixture('new', now, { logs: 3000 });
  process.env.STIM_ARCHIVE_MAX_COUNT = '1';
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(3150 / 1024 ** 3);
  enforceArchiveRetention(now);
  expect(readArchives().map((entry) => [entry.id, entry.bytes.logs])).toEqual([['new', 3000]]);
});

test('recording cap removes only recordings, oldest archive first', () => {
  const now = Date.now();
  fixture('old', now - DAY, { recordings: 100_000, logs: 150_000 });
  fixture('new', now, { recordings: 100_000 });
  process.env.STIM_ARCHIVE_RECORDINGS_MAX_TOTAL_GB = String(110_000 / 1024 ** 3);
  enforceArchiveRetention(now);
  expect(readArchives().find((entry) => entry.id === 'old')?.bytes).toMatchObject({ recordings: 0, logs: 150_000 });
  expect(readArchives().find((entry) => entry.id === 'new')?.bytes.recordings).toBe(100_000);
});

test('record age and count remove oldest records after artifacts are trimmed', () => {
  const now = Date.now();
  fixture('expired', now - 31 * DAY);
  fixture('old', now - DAY);
  fixture('new', now);
  enforceArchiveRetention(now);
  expect(readArchives().map((entry) => entry.id)).toEqual(['new', 'old']);
  process.env.STIM_ARCHIVE_MAX_COUNT = '1';
  enforceArchiveRetention(now);
  expect(readArchives().map((entry) => entry.id)).toEqual(['new']);
  expect(readdirSync(join(home, 'archive')).filter((name) => name.startsWith('.removing-'))).toEqual([]);
});

test('turning machine recording off deletes archived footage on retention', () => {
  fixture('record', Date.now(), { recordings: 10, logs: 8 });
  saveConfig({ version: 2, projects: {}, repos: {}, recording: { enabled: false } });
  enforceArchiveRetention();
  expect(readArchives()[0]?.bytes).toMatchObject({ recordings: 0, logs: 8 });
});

test.each(['STIM_ARCHIVE_MAX_AGE_DAYS', 'STIM_ARCHIVE_MAX_COUNT'])('%s zero prevents keeping any record', (key) => {
  live();
  process.env[key] = '0';
  archiveWorkspace(root, 'gc');
  expect(readArchives()).toEqual([]);
  fixture('record', Date.now(), { logs: 5 });
  enforceArchiveRetention();
  expect(readArchives()).toEqual([]);
});

test.each(['LOGS', 'RECORDINGS', 'AGENT_ACTIONS'])('%s age zero keeps the record without that kind', (key) => {
  fixture('record', Date.now(), { logs: 5, recordings: 6, agentActions: 7 });
  process.env[`STIM_ARCHIVE_${key}_MAX_AGE_DAYS`] = '0';
  enforceArchiveRetention();
  expect(readArchives()[0]?.bytes[key === 'LOGS' ? 'logs' : key === 'RECORDINGS' ? 'recordings' : 'agentActions']).toBe(
    0,
  );
  expect(readArchives()).toHaveLength(1);
});

test('staging sweep removes only dead claims and preserves live and unresolved holders', () => {
  mkdirSync(join(home, 'archive'), { recursive: true });
  for (const id of ['dead', 'live', 'unknown', 'free']) mkdirSync(join(home, 'archive', `.incoming-${id}`));
  plantClaim(join(home, 'archive', '.incoming-dead.claims'), 'exclusive', goneClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-live.claims'), 'exclusive', liveClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-unknown.claims'), 'exclusive', {
    pid: process.pid,
    processToken: 'invalid',
  });
  const entries = sweepArchiveStaging(true);
  expect(entries.map((entry) => entry.path)).toEqual([
    join(home, 'archive', '.incoming-live'),
    join(home, 'archive', '.incoming-unknown'),
  ]);
  expect(entries.find((entry) => entry.path.endsWith('unknown'))?.removeCommand).toContain('.incoming-unknown.claims');
  expect(existsSync(join(home, 'archive', '.incoming-dead'))).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'archived directories and copied or moved files restrict access to the owner',
  () => {
    live();
    archiveWorkspace(root, 'gc');
    const dir = archiveDir(readArchives()[0]!.id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'logs/metro.ndjson')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'archive.json')).mode & 0o777).toBe(0o600);
  },
);

test('invalid retention settings report once and preserve the archive', () => {
  fixture('record', Date.now(), { logs: 5 });
  process.env.STIM_ARCHIVE_MAX_COUNT = '-1';
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  enforceArchiveRetention();
  expect(readArchives()[0]?.bytes.logs).toBe(5);
  expect(err.mock.calls).toEqual([
    [expect.stringMatching(/^could not enforce archive retention: Invalid STIM_ARCHIVE_MAX_COUNT/)],
  ]);
});

test('zero total caps remove artifacts while preserving workspace history', () => {
  fixture('record', Date.now(), { logs: 5, recordings: 6, agentActions: 7 });
  process.env.STIM_ARCHIVE_RECORDINGS_MAX_TOTAL_GB = '0';
  enforceArchiveRetention();
  expect(readArchives()[0]?.bytes).toMatchObject({ logs: 5, recordings: 0, agentActions: 7 });
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = '0';
  enforceArchiveRetention();
  expect(readArchives()[0]?.bytes).toMatchObject({ logs: 0, recordings: 0, agentActions: 0 });
  expect(existsSync(join(archiveDir('record'), 'state.json'))).toBe(true);
});

test('archive state drops volatile fields and copies workspace-local agent actions', () => {
  const dir = live();
  mkdirSync(join(dir, 'agent-device', 'sessions', 'one', 'requests'), { recursive: true });
  writeFileSync(join(dir, 'agent-device', 'sessions', 'one', 'requests', 'action.json'), 'typed text');
  archiveWorkspace(root, 'maintenance', {
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
