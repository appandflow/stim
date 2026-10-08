import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugLogDir } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getExecutor, resetExecutor } from '../exec.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-exec-debug-'));
  process.env.STIM_HOME = home;
  process.env.STIM_DEBUG = '1';
  resetExecutor();
});
afterEach(() => {
  delete process.env.STIM_HOME;
  delete process.env.STIM_DEBUG;
  rmSync(home, { recursive: true, force: true });
});

test('with STIM_DEBUG a child process is recorded by program and duration, never by arguments', () => {
  const executor = getExecutor();
  executor.runFile(process.execPath, ['-e', '0', 'secret-argument-value']);
  expect(() => executor.runFile(process.execPath, ['-e', 'process.exit(3)', 'another-secret'])).toThrow('Command failed');
  const text = readFileSync(join(debugLogDir(), 'cli.ndjson'), 'utf8');
  expect(text).not.toMatch(/secret-argument-value|another-secret/);
  const lines = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines).toMatchObject([
    { event: 'exec', program: expect.stringMatching(/^node/), ok: true, ms: expect.any(Number) },
    { event: 'exec', ok: false, exit: 3 },
  ]);
});
