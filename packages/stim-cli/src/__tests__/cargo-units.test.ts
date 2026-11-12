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
import {
  cargoUnitPaths,
  idleCargoUnits,
  readCargoUnits,
  removalOrder,
  type CargoUnit,
} from '../workspace/cargo-units.ts';

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
  it('removes superseded units idle over a day, and keeps the newest of each crate whatever its age', () => {
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

describe('a profile on disk', () => {
  let target: string;
  const profile = () => join(target, 'debug');

  function makeUnit(crate: string, hash: string, ageMs: number): void {
    const at = new Date(Date.now() - ageMs);
    const fp = join(profile(), '.fingerprint', `${crate}-${hash}`);
    mkdirSync(fp, { recursive: true });
    writeFileSync(join(fp, 'invoked.timestamp'), '');
    mkdirSync(join(profile(), 'build', `${crate}-${hash}`, 'out'), { recursive: true });
    mkdirSync(join(profile(), 'deps'), { recursive: true });
    for (const name of [`lib${crate}-${hash}.rlib`, `${crate}-${hash}.d`, `lib${crate}-${hash}.rmeta`])
      writeFileSync(join(profile(), 'deps', name), 'x'.repeat(100));
    for (const path of [
      join(fp, 'invoked.timestamp'),
      fp,
      join(profile(), 'build', `${crate}-${hash}`, 'out'),
      join(profile(), 'build', `${crate}-${hash}`),
    ])
      utimesSync(path, at, at);
  }

  beforeEach(() => {
    target = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cargo-units-')));
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

  it('times a unit by the later of its fingerprint files and Exact ledger stamp', () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('tokio', h(2), 5 * DAY);
    const stamps = new Map([[`debug#${h(2)}`, Date.now() - 1000]]);

    const units = readCargoUnits(profile(), stamps, 'debug') ?? [];
    const age = (crate: string) => Date.now() - (units.find((entry) => entry.crate === crate)?.lastUsedMs ?? 0);

    expect(age('serde')).toBeGreaterThan(4 * DAY);
    expect(age('tokio')).toBeLessThan(DAY);
  });

  it('lists a unit fingerprint first, then its build directory, then its deps files', () => {
    makeUnit('serde', h(1), 5 * DAY);
    const [only] = readCargoUnits(profile(), new Map(), 'debug') ?? [];
    if (!only) throw new Error('no unit');
    const paths = removalOrder([...(cargoUnitPaths(profile(), [only]).get(only) ?? [])].toReversed());
    expect(paths.map((path) => path.split('/')[0])).toEqual(['.fingerprint', 'build', 'deps', 'deps', 'deps']);
  });

  it('removes the idle superseded units of an in-use profile and nothing else, leaving Cargo a unit to rebuild', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    makeUnit('fresh', h(3), 0);
    makeUnit('fresh', h(4), 0);
    stub({});

    const result = await trimCargoTarget(target, { needBytes: 0, incremental: 'all', units: 'all' });

    expect(result.removed).toEqual(['debug/incremental', 'debug: 1 idle units']);
    expect(readdirSync(join(profile(), '.fingerprint')).toSorted()).toEqual([
      `fresh-${h(3)}`,
      `fresh-${h(4)}`,
      `serde-${h(2)}`,
    ]);
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(false);
    expect(existsSync(join(profile(), 'deps', `libserde-${h(2)}.rlib`))).toBe(true);
    expect(existsSync(join(profile(), 'build', `serde-${h(1)}`))).toBe(false);
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
  });

  it('keeps every unit while a build holds the profile lock, and a unit whose file a process holds open', async () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    makeUnit('tokio', h(3), 5 * DAY);
    makeUnit('tokio', h(4), 3 * DAY);
    writeFileSync(join(profile(), '.cargo-lock'), '');
    const held = join(target, 'debug', 'deps', `tokio-${h(3)}.d`);
    stub({ ps: () => `${held} --nocapture\n`, lsof: () => '' });
    const used = await trimCargoTarget(target, { needBytes: 0, incremental: 'toNeed', units: 'all' });
    expect(used.removed).toEqual([`debug: 1 idle units`]);
    expect(existsSync(join(profile(), 'deps', `libtokio-${h(3)}.rlib`))).toBe(true);
    expect(existsSync(join(profile(), 'deps', `libserde-${h(1)}.rlib`))).toBe(false);

    makeUnit('serde', h(5), 5 * DAY);
    stub({ lsof: (args) => (args.includes('-t') ? '4242\n' : '') });
    const locked = await trimCargoTarget(target, { needBytes: 0, incremental: 'toNeed', units: 'all' });
    expect(locked.removed).toEqual([]);
    expect(locked.kept).toEqual(['debug: a build holds its .cargo-lock']);
    expect(existsSync(join(profile(), 'deps', `libserde-${h(5)}.rlib`))).toBe(true);
  });

  it('lists the idle unit paths outside the profiles already going', () => {
    makeUnit('serde', h(1), 5 * DAY);
    makeUnit('serde', h(2), 3 * DAY);
    expect(
      idleCargoUnitPaths(target, Date.now())
        .map((path) => path.slice(profile().length + 1))
        .toSorted(),
    ).toEqual([
      `.fingerprint/serde-${h(1)}`,
      `build/serde-${h(1)}`,
      `deps/libserde-${h(1)}.rlib`,
      `deps/libserde-${h(1)}.rmeta`,
      `deps/serde-${h(1)}.d`,
    ]);
    expect(idleCargoUnitPaths(target, Date.now(), [profile()])).toEqual([]);
  });
});
