import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc } from '../commands/gc.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig } from '../workspace/config.ts';

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
