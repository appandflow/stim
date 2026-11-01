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
  vi.restoreAllMocks();
  resetExecutor();
  vi.clearAllTimers();
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

test('readFootprints shares one in-flight build between concurrent calls', async () => {
  vi.setSystemTime(0);
  const calls: string[] = [];
  mockExecutor(() => true, calls);

  const [first, second] = await Promise.all([readFootprints(), readFootprints()]);
  expect(first).toEqual(new Map([[123, 456]]));
  expect(second).toEqual(new Map([[123, 456]]));
  expect(calls.filter((c) => c === 'compile')).toHaveLength(1);
});
