import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { idleCargoUnitPaths, trimCargoTarget } from '../workspace/cargo-target.ts';
import { idleCargoUnits, readCargoUnits, removalOrder, type CargoUnit } from '../workspace/cargo-units.ts';

const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const unit = (crate: string, hash: string, ageMs: number | null): CargoUnit => ({
  id: `${crate}-${hash}`,
  crate,
  hash,
  lastUsedMs: ageMs === null ? null : NOW - ageMs,
});
const h = (n: number) => n.toString(16).padStart(16, '0');

describe('idleCargoUnits', () => {
  it('removes superseded units idle over a day, and keeps the newest of each crate and any unit without a time', () => {
    const idle = idleCargoUnits(
      [
        unit('serde', h(1), 5 * DAY),
        unit('serde', h(2), 3 * DAY),
        unit('contract', h(3), 9 * DAY),
        unit('contract', h(4), DAY / 2),
        unit('lonely', h(5), 30 * DAY),
        unit('unknown', h(6), null),
        unit('unknown', h(7), 4 * DAY),
      ],
      NOW,
      DAY,
    );
    expect(idle.map((entry) => entry.hash)).toEqual([h(1), h(3)]);
  });
});

describe('a profile on disk with Exact ledger', () => {
  let target: string;
  const profile = () => join(target, 'debug');
  const stamps: Record<string, number> = {};

  function makeUnit(crate: string, hash: string, stampAgeMs: number | null): void {
    const fp = join(profile(), '.fingerprint', `${crate}-${hash}`);
    mkdirSync(fp, { recursive: true });
    writeFileSync(join(fp, 'invoked.timestamp'), '');
    mkdirSync(join(profile(), 'build', `${crate}-${hash}`, 'out'), { recursive: true });
    mkdirSync(join(profile(), 'deps'), { recursive: true });
    for (const name of [`lib${crate}-${hash}.rlib`, `${crate}-${hash}.d`, `lib${crate}-${hash}.rmeta`])
      writeFileSync(join(profile(), 'deps', name), 'x'.repeat(100));
    const reset = new Date(86_400_000);
    utimesSync(join(fp, 'invoked.timestamp'), reset, reset);
    if (stampAgeMs !== null) stamps[`debug#${hash}`] = Date.now() - stampAgeMs;
  }

  function writeLedger(): void {
    writeFileSync(join(target, '.exact-sweep.json'), JSON.stringify({ at: Date.now(), units: stamps }));
  }

  beforeEach(() => {
    target = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cargo-units-')));
    for (const key of Object.keys(stamps)) delete stamps[key];
    for (const part of ['.fingerprint', 'deps', 'build', 'incremental'])
      mkdirSync(join(profile(), part), { recursive: true });
  });
  afterEach(() => {
    resetExecutor();
    rmSync(target, { recursive: true, force: true });
  });

  function stub(handlers: { lsof?: (args: string[]) => string; ps?: () => string }): void {
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file === 'lsof') return handlers.lsof?.(args) ?? '';
        if (file === 'ps') return handlers.ps?.() ?? '';
        return real.runFileAsync(file, args, options);
      },
    });
  }

  it('times a unit only by its ledger stamp, or a read since the last sweep, and gives an unstamped unit no time', () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('tokio', h(2), 5 * DAY);
    makeUnit('nostamp', h(3), null);
    const read = join(profile(), '.fingerprint', `tokio-${h(2)}`, 'invoked.timestamp');
    utimesSync(read, new Date(), new Date(Date.now() - 9 * DAY));

    const units = readCargoUnits(profile(), new Map(Object.entries(stamps)), 'debug', Date.now()) ?? [];
    const age = (crate: string) => units.find((entry) => entry.crate === crate)?.lastUsedMs;

    expect(Date.now() - (age('serde') ?? 0)).toBeGreaterThan(4 * DAY);
    expect(Date.now() - (age('tokio') ?? 0)).toBeLessThan(1000);
    expect(age('nostamp')).toBeNull();
  });

  it('keeps every live unit of a package whose lib, build script and test units differ, and removes only superseded ones', async () => {
    for (const crate of ['foo', 'foo-bar'])
      for (const n of [1, 2, 3, 4]) makeUnit(crate, h(n + (crate === 'foo' ? 10 : 20)), DAY / 4 + n * 1000);
    makeUnit('foo', h(99), 8 * DAY);
    writeLedger();
    stub({});

    const result = await trimCargoTarget(target, { needBytes: 0, incremental: 'all', units: 'all' });

    expect(result.removed).toContain('debug: 1 idle units');
    expect(readdirSync(join(profile(), '.fingerprint')).filter((name) => name.startsWith('foo-'))).toHaveLength(8);
    expect(existsSync(join(profile(), 'deps', `libfoo-${h(99)}.rlib`))).toBe(false);
  });

  it('sweeps no unit of a target without the ledger', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    const old = new Date(Date.now() - 3 * DAY);
    for (const part of ['', '.fingerprint', 'deps', 'build']) utimesSync(join(profile(), part), old, old);
    stub({});
    expect(idleCargoUnitPaths(target, Date.now())).toEqual([]);

    const result = await trimCargoTarget(target, { needBytes: 0, incremental: 'all', units: 'all' });

    expect(result.removed).not.toContain('debug: 1 idle units');
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(true);
  });

  it('keeps a unit whose file a process names, and the whole profile while a build holds a lock', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    makeUnit('tokio', h(3), 5 * DAY);
    makeUnit('tokio', h(4), 3 * DAY);
    writeFileSync(join(profile(), '.cargo-lock'), '');
    writeLedger();
    stub({ ps: () => `${join(profile(), 'deps', `tokio-${h(3)}.d`)} --nocapture\n` });
    const used = await trimCargoTarget(target, { needBytes: 0, units: 'all' });
    expect(used.removed).toEqual(['debug: 1 idle units']);
    expect(existsSync(join(profile(), 'deps', `libtokio-${h(3)}.rlib`))).toBe(true);
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(false);

    makeUnit('serde', h(5), 5 * DAY);
    writeLedger();
    stub({ lsof: (args) => (args.includes('-t') ? '4242\n' : '') });
    const locked = await trimCargoTarget(target, { needBytes: 0, units: 'all' });
    expect(locked.removed).toEqual([]);
    expect(locked.kept.join(' ')).toContain('a build holds its .cargo-lock');
    expect(existsSync(join(profile(), 'deps', `libserde-${h(5)}.rlib`))).toBe(true);
  });

  it('stops the sweep of a profile when a lock turns up between chunks, with the earlier chunks gone and later units untouched', async () => {
    for (let i = 0; i < 60; i++) makeUnit('dup', h(100 + i), (10 + i) * DAY);
    makeUnit('dup', h(1), DAY / 4);
    writeFileSync(join(profile(), '.cargo-lock'), '');
    writeLedger();
    let checks = 0;
    stub({ lsof: (args) => (args.includes('-t') && ++checks > 3 ? '4242\n' : '') });

    const result = await trimCargoTarget(target, { needBytes: 0, units: 'all' });

    const left = readdirSync(join(profile(), '.fingerprint')).length;
    expect(left).toBeGreaterThan(1);
    expect(left).toBeLessThan(61);
    expect(result.kept.join(' ')).toContain('the sweep stopped');
    expect(existsSync(join(target, '.stim-trimmed', 'NOT-RESTORED'))).toBe(false);
  });

  it('deletes the old copy and writes no marker when a build recreated a path during the move', async () => {
    for (let i = 0; i < 4; i++) makeUnit('dup', h(100 + i), (10 + i) * DAY);
    makeUnit('dup', h(1), DAY / 4);
    writeFileSync(join(profile(), '.cargo-lock'), '');
    writeLedger();
    const victim = join(profile(), 'deps', `libdup-${h(100)}.rlib`);
    let after = 0;
    stub({
      lsof: (args) => {
        if (!args.includes('-t') || ++after < 2) return '';
        mkdirSync(join(profile(), '.fingerprint', `dup-${h(100)}`), { recursive: true });
        writeFileSync(join(profile(), '.fingerprint', `dup-${h(100)}`, 'fresh'), 'new');
        writeFileSync(victim, 'fresh build');
        return '4242\n';
      },
    });

    const result = await trimCargoTarget(target, { needBytes: 0, units: 'all' });

    expect(existsSync(join(target, '.stim-trimmed', 'NOT-RESTORED'))).toBe(false);
    expect(readdirSync(target).filter((name) => name.startsWith('.stim-not-restored-'))).toEqual([]);
    expect(existsSync(join(profile(), '.fingerprint', `dup-${h(100)}`, 'fresh'))).toBe(true);
    expect(result.kept.join(' ')).toContain('took its');
  });

  it('removes the order fingerprint first, then build, then deps', () => {
    expect(removalOrder(['deps/a', 'build/b', '.fingerprint/c', 'deps/d'])).toEqual([
      '.fingerprint/c',
      'build/b',
      'deps/a',
      'deps/d',
    ]);
  });
});
