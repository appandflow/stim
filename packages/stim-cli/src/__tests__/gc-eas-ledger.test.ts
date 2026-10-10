import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  findStaleEasLedgerEntries,
  forgetStaleEasLedgerEntries,
  isStaleEasLedgerEntry,
} from '../commands/gc/eas-ledger.ts';
import { workspaceName } from '@stim-cli/core';
import { listMountedVolumes } from '../fs-util.ts';
import type { EasSessionClaim } from '../engine/eas-session-ledger.ts';

const VALID_ID = '3f2b8c1e-5a4d-4e9b-9c7a-1d2e3f4a5b6c';
const MOUNTED = ['/'];

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
    expect(isStaleEasLedgerEntry(claim('drs_2', '/tmp/stim-gone'), MOUNTED, gone)).toBe(true);
  });

  test('a valid UUID is kept even when its root is gone', () => {
    expect(isStaleEasLedgerEntry(claim(VALID_ID, '/tmp/stim-gone'), MOUNTED, gone)).toBe(false);
    expect(isStaleEasLedgerEntry(claim(VALID_ID.toUpperCase(), '/tmp/stim-gone'), MOUNTED, gone)).toBe(false);
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

  test('reports and forgets only invalid ids whose root is gone', () => {
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

    expect(forgetStaleEasLedgerEntries(found, mounted, deps)).toBe(0);
    expect(ledgerIds()).toEqual(['drs_unmanaged', VALID_ID].toSorted());
  });

  test('keeps an entry whose root reappeared after the report', () => {
    const root = join(dir, 'comes-back');
    writeLedger([claim('drs_2', root)]);
    const deps = { easLedgerRoot: ledgerRoot };
    const found = findStaleEasLedgerEntries(mounted, deps);
    expect(found).toHaveLength(1);

    mkdirSync(root);

    expect(forgetStaleEasLedgerEntries(found, mounted, deps)).toBe(0);
    expect(ledgerIds()).toEqual(['drs_2']);
  });

  test('an unreadable ledger reports nothing', () => {
    writeFileSync(join(ledgerRoot, 'sessions.json'), '{not json');
    expect(findStaleEasLedgerEntries(mounted, { easLedgerRoot: ledgerRoot })).toEqual([]);
  });
});
