import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { findStaleHomeJobs, homeIsGone, parseLaunchdJob, removeStaleHomeJobs } from '../daemon/launchd-jobs.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const printed = (state: string, home: string) =>
  `gui/501/x = {\n\tactive count = 0\n\tstate = ${state}\n\n\tinherited environment = {\n\t\tSTIM_HOME => /inherited\n\t}\n\n\tenvironment = {\n\t\tSTIM_HOME => ${home}\n\t}\n}\n`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-launchd-jobs-'));
});

afterEach(() => {
  resetExecutor();
  rmSync(dir, { recursive: true, force: true });
});

function launchctl(jobs: Record<string, { pid: string; state: string; home: string }>) {
  const removed: string[] = [];
  setExecutor({
    runFileQuiet: (_file: string, args: string[]) => {
      if (args[0] === 'list')
        return Object.entries(jobs)
          .map(([label, job]) => `${job.pid}\t0\t${label}`)
          .join('\n');
      const label = args[1]?.replace('gui/' + String(process.getuid?.()) + '/', '') ?? '';
      if (args[0] === 'print') return jobs[label] ? printed(jobs[label].state, jobs[label].home) : null;
      if (args[0] === 'remove') {
        removed.push(args[1] ?? '');
        return '';
      }
      return null;
    },
  });
  return removed;
}

test('parseLaunchdJob reads the top-level state and the job environment, not the inherited one', () => {
  expect(parseLaunchdJob(printed('not running', '/h'))).toEqual({ running: false, home: '/h' });
  expect(parseLaunchdJob(printed('running', '/h')).running).toBe(true);
  expect(parseLaunchdJob('').running).toBe(true);
});

test('only a stopped stimd job whose Stim home is gone is removed', async () => {
  const alive = join(dir, 'alive');
  mkdirSync(alive);
  const removed = launchctl({
    'dev.stim.stimd.aaaaaaaaaaaa.000001': { pid: '-', state: 'not running', home: join(dir, 'gone', 'home') },
    'dev.stim.stimd.aaaaaaaaaaaa.000002': { pid: '-', state: 'not running', home: alive },
    'dev.stim.stimd.aaaaaaaaaaaa.000003': { pid: '321', state: 'running', home: join(dir, 'gone', 'home') },
    'dev.stim.stimd.aaaaaaaaaaaa.000004': { pid: '-', state: 'running', home: join(dir, 'gone', 'home') },
    'com.example.other': { pid: '-', state: 'not running', home: join(dir, 'gone', 'home') },
    'dev.stim.stimd.aaaaaaaaaaaa.000005': { pid: '-', state: 'not running', home: '/Volumes/Stim SSD/home' },
  });
  await expect(removeStaleHomeJobs()).resolves.toEqual([
    { label: 'dev.stim.stimd.aaaaaaaaaaaa.000001', home: join(dir, 'gone', 'home') },
  ]);
  expect(removed).toEqual(['dev.stim.stimd.aaaaaaaaaaaa.000001']);
});

test('findStaleHomeJobs removes nothing', async () => {
  const removed = launchctl({
    'dev.stim.stimd.aaaaaaaaaaaa.000001': { pid: '-', state: 'not running', home: join(dir, 'gone') },
  });
  expect(await findStaleHomeJobs()).toHaveLength(1);
  expect(removed).toEqual([]);
});

test('a home that cannot be judged is kept', () => {
  mkdirSync(join(dir, 'real'));
  symlinkSync('/Volumes/Unmounted', join(dir, 'link'));
  expect(homeIsGone(join(dir, 'real', 'home'))).toBe(true);
  expect(homeIsGone(join(dir, 'real'))).toBe(false);
  expect(homeIsGone(join(dir, 'link', 'home'))).toBe(false);
  expect(homeIsGone('/Volumes/Unmounted/home')).toBe(false);
  expect(homeIsGone('relative/home')).toBe(false);
});

test('the test guard keeps a sweep away from the real launchctl', async () => {
  const calls: string[][] = [];
  setExecutor({
    findExecutable: () => '/bin/launchctl',
    runFileQuiet: (_file: string, args: string[]) => {
      calls.push(args);
      return '';
    },
  });
  await expect(removeStaleHomeJobs()).resolves.toEqual([]);
  expect(calls).toEqual([]);
});
