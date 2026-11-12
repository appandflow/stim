import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { captureProcessToken } from '../process-identity.ts';
import { sweepParityLeftovers, writeParityMarker } from '../diagnostics/parity-worktrees.ts';

let dir: string;
let repo: string;
let root: string;

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const registered = () =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-parity-test-'));
  repo = join(dir, 'repo');
  root = join(dir, 'tmp');
  mkdirSync(repo);
  mkdirSync(root);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function parityDirectory(name: string): string {
  const base = join(root, name);
  mkdirSync(base);
  git('worktree', 'add', '-q', '--detach', join(base, 'head'), 'HEAD');
  return base;
}

async function endedProcessMarker(base: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const pid = child.pid ?? 0;
  const token = captureProcessToken(pid);
  expect(token).not.toBeNull();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  writeFileSync(
    join(base, 'stim-parity.json'),
    JSON.stringify({ version: 1, repo, owner: { pid, processToken: token } }),
  );
}

test('a leftover of a killed run is removed and unregistered from its repository', async () => {
  const base = parityDirectory('stim-parity-dead123');
  await endedProcessMarker(base);
  expect(registered()).toHaveLength(2);

  expect(await sweepParityLeftovers(root)).toEqual([base]);

  expect(existsSync(base)).toBe(false);
  expect(registered()).toHaveLength(1);
});

test('a run that is still alive keeps its directory and worktree', async () => {
  const base = parityDirectory('stim-parity-live123');
  writeParityMarker(base, repo);
  expect(JSON.parse(readFileSync(join(base, 'stim-parity.json'), 'utf8')).owner.pid).toBe(process.pid);

  expect(await sweepParityLeftovers(root)).toEqual([]);

  expect(existsSync(join(base, 'head'))).toBe(true);
  expect(registered()).toHaveLength(2);
});

test("a similarly named directory without Stim's record is left alone", async () => {
  const base = parityDirectory('stim-parity-user123');
  const elsewhere = join(dir, 'stim-parity-mine');
  mkdirSync(elsewhere);
  git('worktree', 'add', '-q', '--detach', join(elsewhere, 'head'), 'HEAD');

  expect(await sweepParityLeftovers(root)).toEqual([]);
  expect(await sweepParityLeftovers(dir)).toEqual([]);

  expect(existsSync(join(base, 'head'))).toBe(true);
  expect(existsSync(join(elsewhere, 'head'))).toBe(true);
  expect(registered()).toHaveLength(3);
});
