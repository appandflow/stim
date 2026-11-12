import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDir, readArchives } from '@stim-cli/core/state';
import { runGc } from '../commands/gc.ts';
import { collectArchives } from '../commands/gc/archives.ts';
import { deleteGcItem } from '../commands/gc/item.ts';
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
  await runGc({ ...opts, json: true });
  expect(out).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(String(out.mock.calls[0]![0]));
  out.mockRestore();
  err.mockRestore();
  return payload;
}

test.each(['normal', 'high'] as const)(
  'gc at %s neither reports archives nor deletes one within its retention',
  async (pressure) => {
    fixture('recent');
    const original = readFileSync(join(archiveDir('recent'), 'archive.json'), 'utf8');
    expect((await gc({ dryRun: true, pressure })).sections).not.toHaveProperty('archived');
    await gc({ pressure });
    expect(readFileSync(join(archiveDir('recent'), 'archive.json'), 'utf8')).toBe(original);
    expect(existsSync(join(archiveDir('recent'), 'logs', 'metro.ndjson'))).toBe(true);
  },
);

test('gc at critical deletes the archived logs, recordings and agent actions and keeps the records', async () => {
  fixture('one');
  fixture('two');
  await gc({ pressure: 'critical' });
  expect(readArchives()).toHaveLength(2);
  for (const entry of readArchives()) {
    expect(entry.bytes).toMatchObject({ logs: 0, recordings: 0, agentActions: 0 });
    expect(entry.bytes.record).toBeGreaterThan(0);
  }
});

test('an archive item matches its id case-insensitively and leaves other archives alone', async () => {
  fixture('one');
  fixture('two');
  const result = await deleteGcItem({ kind: 'archive', id: 'ONE' });
  expect(result.results).toContainEqual(expect.objectContaining({ kind: 'archive', id: 'one', status: 'done' }));
  expect(result.failures).toBe(0);
  expect(readArchives().map((entry) => entry.id)).toEqual(['two']);
});

test.each([
  ['missing', undefined],
  ['', undefined],
  ['missing', 'logs'],
  ['', 'agentActions'],
] as const)(
  'unknown or empty archive id "%s" (part %s) refuses with known ids and deletes nothing',
  async (id, part) => {
    fixture('one');
    const before = readArchives();
    const result = await deleteGcItem({ kind: 'archive', id, ...(part ? { part } : {}) });
    expect(result.refusal).toMatchObject({ code: 'STIM_BAD_ARG', remedy: 'Known archive ids: one' });
    expect(readArchives()).toEqual(before);
  },
);

test.each(['logs', 'recordings', 'agentActions'] as const)(
  'an archive item with part %s clears only that kind of that archive and keeps the record',
  async (kind) => {
    fixture('one');
    fixture('two');
    const before = readArchives().find((entry) => entry.id === 'two')!;
    await deleteGcItem({ kind: 'archive', id: 'ONE', part: kind });
    const one = readArchives().find((entry) => entry.id === 'one')!;
    const two = readArchives().find((entry) => entry.id === 'two')!;
    for (const key of ['logs', 'recordings', 'agentActions'] as const) {
      expect(one.bytes[key]).toBe(key === kind ? 0 : 5);
    }
    expect(one.bytes.record).toBeGreaterThan(0);
    expect(two).toEqual(before);
    expect(readFileSync(join(archiveDir('two'), 'logs', 'metro.ndjson'), 'utf8')).toBe('bytes');
  },
);

test('archive deletion reaps dead staging but reports live and unresolved claims with a remedy', async () => {
  fixture('one');
  for (const id of ['dead', 'live', 'unknown']) mkdirSync(join(home, 'archive', `.incoming-${id}`));
  mkdirSync(join(home, 'archive', '.removing-old'));
  plantClaim(join(home, 'archive', '.incoming-dead.claims'), 'exclusive', goneClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-live.claims'), 'exclusive', liveClaimOwner());
  plantClaim(join(home, 'archive', '.incoming-unknown.claims'), 'exclusive', { pid: process.pid, processToken: 'bad' });
  const selection = await collectArchives({ kind: null, id: null });
  expect(selection.staging.find((entry) => entry.path.endsWith('unknown'))?.removeCommand).toContain(
    '.incoming-unknown.claims',
  );
  await deleteGcItem({ kind: 'archive', id: 'one' });
  expect(existsSync(join(home, 'archive', '.incoming-dead'))).toBe(false);
  expect(existsSync(join(home, 'archive', '.removing-old'))).toBe(false);
  expect(existsSync(join(home, 'archive', '.incoming-live'))).toBe(true);
  expect(existsSync(join(home, 'archive', '.incoming-unknown'))).toBe(true);
});

test('dead registered project pruning archives history with gc attribution', async () => {
  const { ensureWorkspaceStorage } = await import('../workspace/paths.ts');
  const root = join(home, 'gone');
  saveConfig({ version: 2, projects: { [root]: {} }, repos: {} });
  const dir = ensureWorkspaceStorage(root);
  writeFileSync(join(dir, 'state.json'), '{"lastUsedAt":"2026-01-01T00:00:00Z"}');
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  try {
    await gc({ pressure: 'normal' });
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
