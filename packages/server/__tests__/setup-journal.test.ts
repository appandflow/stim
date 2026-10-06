import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupJournal, serverSetupDir, setupJournalFile, type SetupJournal } from '@stim-cli/core/state';
import { pruneSetupJournals, setupJournalForClient, writeSetupJournal } from '../src/setup-journal.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-setup-writer-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const journal: SetupJournal = {
  v: 1,
  client: { nodeId: 'nClient' },
  expiresAt: '2026-10-06T12:00:00.000Z',
  capabilities: ['build', 'device-host'],
  steps: [
    { id: 'route', state: 'ok', title: 'Tailnet route' },
    { id: 'tools.xcode', state: 'ok', title: 'Xcode', detail: '27.0' },
    { id: 'tools', state: 'pending', title: 'Toolchain' },
  ],
  granted: [],
  done: false,
};

test('writes readable journal replacements preserving the final state', () => {
  const hash = 'a'.repeat(64);
  writeSetupJournal(hash, journal);
  expect(readSetupJournal(hash)).toEqual(journal);
  const finished = { ...journal, done: true, exit: 0 };
  writeSetupJournal(hash, finished);
  expect(readSetupJournal(hash)).toEqual(finished);
});

test('prunes only valid journal files more than one hour past expiry, retaining boundary and unrelated files', () => {
  const now = Date.parse(journal.expiresAt) + 60 * 60_000;
  const expired = 'a'.repeat(64);
  const boundary = 'b'.repeat(64);
  const live = 'c'.repeat(64);
  const corrupt = 'd'.repeat(64);
  const directory = 'e'.repeat(64);
  pruneSetupJournals(now);
  writeSetupJournal(expired, { ...journal, expiresAt: new Date(Date.parse(journal.expiresAt) - 1).toISOString() });
  writeSetupJournal(boundary, journal);
  writeSetupJournal(live, { ...journal, expiresAt: new Date(now + 1000).toISOString() });
  writeFileSync(setupJournalFile(corrupt)!, '{');
  mkdirSync(setupJournalFile(directory)!);
  writeFileSync(join(serverSetupDir(), 'notes.json'), JSON.stringify(journal));
  writeFileSync(join(serverSetupDir(), '.unfinished.tmp'), '{}');
  pruneSetupJournals(now);
  expect(existsSync(setupJournalFile(expired)!)).toBe(false);
  for (const hash of [boundary, live, corrupt, directory]) expect(existsSync(setupJournalFile(hash)!)).toBe(true);
  expect(existsSync(join(serverSetupDir(), 'notes.json'))).toBe(true);
  expect(existsSync(join(serverSetupDir(), '.unfinished.tmp'))).toBe(true);
});

test('hides toolchain details until a build grant, including when hosting alone was granted', () => {
  expect(setupJournalForClient(journal).steps.map((step) => step.id)).toEqual(['route']);
  expect(
    setupJournalForClient({ ...journal, granted: [{ capability: 'device-host', id: 'host' }] }).steps.map(
      (step) => step.id,
    ),
  ).toEqual(['route']);
  expect(setupJournalForClient({ ...journal, granted: [{ capability: 'build', id: 'builder' }] }).steps).toEqual(
    journal.steps,
  );
});
