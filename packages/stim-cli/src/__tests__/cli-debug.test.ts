import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-cli-debug-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test('run_start names the command and flags but never a flag value', () => {
  const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
  spawnSync(process.execPath, [cli, 'settings', 'get', 'debug.logs', '--scope', 'tok-abc123'], {
    env: { ...process.env, STIM_HOME: home, STIM_DEBUG: '1' },
    stdio: 'ignore',
  });
  const text = readFileSync(join(home, 'logs', 'debug', 'cli.ndjson'), 'utf8');
  expect(text).not.toContain('tok-abc123');
  expect(JSON.parse(text.split('\n')[0]!)).toMatchObject({
    event: 'run_start',
    command: ['settings', 'get'],
    flags: ['--scope'],
  });
});
