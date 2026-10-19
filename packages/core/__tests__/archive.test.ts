import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveEnabled,
  archivedUsage,
  readArchive,
  readArchiveAsync,
  readArchives,
  readArchivesAsync,
} from '../state/archive.ts';
import { withStateReadCache } from '../state/json-file.ts';

const archiveIo = vi.hoisted((): { afterRead?: () => void } => ({}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const contents = await fs.readFile(...args);
      archiveIo.afterRead?.();
      return contents;
    },
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-archive-reader-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  archiveIo.afterRead = undefined;
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function record(id: string, removedAt: string, logs: number, omit?: string) {
  const dir = join(home, 'archive', id);
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = {
    id,
    projectRoot: '/project',
    project: 'project',
    workspace: 'project--abc',
    worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
    removedAt,
    removedBy: 'worktree-remove',
    lastUsedAt: null,
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [],
    bytes: { logs, recordings: 3, agentActions: 4, record: 5, total: logs + 12 },
    expires: {},
    version: 1,
  };
  if (omit) delete body[omit];
  writeFileSync(join(dir, 'archive.json'), JSON.stringify(body));
}

const readers = [
  { name: 'synchronous', list: readArchives, one: readArchive },
  { name: 'asynchronous', list: readArchivesAsync, one: readArchiveAsync },
];

test.each(readers)('$name: missing and malformed records do not hide readable archives', async ({ list }) => {
  record('older', '2026-01-01T00:00:00Z', 1);
  record('newer', '2026-01-02T00:00:00Z', 2);
  mkdirSync(join(home, 'archive', 'missing'));
  mkdirSync(join(home, 'archive', 'broken'));
  writeFileSync(join(home, 'archive', 'broken', 'archive.json'), '{');
  const archives = await list();
  expect(archives.map((archive) => archive.id)).toEqual(['newer', 'older']);
  expect(archivedUsage(archives)).toEqual({
    count: 2,
    bytes: 27,
    byKind: { logs: 3, recordings: 6, agentActions: 8, record: 10 },
  });
});

test.each(readers)(
  '$name: records missing a status field or reached through a symlink are not listed',
  async ({ list, one }) => {
    record('whole', '2026-01-01T00:00:00Z', 1);
    record('no-worktree', '2026-01-02T00:00:00Z', 1, 'worktree');
    record('no-agents', '2026-01-02T00:00:00Z', 1, 'agents');
    record('.incoming', '2026-01-02T00:00:00Z', 1);
    record('target', '2026-01-03T00:00:00Z', 1);
    symlinkSync(join(home, 'archive', 'target'), join(home, 'archive', 'link'));
    const archives = await list();
    expect(archives.map((archive) => archive.id)).toEqual(['target', 'whole']);
    for (const id of ['no-worktree', 'no-agents', 'link', '.incoming', 'missing', '../archive/whole'])
      expect(await one(id)).toBeNull();
    expect(await one('whole')).toEqual(archives.find((archive) => archive.id === 'whole'));
  },
);

test('a cancellation during an archive read is not treated as an unreadable record', async () => {
  record('whole', '2026-01-01T00:00:00Z', 1);
  const controller = new AbortController();
  const reason = new Error('archive scan cancelled');
  archiveIo.afterRead = () => controller.abort(reason);
  await expect(readArchivesAsync(controller.signal)).rejects.toBe(reason);
});

test('asynchronous cleanup reads current files without changing a cached status snapshot', async () => {
  record('whole', '2026-01-01T00:00:00Z', 1);
  await withStateReadCache(async () => {
    expect(readArchive('whole')?.bytes.logs).toBe(1);
    record('whole', '2026-01-01T00:00:00Z', 20);
    expect((await readArchiveAsync('whole'))?.bytes.logs).toBe(20);
    expect(readArchive('whole')?.bytes.logs).toBe(1);
  });
});

test('repo and machine archive disable values stop archiving unless the environment overrides them', () => {
  expect(archiveEnabled({}, [{}, { archive: { enabled: false } }, { archive: { enabled: true } }])).toBe(false);
  expect(archiveEnabled({}, [{ archive: { enabled: false } }])).toBe(false);
  expect(archiveEnabled({ STIM_ARCHIVE_ENABLED: 'true' }, [{ archive: { enabled: false } }])).toBe(true);
  expect(() => archiveEnabled({ STIM_ARCHIVE_ENABLED: 'yes' }, [])).toThrow('Invalid STIM_ARCHIVE_ENABLED');
});
