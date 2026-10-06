import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDir, readArchives } from '@stim-cli/core/state';
import { collectGcReport, runGc } from '../commands/gc.ts';
import { selectCaches } from '../commands/gc/caches.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig } from '../workspace/config.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-archives-')));
  process.env.STIM_HOME = home;
  setExecutor({
    run: () => '',
    runFile: () => '',
    runQuiet: () => null,
    runFileQuiet: () => null,
    runFileAsync: async () => '',
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = undefined;
});

function fixture(id: string, removedAt = Date.now()) {
  const dir = archiveDir(id);
  mkdirSync(dir, { recursive: true });
  for (const path of ['logs/metro.ndjson', 'recordings/ios-default/1-2.seg', 'agent-device/sessions/a/request.json']) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), 'bytes');
  }
  const record = {
    id,
    projectRoot: '/gone',
    project: 'gone',
    workspace: 'gone',
    removedAt: new Date(removedAt).toISOString(),
    removedBy: 'gc',
    lastUsedAt: null,
    worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs: 5, recordings: 5, agentActions: 5, record: 500, total: 515 },
    expires: { logs: null, recordings: null, agentActions: null, record: null },
    version: 1,
  };
  writeFileSync(join(dir, 'archive.json'), JSON.stringify(record));
}

async function gc(opts: Parameters<typeof runGc>[0]) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ ...opts, json: true }, { findProjectRoot: () => null });
  expect(out).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(String(out.mock.calls[0]![0]));
  out.mockRestore();
  err.mockRestore();
  return payload;
}

test.each([{}, { cache: 'all' }, { olderThan: 1 }])(
  'normal scope %j never reports or deletes archives',
  async (scope) => {
    fixture('old', Date.now() - 40 * 86_400_000);
    const original = readFileSync(join(archiveDir('old'), 'archive.json'), 'utf8');
    for (const remove of [false, true]) {
      const payload = await gc({ ...scope, delete: remove });
      expect(payload.sections).not.toHaveProperty('archived');
      expect(readFileSync(join(archiveDir('old'), 'archive.json'), 'utf8')).toBe(original);
      expect(existsSync(join(archiveDir('old'), 'logs', 'metro.ndjson'))).toBe(true);
    }
  },
);

test('explicit archives list ids kinds bytes and expiry and delete the selected records', async () => {
  fixture('one');
  fixture('two');
  const payload = await gc({ cache: 'ARCHIVED' });
  expect(payload.sections.archived).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'one',
        kinds: ['logs', 'recordings', 'agentActions', 'record'],
        bytes: expect.any(Number),
        expires: expect.any(Object),
      }),
    ]),
  );
  expect(readArchives()).toHaveLength(2);
  await gc({ cache: 'archived', delete: true });
  expect(readArchives()).toEqual([]);
});

test('an explicit id ignores older-than and leaves other archives alone', async () => {
  fixture('one');
  fixture('two');
  const payload = await gc({ cache: 'ARCHIVED:ONE', olderThan: 99, delete: true });
  expect(payload.results).toContainEqual(expect.objectContaining({ kind: 'archive', id: 'one', status: 'done' }));
  expect(readArchives().map((entry) => entry.id)).toEqual(['two']);
});

test.each(['archived:missing', 'archived:'])(
  'unknown or empty archive id %s refuses with known ids instead of deleting everything',
  async (cache) => {
    fixture('one');
    const payload = await gc({ cache, delete: true });
    expect(payload).toMatchObject({ code: 'STIM_BAD_ARG', remedy: 'Known archive ids: one' });
    expect(readArchives()).toHaveLength(1);
  },
);

test.each([
  ['archived-logs', 'logs'],
  ['archived-recordings', 'recordings'],
  ['archived-agent', 'agentActions'],
])('%s deletes only its kind from eligible removal ages', async (cache, kind) => {
  fixture('old', Date.now() - 2 * 86_400_000);
  fixture('new');
  const payload = await gc({ cache, olderThan: 1 });
  expect(payload.sections.archived.find((entry: { id: string }) => entry.id === 'old')).toMatchObject({
    kinds: [kind],
    bytes: 5,
    willDelete: true,
  });
  await gc({ cache, olderThan: 1, delete: true });
  expect(readArchives().find((entry) => entry.id === 'old')?.bytes[kind as 'logs']).toBe(0);
  expect(readArchives().find((entry) => entry.id === 'new')?.bytes[kind as 'logs']).toBe(5);
  expect(readArchives()).toHaveLength(2);
});

test('archived older-than selects removal time rather than file modification time', async () => {
  fixture('old', Date.now() - 2 * 86_400_000);
  fixture('new');
  await gc({ cache: 'archived', olderThan: 1, delete: true });
  expect(readArchives().map((entry) => entry.id)).toEqual(['new']);
});

test('archive gc reaps dead staging but reports live and unresolved claims with a remedy', async () => {
  fixture('one');
  for (const id of ['dead', 'live', 'unknown']) mkdirSync(join(home, 'archive', `.incoming-${id}`));
  mkdirSync(join(home, 'archive', '.removing-old'));
  plantClaim(join(home, 'archive', '.incoming-dead.claims'), 'exclusive', goneClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-live.claims'), 'exclusive', liveClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-unknown.claims'), 'exclusive', { pid: process.pid, processToken: 'bad' });
  const report = await collectGcReport({ cache: 'archived' });
  expect(report.archives?.staging.find((entry) => entry.path.endsWith('unknown'))?.removeCommand).toContain(
    '.incoming-unknown.claims',
  );
  await gc({ cache: 'archived', delete: true });
  expect(existsSync(join(home, 'archive', '.incoming-dead'))).toBe(false);
  expect(existsSync(join(home, 'archive', '.removing-old'))).toBe(false);
  expect(existsSync(join(home, 'archive', '.incoming-live'))).toBe(true);
  expect(existsSync(join(home, 'archive', '.incoming-unknown'))).toBe(true);
});

test('archive selectors cannot accidentally select a shared cache with an archive name', () => {
  for (const name of ['archived', 'archived:one', 'archived-logs', 'archived-recordings', 'archived-agent']) {
    expect(
      selectCaches([{ name, dir: join(home, name), source: 'registered', prune: 'entries', note: '' }], name),
    ).toEqual([]);
  }
});

test('dead registered project pruning archives history with gc attribution', async () => {
  const { ensureWorkspaceStorage } = await import('../workspace/paths.ts');
  const root = join(home, 'gone');
  saveConfig({ version: 2, projects: { [root]: {} }, repos: {} });
  const dir = ensureWorkspaceStorage(root);
  writeFileSync(join(dir, 'state.json'), '{"lastUsedAt":"2026-01-01T00:00:00Z"}');
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  try {
    await gc({ delete: true });
    expect(readArchives()[0]).toMatchObject({
      projectRoot: root,
      removedBy: 'gc',
      worktree: { repository: null, head: null, branch: null, subject: null, merged: null, pullRequest: null },
    });
    expect(existsSync(dir)).toBe(false);
  } finally {
    delete process.env.STIM_ARCHIVE_ENABLED;
  }
});
