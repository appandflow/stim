import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupJournal } from '../state/setup-journal.ts';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn<typeof fs.readFileSync>(fs.readFileSync) };
});

let home: string;
const hash = 'a'.repeat(64);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-setup-reader-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('rejects traversal, uppercase and incorrectly sized hashes before reading any file', () => {
  vi.mocked(readFileSync).mockClear();
  for (const invalid of ['../config', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), hash + '\n']) {
    expect(readSetupJournal(invalid)).toBeNull();
  }
  expect(readFileSync).not.toHaveBeenCalled();
});
