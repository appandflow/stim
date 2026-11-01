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
      caches: [{ dir: lockedDir, name: 'Fixture cache 1', prune: 'entries', entriesDepth: 1 }],
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
  await runGc({ ...opts, json: true, delete: true }, { findProjectRoot: () => null });
  expect(out).toHaveBeenCalledTimes(1);
  return JSON.parse(String(out.mock.lastCall?.[0]));
}

describe.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'gc --delete --json with a shared cache that cannot be changed (POSIX directory permissions)',
  () => {
    test.each([
      ['trimmed with --older-than', { cache: 'Fixture cache 1', olderThan: 14 }],
      ['emptied with --cache all', { cache: 'all' }],
    ] as const)('failures matches the failed cache result and the exit code when it is %s', async (_name, scope) => {
      const payload = await gcJson({ ...scope });
      const failed = payload.results.filter((result: { status: string }) => result.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(process.exitCode).toBe(1);
      expect(payload.failures).toBe(failed.length);
    });
  },
);
