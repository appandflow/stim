import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli/define-op.ts';
import service from '../commands/service.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-helper-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test.each(['install', 'uninstall'])('%s --helper refuses on non-macOS with a Mac remedy', async (action) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  await expect(runCli(service, [action, '--helper'], { version: '1' })).rejects.toThrow(/requires macOS.*on a Mac/);
});

test('helper registration reports approval and unregistration does not require the server service', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const executable = join(home, 'Applications', 'Stim Host.app', 'Contents', 'MacOS', 'stim-host');
  mkdirSync(join(executable, '..'), { recursive: true });
  writeFileSync(executable, '');
  const calls: string[][] = [];
  setExecutor({
    async runFileAsync(file, args) {
      expect(file).toBe(executable);
      calls.push(args);
      return JSON.stringify({ state: args[0] === 'helper-register' ? 'requires approval' : 'not registered' });
    },
  });
  const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await runCli(service, ['install', '--helper'], { version: '1' });
  expect(log).toHaveBeenLastCalledWith(
    expect.stringContaining('requires approval; approve Stim Host in System Settings'),
  );
  await runCli(service, ['uninstall', '--helper'], { version: '1' });
  expect(log).toHaveBeenLastCalledWith('Runaway service helper: not registered\n');
  expect(calls).toEqual([['helper-register'], ['helper-unregister']]);
});

test('helper install refuses server options before changing either service', async () => {
  await expect(runCli(service, ['install', '--helper', '--serve'], { version: '1' })).rejects.toThrow(
    /cannot be combined/,
  );
});
