import { execFileSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { diskUsageCacheFile, gcMarkFile, readGcMark, type Config } from '@stim-cli/core/state';
import { runDormantDependencies } from '../daemon/dependencies.ts';
import { stoppedOutputCandidates, stoppedOutputs } from '../daemon/stages.ts';
import { saveConfig } from '../workspace/config.ts';
import { testContext } from './_context.ts';

vi.mock('../workspace/protected-locations.ts', () => ({
  isProtectedLocation: () => false,
}));

const day = 86_400_000;
const reading = { devices: [], simsFailed: false };

describe('gc marks written by the lane', () => {
  let base: string;
  let roots: string;
  let config: Config;

  const checkout = (name: string, agedMs: number) => {
    const path = join(roots, name);
    mkdirSync(join(path, 'android'), { recursive: true });
    writeFileSync(join(path, 'android', 'build.gradle'), '');
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(path, '.gitignore'), 'build/\nnode_modules/\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    mkdirSync(join(path, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(path, 'android', 'app', 'build', 'out.bin'), 'x');
    const at = new Date(Date.now() - agedMs);
    const age = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) age(child);
        utimesSync(child, at, at);
      }
      utimesSync(dir, at, at);
    };
    age(path);
    return path;
  };

  const lane = (marks?: true) =>
    runDormantDependencies({
      config,
      act: false,
      log: () => {},
      ...reading,
      operation: testContext(),
      ...(marks ? { marks } : {}),
    });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-marks-')));
    roots = join(base, 'roots');
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {}, idle: { sourceDormantDays: 0 } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('marks each checkout the walk reads with the outputs rung 1 would delete there, sized from the cache', async () => {
    const idle = checkout('idle', 3 * day);
    const active = checkout('active', 0);
    saveConfig(config);
    const build = join(idle, 'android', 'app', 'build');
    mkdirSync(dirname(diskUsageCacheFile(build)), { recursive: true });
    const measuredAt = new Date(Date.now() - day).toISOString();
    writeFileSync(diskUsageCacheFile(build), JSON.stringify({ path: build, bytes: 4096, measuredAt }));

    await lane(true);

    const plan = await stoppedOutputCandidates(config, reading, 2 * 60_000);
    expect(plan.map(({ path }) => path)).toEqual([idle]);
    const [candidate] = plan;
    if (!candidate) throw new Error('rung 1 planned nothing');
    const planned = await stoppedOutputs(candidate, config);
    expect(planned).toEqual({ paths: [build], kept: [] });
    const mark = readGcMark(idle);
    expect(mark?.candidates).toEqual([{ kind: 'outputs', path: build, bytes: 4096, measuredAt }]);
    expect(Date.parse(mark?.lastActivityAt ?? '')).toBeLessThanOrEqual(Date.now() - 3 * day);

    const busy = readGcMark(active);
    expect(busy?.candidates).toEqual([
      { kind: 'outputs', path: join(active, 'android', 'app', 'build'), bytes: null, measuredAt: null },
    ]);
    expect(Date.parse(busy?.lastActivityAt ?? '')).toBeGreaterThan(Date.now() - day);
  }, 20_000);

  it('writes no mark from a walk that does not ask for marks', async () => {
    checkout('idle', 3 * day);
    saveConfig(config);

    await lane();
    await stoppedOutputCandidates(config, reading, 2 * 60_000);

    expect(existsSync(join(base, 'home', 'gc', 'marks'))).toBe(false);
  }, 20_000);

  it.each([
    ['a torn file', (root: string) => `{"v":1,"root":${JSON.stringify(root)},"cand`],
    ['an unknown version', (root: string) => JSON.stringify({ v: 2, root, candidates: [] })],
  ])(
    'reads %s as absent and replaces it with a fresh mark',
    async (_, text) => {
      const idle = checkout('idle', 3 * day);
      saveConfig(config);
      mkdirSync(dirname(gcMarkFile(idle)), { recursive: true });
      writeFileSync(gcMarkFile(idle), text(idle));
      expect(readGcMark(idle)).toBeNull();

      await lane(true);

      expect(readGcMark(idle)).toMatchObject({ v: 1, root: idle, candidates: [{ kind: 'outputs' }] });
    },
    20_000,
  );

  it('keeps a dirtyAt that is newer than the reads of the mark, and drops an older one', async () => {
    const idle = checkout('idle', 3 * day);
    const other = checkout('other', 3 * day);
    saveConfig(config);
    const dirty = (root: string, dirtyAt: string) => {
      mkdirSync(dirname(gcMarkFile(root)), { recursive: true });
      writeFileSync(
        gcMarkFile(root),
        JSON.stringify({ v: 1, root, device: 1, markedAt: dirtyAt, dirtyAt, lastActivityAt: null, candidates: [] }),
      );
    };
    const later = new Date(Date.now() + 60_000).toISOString();
    dirty(idle, later);
    dirty(other, new Date(Date.now() - 60_000).toISOString());

    await lane(true);

    expect(readGcMark(idle)?.dirtyAt).toBe(later);
    expect(readGcMark(other)).not.toHaveProperty('dirtyAt');
  }, 20_000);
});
