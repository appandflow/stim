import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverSetupDir, setupJournalFile } from '../state/paths.ts';
import { isJournalExpired, parseSetupJournal, readSetupJournal, type SetupJournal } from '../state/setup-journal.ts';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn<typeof fs.readFileSync>(fs.readFileSync) };
});

let home: string;
const hash = 'a'.repeat(64);
const journal: SetupJournal = {
  v: 1,
  client: { nodeId: 'nClient' },
  expiresAt: '2026-10-06T12:00:00.000Z',
  capabilities: ['build', 'device-host'],
  steps: [{ id: 'route', state: 'failed', title: 'Tailnet route', detail: 'Port busy', fix: 'Choose another port' }],
  granted: [{ capability: 'build', id: 'abc123' }],
  done: true,
  exit: 3,
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-setup-reader-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('reads a complete journal and treats missing or invalid files as unavailable', () => {
  expect(readSetupJournal(hash)).toBeNull();
  mkdirSync(serverSetupDir(), { recursive: true });
  const file = setupJournalFile(hash)!;
  for (const payload of [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...journal, v: 2 }),
    JSON.stringify({ ...journal, steps: [{}] }),
  ]) {
    writeFileSync(file, payload);
    expect(readSetupJournal(hash)).toBeNull();
  }
  writeFileSync(file, JSON.stringify(journal));
  expect(readSetupJournal(hash)).toEqual(journal);
  const expires = Date.parse(journal.expiresAt);
  expect(isJournalExpired(journal, expires)).toBe(false);
  expect(isJournalExpired(journal, expires + 1)).toBe(true);
});

test('rejects traversal, uppercase and incorrectly sized hashes before reading any file', () => {
  vi.mocked(readFileSync).mockClear();
  for (const invalid of ['../config', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), hash + '\n']) {
    expect(readSetupJournal(invalid)).toBeNull();
  }
  expect(readFileSync).not.toHaveBeenCalled();
});

test('rejects unsupported or malformed fields and extra data instead of exposing it to clients', () => {
  for (const invalid of [
    null,
    { ...journal, v: 2 },
    { ...journal, client: { nodeId: 1 } },
    { ...journal, expiresAt: 'not a date' },
    { ...journal, capabilities: ['read'] },
    { ...journal, steps: [{ id: 'tools', state: ['ok'], title: 'Tools' }] },
    { ...journal, steps: [{ id: 'route', state: 'ok', title: 'Route', fix: 1 }] },
    { ...journal, granted: [{ capability: 'read', id: 'phone' }] },
    { ...journal, done: 1 },
    { ...journal, exit: 1.5 },
    { ...journal, token: 'secret' },
    { ...journal, client: { ...journal.client, token: 'secret' } },
    { ...journal, steps: [{ ...journal.steps[0], token: 'secret' }] },
    { ...journal, granted: [{ ...journal.granted[0], token: 'secret' }] },
  ])
    expect(parseSetupJournal(invalid)).toBeNull();
});
