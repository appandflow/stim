import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_SWEEP_DISK_DROP_MB,
  EMPTY_SWEEP_WINDOW_MS,
  canSkipEmptySweep,
  readEmptySweep,
  sweepMarker,
  writeEmptySweep,
} from '../budget-sweep.ts';

const GB = 1024;
const recorded = { at: 1_000_000, freeMb: 10 * GB, marker: 'caches-a' };
const now = { at: recorded.at + 60_000, freeMb: 10 * GB, marker: 'caches-a' };

describe('canSkipEmptySweep', () => {
  test('skips a repeat of an empty trim inside the window with the same caches and the same free disk', () => {
    expect(canSkipEmptySweep(recorded, now)).toBe(true);
  });

  test('never skips without a record', () => {
    expect(canSkipEmptySweep(null, now)).toBe(false);
  });

  test('walks again once the window has passed, and when the clock went backwards', () => {
    expect(canSkipEmptySweep(recorded, { ...now, at: recorded.at + EMPTY_SWEEP_WINDOW_MS - 1 })).toBe(true);
    expect(canSkipEmptySweep(recorded, { ...now, at: recorded.at + EMPTY_SWEEP_WINDOW_MS })).toBe(false);
    expect(canSkipEmptySweep(recorded, { ...now, at: recorded.at - 1 })).toBe(false);
  });

  test('walks again when free disk fell by more than the drop limit, not when it fell by exactly that or rose', () => {
    const fell = (mb: number) => ({ ...now, freeMb: recorded.freeMb - mb });
    expect(canSkipEmptySweep(recorded, fell(EMPTY_SWEEP_DISK_DROP_MB))).toBe(true);
    expect(canSkipEmptySweep(recorded, fell(EMPTY_SWEEP_DISK_DROP_MB + 1))).toBe(false);
    expect(canSkipEmptySweep(recorded, fell(-5 * GB))).toBe(true);
  });

  test('walks again when the set of caches changed', () => {
    expect(canSkipEmptySweep(recorded, { ...now, marker: 'caches-b' })).toBe(false);
  });
});

describe('sweepMarker', () => {
  const a = { name: 'Metro transform cache: a', dir: '/c/a' };
  const b = { name: 'Build cache', dir: '/c/b' };

  test('does not depend on the order caches were discovered in', () => {
    expect(sweepMarker([a, b], 14)).toBe(sweepMarker([b, a], 14));
  });

  test('changes when a cache appears or disappears, moves, or the trim age changes', () => {
    const base = sweepMarker([a, b], 14);
    expect(sweepMarker([a], 14)).not.toBe(base);
    expect(sweepMarker([a, b, { name: 'Metro file maps', dir: '/tmp' }], 14)).not.toBe(base);
    expect(sweepMarker([a, { ...b, dir: '/c/elsewhere' }], 14)).not.toBe(base);
    expect(sweepMarker([a, b], 30)).not.toBe(base);
  });
});

describe('the empty-sweep record', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-budget-sweep-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('round-trips under STIM_HOME, and writing null forgets it', () => {
    expect(readEmptySweep()).toBeNull();
    writeEmptySweep(recorded);
    expect(readEmptySweep()).toEqual(recorded);
    writeEmptySweep(null);
    expect(readEmptySweep()).toBeNull();
  });
});
