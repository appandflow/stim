import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  findStaleEasLedgerEntries,
  forgetStaleEasLedgerEntries,
  isStaleEasLedgerEntry,
} from '../commands/gc/eas-ledger.ts';
import { workspaceName, withDirLockTransaction } from '@stim-cli/core';
import { easSessionLedgerLock } from '@stim-cli/core/state';
import { listMountedVolumes } from '../fs-util.ts';
import type { EasSessionClaim } from '../engine/eas-session-ledger.ts';

const VALID_ID = '3f2b8c1e-5a4d-4e9b-9c7a-1d2e3f4a5b6c';
const MOUNTED = listMountedVolumes();
const GONE_ROOT = join(tmpdir(), 'stim-gone');
const ledgerIo = vi.hoisted((): { afterRename?: (path: unknown) => void } => ({}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const result = fs.renameSync(...args);
      ledgerIo.afterRename?.(args[1]);
      return result;
    },
  };
});

function claim(sessionId: string, workspaceRoot: string): EasSessionClaim {
  return {
    sessionId,
    name: 'stim-fixture',
    platform: 'ios',
    workspaceRoot,
    workspaceHome: '/tmp/stim-fixture-home',
    stateFile: join('/tmp/stim-fixture-home', 'workspaces', workspaceName(workspaceRoot), 'state.json'),
  };
}

describe('isStaleEasLedgerEntry', () => {
  const gone = (): boolean => false;
  const present = (): boolean => true;

  test('an invalid id with a proven-absent root is stale', () => {
    expect(isStaleEasLedgerEntry(claim('drs_2', GONE_ROOT), MOUNTED, gone)).toBe(true);
  });

  test('a valid UUID is kept even when its root is gone', () => {
    expect(isStaleEasLedgerEntry(claim(VALID_ID, GONE_ROOT), MOUNTED, gone)).toBe(false);
    expect(isStaleEasLedgerEntry(claim(VALID_ID.toUpperCase(), GONE_ROOT), MOUNTED, gone)).toBe(false);
  });

  test('an invalid id is kept while its root exists', () => {
    expect(isStaleEasLedgerEntry(claim('drs_2', '/tmp/stim-here'), MOUNTED, present)).toBe(false);
  });

  test('an invalid id is kept when absence is not provable', () => {
    expect(isStaleEasLedgerEntry(claim('drs_2', '/Volumes/Gone/app'), MOUNTED, gone)).toBe(false);
    expect(isStaleEasLedgerEntry(claim('drs_2', 'relative/app'), MOUNTED, gone)).toBe(false);
  });
});

describe('the machine EAS ledger sweep', () => {
  let dir: string;
  let ledgerRoot: string;
  let mounted: string[];

  beforeEach(() => {
    mounted = listMountedVolumes();
    dir = mkdtempSync(join(tmpdir(), 'stim-eas-ledger-'));
    ledgerRoot = join(dir, 'machine-eas');
    mkdirSync(ledgerRoot, { recursive: true });
  });

  afterEach(() => {
    ledgerIo.afterRename = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLedger(claims: EasSessionClaim[]): void {
    writeFileSync(
      join(ledgerRoot, 'sessions.json'),
      JSON.stringify({ version: 1, claims: Object.fromEntries(claims.map((c) => [c.sessionId, c])) }),
    );
  }

  function ledgerIds(): string[] {
    const parsed: { claims: Record<string, unknown> } = JSON.parse(
      readFileSync(join(ledgerRoot, 'sessions.json'), 'utf-8'),
    );
    return Object.keys(parsed.claims).toSorted();
  }

  test('reports and forgets only invalid ids whose root is gone', async () => {
    const live = join(dir, 'live-app');
    mkdirSync(live);
    writeLedger([
      claim('drs_1', join(dir, 'deleted-fixture')),
      claim('drs_unmanaged', live),
      claim(VALID_ID, join(dir, 'deleted-app')),
    ]);
    const deps = { easLedgerRoot: ledgerRoot };

    const found = findStaleEasLedgerEntries(mounted, deps);
    expect(found).toEqual([{ id: 'drs_1', workspaceRoot: join(dir, 'deleted-fixture') }]);
    expect(ledgerIds()).toEqual(['drs_1', 'drs_unmanaged', VALID_ID].toSorted());

    expect(await forgetStaleEasLedgerEntries(found, mounted, deps)).toBe(0);
    expect(ledgerIds()).toEqual(['drs_unmanaged', VALID_ID].toSorted());
  });

  test('keeps an entry whose root reappeared after the report', async () => {
    const root = join(dir, 'comes-back');
    writeLedger([claim('drs_2', root)]);
    const deps = { easLedgerRoot: ledgerRoot };
    const found = findStaleEasLedgerEntries(mounted, deps);
    expect(found).toHaveLength(1);

    mkdirSync(root);

    expect(await forgetStaleEasLedgerEntries(found, mounted, deps)).toBe(0);
    expect(ledgerIds()).toEqual(['drs_2']);
  });

  test('an unreadable ledger reports nothing', () => {
    writeFileSync(join(ledgerRoot, 'sessions.json'), '{not json');
    expect(findStaleEasLedgerEntries(mounted, { easLedgerRoot: ledgerRoot })).toEqual([]);
  });

  test('cancelling EAS ledger cleanup after one commit preserves remaining entries', async () => {
    writeLedger([claim('drs_first', join(dir, 'first')), claim('drs_later', join(dir, 'later'))]);
    const deps = { easLedgerRoot: ledgerRoot };
    const controller = new AbortController();
    const reason = new Error('cancel EAS ledger cleanup');
    ledgerIo.afterRename = (file) => {
      if (String(file) === join(ledgerRoot, 'sessions.json')) controller.abort(reason);
    };
    const outcome = await Promise.resolve()
      .then(() =>
        forgetStaleEasLedgerEntries(
          findStaleEasLedgerEntries(mounted, deps),
          mounted,
          deps,
          undefined,
          controller.signal,
        ),
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    expect(controller.signal.aborted).toBe(true);
    expect(outcome).toEqual({ error: reason });
    expect(ledgerIds()).toEqual(['drs_later']);
  });

  test('cancelling while waiting for the EAS ledger lock preserves the recorded claim', async () => {
    writeLedger([claim('drs_first', join(dir, 'first'))]);
    const deps = { easLedgerRoot: ledgerRoot };
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withDirLockTransaction(easSessionLedgerLock(ledgerRoot), () => gate);
    const controller = new AbortController();
    const reason = new Error('cancel queued EAS ledger cleanup');
    try {
      const forgetting = forgetStaleEasLedgerEntries(
        findStaleEasLedgerEntries(mounted, deps),
        mounted,
        deps,
        undefined,
        controller.signal,
      );
      setImmediate(() => {
        controller.abort(reason);
        setImmediate(release);
      });
      await expect(forgetting).rejects.toBe(reason);
      expect(ledgerIds()).toEqual(['drs_first']);
    } finally {
      release();
      await holding;
    }
  });
});
