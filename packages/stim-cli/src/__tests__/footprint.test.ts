import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFootprints } from '../footprint.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-footprint-')));
  savedHome = process.env.STIM_HOME;
  // Each test gets its own $STIM_HOME so footprint.ts's home-keyed caches start empty: the module
  // has no test-only reset hook, matching the codebase rule against exports added solely for tests.
  process.env.STIM_HOME = join(root, 'state');
});

afterEach(() => {
  resetExecutor();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = savedHome;
});

function mockExecutor(allowXcode: () => boolean, calls: string[]) {
  setExecutor({
    runFileQuiet: (file: string) => {
      if (file === 'xcode-select') {
        calls.push('xcode-select');
        return allowXcode() ? '/Library/Developer/CommandLineTools' : null;
      }
      calls.push('helper');
      return '123 456\n';
    },
    runFileAsync: async (_file: string, args: string[] = []) => {
      calls.push('compile');
      const output = args[args.indexOf('-o') + 1]!;
      writeFileSync(output, '#!/bin/sh\n', { mode: 0o755 });
      return '';
    },
  });
}

test('readFootprints retries a failed helper build after a backoff instead of pinning the failure forever', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let allowXcode = false;
  const calls: string[] = [];
  mockExecutor(() => allowXcode, calls);

  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual(['xcode-select']);

  // Still inside the backoff window: no retry, no new xcode-select call.
  calls.length = 0;
  vi.setSystemTime(5_000);
  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual([]);

  // Backoff elapsed and the transient cause is gone: the helper builds and is used.
  calls.length = 0;
  allowXcode = true;
  vi.setSystemTime(10_001);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['xcode-select', 'compile', 'helper']);

  // A success is cached for the life of the process: no rebuild on the next call.
  calls.length = 0;
  vi.setSystemTime(999_999);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['helper']);
});

test('readFootprints doubles the backoff on repeated failures, capped, and resets it after a success', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let allowXcode = false;
  const calls: string[] = [];
  mockExecutor(() => allowXcode, calls);

  expect(await readFootprints()).toBeNull(); // backoff -> 10s
  calls.length = 0;

  vi.setSystemTime(10_001);
  expect(await readFootprints()).toBeNull(); // backoff -> 20s
  expect(calls).toEqual(['xcode-select']);

  // Only 15s after the second failure: still within the doubled 20s backoff.
  calls.length = 0;
  vi.setSystemTime(25_000);
  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual([]);

  calls.length = 0;
  allowXcode = true;
  vi.setSystemTime(30_002);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['xcode-select', 'compile', 'helper']);
});
