import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaintenanceSize } from '@stim-cli/core/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetExecutor, setExecutor } from '../exec.ts';
import { planCargoTargets } from '../stimd/passes/cargo-target.ts';
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

  it('tightens only the targets on a volume under the level, and an explicit level applies to every target', async () => {
    const short = target('short');
    const roomy = target('roomy');
    const diskLevel = async (dir: string) => ({ level: dir === short ? ('critical' as const) : ('normal' as const) });
    const sizes = [size(short), size(roomy)];

    const measured = await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now(), diskLevel });
    expect(measured.actions).toMatchObject([{ target: short, level: 3, bytes: expect.any(Number) }]);
    expect(measured.actions[0]?.bytes).toBeGreaterThan(1500);
    expect(measured.actions[0]?.reason).not.toContain('build units');

    const now = Date.now();
    writeFileSync(
      join(short, '.exact-sweep.json'),
      JSON.stringify({ at: now, units: { 'debug#aaaaaaaaaaaaaaa1': now - 5 * DAY, 'debug#aaaaaaaaaaaaaaa2': now } }),
    );
    const withLedger = await planCargoTargets({ sizes, settings, pinned: () => false, now, diskLevel });
    expect(withLedger.actions[0]?.reason).toContain('build units unused for a day (all of them)');

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
    for (const action of explicit.actions) expect(action.reason).not.toContain('build units');

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

  describe('a low-priority walk of the trim plan', () => {
    const platform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: platform });
      resetExecutor();
    });

    type Kind = 'critical' | 'unsampled' | 'foreign' | 'normal';

    async function plan(
      on: NodeJS.Platform,
      ionice: string | null,
      fail: (file: string) => unknown = () => null,
    ): Promise<{ walks: Record<Kind, string[][]>; bytes: (number | undefined)[] }> {
      Object.defineProperty(process, 'platform', { value: on });
      const dirs: Record<Kind, string> = {
        critical: target('critical'),
        unsampled: target('unsampled'),
        foreign: target('foreign'),
        normal: target('normal'),
      };
      const device = lstatSync(base).dev;
      const samples = new Map([
        [dirs.critical, { level: 'critical' as const, device }],
        [dirs.foreign, { level: 'normal' as const, device: device + 1 }],
        [dirs.normal, { level: 'normal' as const, device }],
      ]);
      const walks: string[][] = [];
      setExecutor({
        findExecutable: (name) => (name === 'ionice' ? ionice : null),
        runFileAsync: async (file, args) => {
          walks.push([file, ...args]);
          const error = fail(file);
          if (error) throw error;
          return `4\t${args.at(-1)}\n`;
        },
      });
      const planned = await planCargoTargets({
        sizes: Object.values(dirs).map((dir) => Object.assign(size(dir), { bytes: 10_000 * 1024 ** 3 })),
        settings,
        pinned: () => false,
        now: Date.now(),
        diskLevel: async (dir) => samples.get(dir) ?? null,
        lowPriority: true,
      });
      const of = (dir: string) => walks.filter((walk) => walk.some((arg) => arg.startsWith(dir)));
      return {
        walks: {
          critical: of(dirs.critical),
          unsampled: of(dirs.unsampled),
          foreign: of(dirs.foreign),
          normal: of(dirs.normal),
        },
        bytes: planned.actions.map((action) => action.bytes),
      };
    }

    const niced = (walks: string[][]) =>
      walks.length > 0 &&
      walks.every(([file, ...args]) => file === 'nice' && args.slice(0, 3).join(' ') === '-n 19 du');

    it.each([
      ['darwin', '/usr/bin/ionice', '/usr/sbin/taskpolicy -d utility nice -n 19 du'],
      ['linux', '/usr/bin/ionice', 'ionice -c3 nice -n 19 du'],
      ['linux', null, 'nice -n 19 du'],
    ] as const)(
      'on %s with ionice at %s, throttles I/O only on the device a sample read at normal',
      async (on, ionice, throttled) => {
        const { walks } = await plan(on, ionice);

        expect(niced(walks.critical)).toBe(true);
        expect(niced(walks.unsampled)).toBe(true);
        expect(niced(walks.foreign)).toBe(true);
        expect(walks.normal.length).toBeGreaterThan(0);
        for (const walk of walks.normal) expect(walk.join(' ')).toMatch(new RegExp(`^${throttled} `));
      },
    );

    it.each([
      ['missing', Object.assign(new Error('spawn ionice ENOENT'), { code: 'ENOENT' })],
      ['rejecting its arguments', Object.assign(new Error('ionice: invalid option'), { status: 1, stdout: '' })],
    ])('retries each walk under nice alone when ionice is %s, and plans the same bytes', async (_, error) => {
      const plain = await plan('linux', null);
      const { walks, bytes } = await plan('linux', '/usr/bin/ionice', (file) => (file === 'ionice' ? error : null));

      expect(bytes).toEqual(plain.bytes);
      expect(walks.normal.length).toBeGreaterThan(0);
      for (let at = 0; at < walks.normal.length; at += 2) {
        const [failed, retried] = [walks.normal[at] ?? [], walks.normal[at + 1] ?? []];
        expect(failed[0]).toBe('ionice');
        expect(retried.slice(0, 3)).toEqual(['nice', '-n', '19']);
        expect(retried.slice(3)).toEqual(failed.slice(5));
      }
    });

    it.each([
      ['printed a partial size', Object.assign(new Error('du: denied'), { status: 1, stdout: '4\tx\n' })],
      ['hit its deadline', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', status: null, stdout: '' })],
    ])('does not retry a throttled walk that %s', async (_, error) => {
      const { walks } = await plan('linux', '/usr/bin/ionice', (file) => (file === 'ionice' ? error : null));

      expect(walks.normal.length).toBeGreaterThan(0);
      expect(walks.normal.every(([file]) => file === 'ionice')).toBe(true);
    });
  });
});
