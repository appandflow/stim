import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as cliOps from '../cli/define-op.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-cli-json-error-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('--json prints a coded error when config cannot be parsed', () => {
  writeFileSync(join(home, 'config.json'), '{bad');
  const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'status', '--json'], {
    env: { ...process.env, STIM_HOME: home },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: 'STIM_CONFIG_CORRUPT',
    message: expect.any(String),
  });
  expect(result.stderr).toContain('STIM_CONFIG_CORRUPT:');
});

test('--json keeps the existing payload when a command prints and then throws a coded error', async () => {
  Reflect.set(globalThis, Symbol.for('stim.main'), true);
  const { main } = await import('../../bin/cli.ts');
  vi.stubEnv('STIM_HOME', home);
  const payload = { ok: true };
  vi.spyOn(cliOps, 'runCli').mockImplementation(async () => {
    console.log(JSON.stringify(payload));
    throw Object.assign(new Error('cleanup failed'), { code: 'STIM_CLEANUP_FAILED', remedy: 'Retry cleanup.' });
  });
  let stdout = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    stdout += String(chunk);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback();
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = new Error('exit');
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exit;
  });
  await expect(main(['node', 'stim', 'status', '--json'])).rejects.toBe(exit);
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(JSON.parse(stdout)).toEqual(payload);
  expect(process.stdout.write).toBe(write);
});
