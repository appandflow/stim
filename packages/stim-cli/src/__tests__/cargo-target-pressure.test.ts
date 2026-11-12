import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaintenanceSize } from '@stim-cli/core/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cargoTrimPolicy, planCargoTargets } from '../stimd/passes/cargo-target.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';

const DAY = 24 * 3_600_000;

describe('the Cargo target trim under disk pressure', () => {
  let base: string;
  const settings = resolveMaintenanceSettings();

  function target(name: string): string {
    const dir = join(base, name, 'target');
    const old = new Date(Date.now() - 5 * DAY);
    for (const unit of ['aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2']) {
      mkdirSync(join(dir, 'debug', '.fingerprint', `serde-${unit}`), { recursive: true });
      mkdirSync(join(dir, 'debug', 'deps'), { recursive: true });
      writeFileSync(join(dir, 'debug', 'deps', `libserde-${unit}.rlib`), 'x'.repeat(1000));
    }
    mkdirSync(join(dir, 'debug', 'incremental', 'x'), { recursive: true });
    writeFileSync(join(dir, 'debug', 'incremental', 'x', 'q'), 'x'.repeat(1000));
    const fresh = new Date();
    for (const part of ['', '.fingerprint', 'deps', 'build', 'incremental'])
      try {
        utimesSync(join(dir, 'debug', part), fresh, fresh);
      } catch {}
    for (const unit of ['aaaaaaaaaaaaaaa1']) {
      const fp = join(dir, 'debug', '.fingerprint', `serde-${unit}`);
      utimesSync(fp, old, old);
    }
    return dir;
  }

  const size = (dir: string): MaintenanceSize => ({
    name: 'Cargo target',
    category: 'other',
    dir,
    bytes: 1_000_000,
    measuredAt: 0,
    workspace: dir.replace(/\/target$/, ''),
  });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cargo-pressure-')));
    vi.stubEnv('STIM_HOME', join(base, 'home'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('maps a level to what it removes', () => {
    expect(cargoTrimPolicy('normal')).toEqual({ incremental: 'toNeed', units: 'toNeed' });
    expect(cargoTrimPolicy('high')).toEqual({ incremental: 'all', units: 'toNeed' });
    expect(cargoTrimPolicy('critical')).toEqual({ incremental: 'all', units: 'all' });
  });

  it('tightens only the targets on a volume under the level, and an explicit level applies to every target', async () => {
    const short = target('short');
    const roomy = target('roomy');
    const diskLevel = async (dir: string) => (dir === short ? ('critical' as const) : ('normal' as const));
    const sizes = [size(short), size(roomy)];

    const measured = await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now(), diskLevel });
    expect(measured.actions).toMatchObject([{ target: short, level: 3, bytes: expect.any(Number) }]);
    expect(measured.actions[0]?.bytes).toBeGreaterThan(1500);

    const explicit = await planCargoTargets({
      sizes,
      settings,
      pinned: () => false,
      now: Date.now(),
      diskLevel,
      level: 'high',
    });
    expect(explicit.actions.map(({ target: dir, level }) => [dir, level])).toEqual([
      [short, 2],
      [roomy, 2],
    ]);

    const normal = await planCargoTargets({
      sizes,
      settings,
      pinned: () => false,
      now: Date.now(),
      diskLevel,
      level: 'normal',
    });
    expect(normal.actions).toEqual([]);
  });
});
