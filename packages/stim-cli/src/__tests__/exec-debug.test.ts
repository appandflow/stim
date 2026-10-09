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
  const file = join(debugLogDir(), 'cli.ndjson');
  const inspectStart = `const rows = require('node:fs').readFileSync(process.argv[1], 'utf8').trim().split('\\n').map(JSON.parse); if (rows.at(-1).event !== 'exec.start') process.exit(11);`;
  executor.runFile(process.execPath, ['-e', inspectStart, file, 'secret-argument-value']);
  expect(() => executor.runFile(process.execPath, ['-e', 'process.exit(3)', 'another-secret'])).toThrow(
    'Command failed',
  );
  const text = readFileSync(join(debugLogDir(), 'cli.ndjson'), 'utf8');
  expect(text).not.toMatch(/secret-argument-value|another-secret/);
  const lines = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines).toMatchObject([
    { event: 'exec.start', program: expect.stringMatching(/^node/), executionId: expect.any(Number) },
    { event: 'exec', executionId: lines[0].executionId, ok: true, ms: expect.any(Number) },
    { event: 'exec.start', executionId: expect.any(Number) },
    { event: 'exec', executionId: lines[2].executionId, ok: false, exit: 3 },
  ]);
});

test('concurrent async commands retain distinct start and completion identities without arguments', async () => {
  const executor = getExecutor();
  const file = join(debugLogDir(), 'cli.ndjson');
  const inspectStart = `const rows = require('node:fs').readFileSync(process.argv[1], 'utf8').trim().split('\\n').map(JSON.parse); if (!rows.some(row => row.event === 'exec.start')) process.exit(11);`;
  await Promise.all([
    executor.runFileAsync(process.execPath, ['-e', inspectStart, file, 'async-secret']),
    executor.runFileAsync(process.execPath, ['-e', '0', 'second-async-secret']),
  ]);
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain('async-secret');
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const starts = rows.filter((row) => row.event === 'exec.start');
  expect(new Set(starts.map((row) => row.executionId)).size).toBe(2);
  for (const start of starts) {
    const end = rows.find((row) => row.event === 'exec' && row.executionId === start.executionId);
    expect(end).toMatchObject({ program: start.program, ok: true, ms: expect.any(Number) });
    expect(rows.indexOf(start)).toBeLessThan(rows.indexOf(end));
  }
});
