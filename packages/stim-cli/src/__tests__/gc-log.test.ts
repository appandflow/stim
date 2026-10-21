import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcLogFile, readGcLog } from '@stim-cli/core/state';
import { rotatedLogPath } from '@stim-cli/core';
import { openGcLog } from '../commands/gc/log.ts';
import { createGcResults } from '../commands/gc/results.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-log-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function runOf(holdKept: boolean, items: ['done' | 'kept' | 'failed', string][]) {
  const log = openGcLog({ trigger: 'manual', holdKept });
  const results = createGcResults(log.record);
  for (const [status, label] of items) results.record('cache', status, label, { detail: 'why' });
}

describe('the gc log writer', () => {
  test('holds kept items until the run first clears or fails something, then keeps their order', () => {
    runOf(true, [
      ['kept', 'a'],
      ['kept', 'b'],
      ['done', 'c'],
      ['kept', 'd'],
    ]);
    expect(readGcLog().map((r) => `${r.status}:${r.label}`)).toEqual(['kept:a', 'kept:b', 'done:c', 'kept:d']);
  });

  test('the reader orders by time when a held kept item is flushed after another run wrote', () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const item = (status: 'done' | 'kept', label: string) =>
      ({ kind: 'cache', status, label, id: null, bytes: null, detail: null }) as const;
    const holding = openGcLog({ trigger: 'manual', holdKept: true });
    const other = openGcLog({ trigger: 'budget' });
    holding.record(item('kept', 'first'));
    other.record(item('done', 'second'));
    holding.record(item('done', 'third'));
    expect(readGcLog().map((r) => r.label)).toEqual(['first', 'second', 'third']);
    vi.restoreAllMocks();
  });

  test('a run that only keeps things leaves no file', () => {
    runOf(true, [
      ['kept', 'a'],
      ['kept', 'b'],
    ]);
    expect(existsSync(gcLogFile())).toBe(false);
  });

  test('rotation keeps the newest records in write order and drops older generations', () => {
    vi.stubEnv('STIM_MAINTENANCE_LOG_MAX_MB', String(2048 / 1024 ** 2));
    const total = 60;
    runOf(
      false,
      Array.from({ length: total }, (_, i): ['done', string] => ['done', `item-${String(i).padStart(3, '0')}`]),
    );
    const labels = readGcLog().map((r) => r.label);
    expect(existsSync(rotatedLogPath(gcLogFile()))).toBe(true);
    expect(labels.length).toBeLessThan(total);
    expect(labels.at(-1)).toBe('item-059');
    expect(labels).toEqual(labels.toSorted());
    expect(labels.map((l) => Number(l.slice(5)))).toEqual(
      Array.from({ length: labels.length }, (_, i) => total - labels.length + i),
    );
  });

  test('two runs writing alternately across rotations lose none of the newest records', () => {
    vi.stubEnv('STIM_MAINTENANCE_LOG_MAX_MB', String(2048 / 1024 ** 2));
    const logs = [openGcLog({ trigger: 'budget' }), openGcLog({ trigger: 'maintenance' })];
    for (let i = 0; i < 40; i++)
      logs[i % 2]?.record({ kind: 'cache', status: 'done', label: `n-${i}`, id: null, bytes: null, detail: null });
    const labels = readGcLog().map((r) => Number(r.label.slice(2)));
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(labels).toEqual(Array.from({ length: labels.length }, (_, i) => 40 - labels.length + i));
  });

  test('a rotated generation older than the retention is deleted on the next write', () => {
    vi.stubEnv('STIM_MAINTENANCE_LOG_MAX_MB', String(2048 / 1024 ** 2));
    runOf(
      false,
      Array.from({ length: 30 }, (_, i): ['done', string] => ['done', `old-${i}`]),
    );
    const rotated = rotatedLogPath(gcLogFile());
    expect(existsSync(rotated)).toBe(true);
    const old = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(rotated, old, old);
    vi.stubEnv('STIM_MAINTENANCE_LOG_MAX_MB', '1');
    runOf(false, [['done', 'new']]);
    expect(existsSync(rotated)).toBe(false);
    expect(readGcLog().at(-1)?.label).toBe('new');
  });
});
