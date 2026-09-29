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

  calls.length = 0;
  vi.setSystemTime(5_000);
  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual([]);

  calls.length = 0;
  allowXcode = true;
  vi.setSystemTime(10_001);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['xcode-select', 'compile', 'helper']);

  calls.length = 0;
  vi.setSystemTime(999_999);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['helper']);
});

test('readFootprints doubles the backoff on repeated failures, then recovers once the cause clears', async () => {
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

test('readFootprints caps the backoff at 10 minutes after repeated failures', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const calls: string[] = [];
  mockExecutor(() => false, calls);

  // Uncapped doubling from 10s would exceed a 600001ms wait by the 7th failure (10s, 20s, ..., 640s).
  // A retry on every iteration proves the backoff never grew past the 10-minute cap.
  let now = 0;
  for (let i = 0; i < 8; i++) {
    calls.length = 0;
    expect(await readFootprints()).toBeNull();
    expect(calls).toEqual(['xcode-select']);
    now += 600_001;
    vi.setSystemTime(now);
  }
});

test('readFootprints shares one in-flight build between concurrent calls', async () => {
  vi.setSystemTime(0);
  const calls: string[] = [];
  mockExecutor(() => true, calls);

  const [first, second] = await Promise.all([readFootprints(), readFootprints()]);
  expect(first).toEqual(new Map([[123, 456]]));
  expect(second).toEqual(new Map([[123, 456]]));
  expect(calls.filter((c) => c === 'compile')).toHaveLength(1);
});
