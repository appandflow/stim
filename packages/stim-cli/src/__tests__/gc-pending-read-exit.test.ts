import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc } from '../commands/gc.ts';

const state = vi.hoisted((): { scan: Error | null } => ({
  scan: null,
}));

vi.mock('../commands/gc/unmanaged.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/gc/unmanaged.ts')>()),
  unmanagedUsage: () => {
    if (state.scan) throw state.scan;
    return null;
  },
}));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-pending-read-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  state.scan = null;
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('a scan that fails leaves the finished gc and its exit code as they are', async () => {
  state.scan = new Error('scan broke');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

  await expect(runGc({ dryRun: true })).resolves.toBeUndefined();
  expect(process.exitCode).toBeUndefined();
  expect(log.mock.calls.flat().join('\n')).toMatch(/Apply with: stim gc/);
});

test('a cleanup refusal from the scan still fails the gc', async () => {
  state.scan = Object.assign(new Error('Cannot verify cleanup for report child 42'), { reportCleanup: true });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

  await expect(runGc({ dryRun: true })).rejects.toBe(state.scan);
});
