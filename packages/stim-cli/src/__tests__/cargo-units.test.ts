import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { withCargoLocks } from '../workspace/cargo-lock.ts';
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
const canFlock = process.platform === 'darwin' || process.platform === 'linux';
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

  function writeLedger(atAgeMs = 0): void {
    writeFileSync(join(target, '.exact-sweep.json'), JSON.stringify({ at: Date.now() - atAgeMs, units: stamps }));
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

  function stub(handlers: { ps?: () => string; du?: () => void }): void {
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file === 'lsof') return '';
        if (file === 'ps') return handlers.ps?.() ?? '';
        if (file === 'du') handlers.du?.();
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

  it.skipIf(!canFlock)(
    'keeps every live unit of a package whose lib, build script and test units differ, and removes only superseded ones',
    async () => {
      for (const crate of ['foo', 'foo-bar'])
        for (const n of [1, 2, 3, 4]) makeUnit(crate, h(n + (crate === 'foo' ? 10 : 20)), n ** 2 * 1.25 * 3_600_000);
      makeUnit('foo', h(99), 8 * DAY);
      writeLedger();
      stub({});

      const result = await trimCargoTarget(target, { needBytes: 0, incremental: 'all', units: 'all' });

      expect(result.removed).toContain('debug: 1 idle units');
      expect(readdirSync(join(profile(), '.fingerprint')).filter((name) => name.startsWith('foo-'))).toHaveLength(8);
      expect(existsSync(join(profile(), 'deps', `libfoo-${h(99)}.rlib`))).toBe(false);
    },
  );

  it('sweeps no unit when the ledger itself is older than 3 days, since it shows no use', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    writeLedger(4 * DAY);
    stub({});

    expect(idleCargoUnitPaths(target, Date.now())).toEqual([]);
    const result = await trimCargoTarget(target, { needBytes: 0, incremental: 'all', units: 'all' });

    expect(result.removed).not.toContain('debug: 1 idle units');
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(true);
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

  it.skipIf(!canFlock)('keeps a unit whose file a process names', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    makeUnit('tokio', h(3), 5 * DAY);
    makeUnit('tokio', h(4), 3 * DAY);
    writeLedger();
    stub({ ps: () => `${join(profile(), 'deps', `tokio-${h(3)}.d`)} --nocapture\n` });

    const result = await trimCargoTarget(target, { needBytes: 0, units: 'all' });

    expect(result.removed).toEqual(['debug: 1 idle units']);
    expect(existsSync(join(profile(), 'deps', `libtokio-${h(3)}.rlib`))).toBe(true);
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(false);
  });

  it.skipIf(!canFlock).each([
    ['debug', '.cargo-lock'],
    ['debug', '.cargo-build-lock'],
    ['debug', '.cargo-artifact-lock'],
    ['', '.exact-sweep.json.lock'],
  ])('keeps the profile when %s/%s is held across the helper exit', async (dir, lock) => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    writeLedger();
    stub({});

    const sweep = () => trimCargoTarget(target, { needBytes: 0, units: 'all' });
    const locked = await withCargoLocks([join(target, dir, lock)], sweep);

    expect(locked).toMatchObject({ value: { removed: [], kept: [expect.stringContaining(`holds ${lock}`)] } });
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(true);
    expect((await sweep()).removed).toEqual(['debug: 1 idle units']);
  });

  it.skipIf(!canFlock)('keeps units when a Cargo lock file cannot be safely opened', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    writeLedger();
    mkdirSync(join(profile(), '.cargo-build-lock'));
    stub({});

    const result = await trimCargoTarget(target, { needBytes: 0, units: 'all' });

    expect(result.removed).toEqual([]);
    expect(result.kept.join(' ')).toContain('.cargo-build-lock could not be locked');
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(true);
  });

  it.skipIf(!canFlock)('keeps a unit read after planning and before the sweep locked the profile', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    writeLedger();
    const fp = join(profile(), '.fingerprint', `serde-${h(1)}`, 'invoked.timestamp');
    let probes = 0;
    stub({
      ps: () => {
        if (++probes === 2) utimesSync(fp, new Date(), new Date(Date.now() - 9 * DAY));
        return '';
      },
    });

    const result = await trimCargoTarget(target, { needBytes: 0, units: 'all' });

    expect(result.removed).toEqual([]);
    expect(existsSync(fp)).toBe(true);
  });

  it.skipIf(!canFlock)('stops after one chunk when Exact replaces the ledger', async () => {
    for (let i = 0; i < 30; i++) makeUnit('dup', h(100 + i), (10 + i) * DAY);
    makeUnit('dup', h(1), DAY / 4);
    writeLedger();
    let replaced = false;
    stub({
      du: () => {
        if (replaced) return;
        replaced = true;
        const staged = join(target, '.exact-sweep.json.tmp');
        writeFileSync(staged, JSON.stringify({ at: Date.now(), units: stamps }));
        renameSync(staged, join(target, '.exact-sweep.json'));
      },
    });

    const result = await trimCargoTarget(target, { needBytes: 0, units: 'all' });

    expect(result.removed).toEqual(['debug: 25 idle units']);
    expect(result.kept.join(' ')).toContain('Exact updated its ledger');
    expect(readdirSync(join(profile(), '.fingerprint'))).toHaveLength(6);
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
