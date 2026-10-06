import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveEnabled, archivedUsage, readArchives } from '../state/archive.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-archive-reader-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function record(id: string, removedAt: string, logs: number) {
  const dir = join(home, 'archive', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'archive.json'),
    JSON.stringify({
      id,
      projectRoot: '/project',
      removedAt,
      bytes: { logs, recordings: 3, agentActions: 4, record: 5, total: logs + 12 },
      expires: {},
    }),
  );
}

test('missing and malformed records do not hide readable archives', () => {
  record('older', '2026-01-01T00:00:00Z', 1);
  record('newer', '2026-01-02T00:00:00Z', 2);
  mkdirSync(join(home, 'archive', 'missing'));
  mkdirSync(join(home, 'archive', 'broken'));
  writeFileSync(join(home, 'archive', 'broken', 'archive.json'), '{');
  expect(readArchives().map((archive) => archive.id)).toEqual(['newer', 'older']);
  expect(archivedUsage(readArchives())).toEqual({
    count: 2,
    bytes: 27,
    byKind: { logs: 3, recordings: 6, agentActions: 8, record: 10 },
  });
});

test('repo and machine archive disable values stop archiving unless the environment overrides them', () => {
  expect(archiveEnabled({}, [{}, { archive: { enabled: false } }, { archive: { enabled: true } }])).toBe(false);
  expect(archiveEnabled({}, [{ archive: { enabled: false } }])).toBe(false);
  expect(archiveEnabled({ STIM_ARCHIVE_ENABLED: 'true' }, [{ archive: { enabled: false } }])).toBe(true);
  expect(() => archiveEnabled({ STIM_ARCHIVE_ENABLED: 'yes' }, [])).toThrow('Invalid STIM_ARCHIVE_ENABLED');
});
