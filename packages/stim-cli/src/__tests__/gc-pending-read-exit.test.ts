import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gc, { runGc } from '../commands/gc.ts';
import { runCli } from '../cli/define-op.ts';
import { CliExit } from '../cli-operation.ts';

const state = vi.hoisted((): { hung: string | null; interrupted: number | null; scan: Error | null } => ({
  hung: null,
  interrupted: null,
  scan: null,
}));

vi.mock('../cli-operation.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli-operation.ts')>()),
  runProcessOperation: async () => ({ interrupted: state.interrupted }),
}));

vi.mock('../commands/gc/unmanaged.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/gc/unmanaged.ts')>()),
  unmanagedUsage: () => {
    if (state.scan) throw state.scan;
    return null;
  },
}));

vi.mock('../workspace/bounded-read.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/bounded-read.ts')>()),
  hungRead: () => state.hung,
}));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-pending-read-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  state.hung = null;
  state.interrupted = null;
  state.scan = null;
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('a gc that leaves a filesystem read pending exits explicitly, with its own code', async () => {
  state.hung = '/mnt/dead/entry';
  const exit = await runCli(gc, ['--dry-run'], { version: '9.9.9' }).catch((error: unknown) => error);
  expect(exit).toBeInstanceOf(CliExit);
  expect(exit).toMatchObject({ exitCode: 0 });
});

test('a gc cancelled while a read is pending exits explicitly with the cancel code', async () => {
  state.hung = '/mnt/dead/entry';
  state.interrupted = 130;
  const exit = await runCli(gc, ['--dry-run'], { version: '9.9.9' }).catch((error: unknown) => error);
  expect(exit).toMatchObject({ exitCode: 130 });
});

test('a gc with no pending read returns normally', async () => {
  await expect(runCli(gc, ['--dry-run'], { version: '9.9.9' })).resolves.toBe(0);
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
