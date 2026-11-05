import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { withDirLock } from '@stim-cli/core';
import {
  isSetupJournalPrunable,
  readSetupJournal,
  serverSetupDir,
  setupJournalFile,
  type SetupJournal,
} from '@stim-cli/core/state';
import { writeJson } from './registry.ts';

export function writeSetupJournal(hash: string, journal: SetupJournal): void {
  const file = setupJournalFile(hash);
  if (file === null) throw new Error('Invalid setup journal hash.');
  withDirLock(`${file}.lock`, () => writeJson(file, journal), {
    ensureParent: () => mkdirSync(serverSetupDir(), { recursive: true, mode: 0o700 }),
  });
}

export function pruneSetupJournals(now: number = Date.now()): void {
  let entries;
  try {
    entries = readdirSync(serverSetupDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const hash = entry.name.slice(0, -5);
    const file = setupJournalFile(hash);
    if (file === null) continue;
    withDirLock(`${file}.lock`, () => {
      const journal = readSetupJournal(hash);
      if (journal && isSetupJournalPrunable(journal, now)) rmSync(file, { force: true });
    });
  }
}

export function setupJournalForClient(journal: SetupJournal): SetupJournal {
  return journal.granted.some((grant) => grant.capability === 'build')
    ? journal
    : { ...journal, steps: journal.steps.filter((step) => !step.id.startsWith('tools')) };
}
