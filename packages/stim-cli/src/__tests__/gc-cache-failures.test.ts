import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { metroCacheRoot } from '@stim-cli/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc as runGcCommand, runGcPass } from '../commands/gc.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig } from '../workspace/config.ts';

const runGc: typeof runGcCommand = (opts, deps) => runGcCommand(opts, deps, runGcPass);

let home: string;
let lockedDir: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-cache-failures-')));
  process.env.STIM_HOME = home;
  setExecutor({
    run: () => '',
    runFile: () => '',
    runQuiet: () => null,
    runFileQuiet: () => null,
    runFileAsync: async () => '',
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  lockedDir = join(home, 'fixcaches', 'cache-1');
  mkdirSync(join(lockedDir, 'entry'), { recursive: true });
  const longAgo = new Date(Date.now() - 60 * 86_400_000);
  utimesSync(join(lockedDir, 'entry'), longAgo, longAgo);
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({
      version: 1,
      caches: [
        {
          dir: lockedDir,
          name: 'Fixture cache 1',
          prune: 'entries',
          entriesDepth: 1,
        },
      ],
    }),
  );
  chmodSync(lockedDir, 0o500);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  chmodSync(lockedDir, 0o700);
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = undefined;
});

async function gcJson(opts: Parameters<typeof runGc>[0]) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ ...opts, json: true });
  expect(out).toHaveBeenCalledTimes(1);
  return JSON.parse(String(out.mock.lastCall?.[0]));
}

describe.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'gc --json with a shared cache that cannot be changed (POSIX directory permissions)',
  () => {
    test.each([
      ['the age sweep trims it at normal', 'normal', ['trim-cache']],
      ['critical also empties it', 'critical', ['trim-cache', 'empty-cache']],
    ] as const)(
      'failures matches the failed cache actions and the exit code when %s',
      async (_name, pressure, kinds) => {
        const payload = await gcJson({ pressure });
        const failed = payload.actions.filter((action: { outcome: string }) => action.outcome === 'failed');
        expect(failed.map((action: { kind: string }) => action.kind)).toEqual(kinds);
        for (const action of failed) expect(action.target).toContain(lockedDir);
        expect(payload.results.filter((result: { status: string }) => result.status === 'failed')).toHaveLength(
          kinds.length,
        );
        expect(payload.failures).toBe(kinds.length);
        expect(process.exitCode).toBe(1);
      },
    );
  },
);

test('cache cap dry runs agree with acting runs for recent and old entries', async () => {
  vi.stubEnv('STIM_CACHES_METRO_CACHE_MAX_GB', '0.00002');
  try {
    setExecutor({
      run: () => '',
      runFile: () => '',
      runQuiet: () => null,
      runFileQuiet: () => null,
      runFileAsync: async (file, args) => (file === 'du' ? `9766\t${args.at(-1)}\n` : ''),
    });
    const cache = metroCacheRoot();
    const dir = join(cache, 'project', 'bucket');
    mkdirSync(dir, { recursive: true });
    const entries = Array.from({ length: 5 }, (_, i) => join(dir, `entry-${i}`));
    for (const entry of entries) writeFileSync(entry, Buffer.alloc(2_000_000));
    const trim = (payload: {
      actions: { kind: string; target: string; outcome: string; bytes: number; detail: string }[];
    }) => payload.actions.find((action) => action.kind === 'trim-cache' && action.target === cache);
    const recentPayload = await gcJson({ dryRun: true, pressure: 'normal' });
    const recentDry = trim(recentPayload);
    expect(recentDry).toMatchObject({ outcome: 'kept', bytes: 0, detail: 'no unprotected entry was old enough' });
    vi.restoreAllMocks();
    const recentAct = trim(await gcJson({ pressure: 'normal' }));
    expect(recentAct).toMatchObject({ outcome: 'kept', bytes: 0, detail: recentDry?.detail });
    expect(entries.every((entry) => existsSync(entry))).toBe(true);
    vi.restoreAllMocks();
    const recentLadder = await gcJson({ dryRun: true, pressure: 'high' });
    expect(recentLadder.actions).toContainEqual(
      expect.objectContaining({
        rung: 3,
        kind: 'trim-cache',
        target: cache,
        outcome: 'kept',
        bytes: 0,
        detail: 'no unprotected entry to evict',
      }),
    );
    const old = new Date(Date.now() - 7 * 86_400_000);
    for (const entry of entries) utimesSync(entry, old, old);
    vi.restoreAllMocks();
    const oldDry = trim(await gcJson({ dryRun: true, pressure: 'normal' }));
    expect(oldDry).toMatchObject({ outcome: 'would', bytes: 10_000_000 });
    expect(entries.every((entry) => existsSync(entry))).toBe(true);
    vi.restoreAllMocks();
    const oldLadder = await gcJson({ dryRun: true, pressure: 'high' });
    expect(oldLadder.actions).toContainEqual(
      expect.objectContaining({ rung: 3, kind: 'trim-cache', target: cache, outcome: 'would', bytes: oldDry?.bytes }),
    );
    vi.restoreAllMocks();
    const oldAct = trim(await gcJson({ pressure: 'normal' }));
    expect(oldAct).toMatchObject({ outcome: 'done', bytes: oldDry?.bytes });
    expect(entries.every((entry) => !existsSync(entry))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
