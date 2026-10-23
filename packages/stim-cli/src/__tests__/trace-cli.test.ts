import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-trace-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), '{"name":"trace-fixture"}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stop(env: Record<string, string>) {
  const home = join(dir, 'home');
  return spawnSync(process.execPath, [cli, 'stop'], {
    cwd: dir,
    env: { ...process.env, STIM_HOME: home, STIM_TRACE: '', STIM_TRACE_OWNER: '', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

test('STIM_TRACE makes a real command write a trace with its command span and a child process span', () => {
  const file = join(dir, 'trace.json');
  const run = stop({ STIM_TRACE: file });
  expect(run.stdout).not.toContain(file);
  const events: {
    name: string;
    cat?: string;
    ph: string;
    dur?: number;
    args?: { argv?: string[]; exit?: number };
  }[] = JSON.parse(`${readFileSync(file, 'utf8').trimEnd().replace(/,$/, '')}]`);
  expect(events.find((event) => event.cat === 'command')).toMatchObject({
    name: 'stim stop',
    ph: 'X',
    args: { exit: run.status },
  });
  const git = events.find((event) => event.cat === 'exec' && event.name.startsWith('git'));
  expect(git).toMatchObject({ args: { argv: expect.arrayContaining(['git', 'rev-parse']) }, dur: expect.any(Number) });
});

test('without STIM_TRACE a command writes no trace file', () => {
  stop({});
  expect(readdirSync(dir).filter((entry) => !['home', '.git', 'package.json'].includes(entry))).toEqual([]);
  expect(existsSync(join(dir, 'home', 'trace.json'))).toBe(false);
});
