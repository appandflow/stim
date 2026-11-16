import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkOutput } from '../roots.ts';

describe.skipIf(process.platform === 'win32')('where results may go', () => {
  let root: string;
  let home: string;
  let checkout: string;
  let temporary: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'roots-')));
    home = join(root, 'home');
    checkout = join(home, 'checkout');
    temporary = join(root, 'tmp');
    mkdirSync(temporary);
    mkdirSync(checkout, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('a path inside the home and outside the checkout is accepted, even before it exists', () => {
    expect(checkOutput(join(home, '.stim-agent-eval', 'results'), home, checkout, temporary)).toBe(
      join(home, '.stim-agent-eval', 'results'),
    );
  });

  test.each([
    ['the home itself', () => home],
    ['the checkout', () => join(checkout, 'results')],
    ['a path outside the home', () => '/tmp/x'],
    ['the temporary directory', () => join(temporary, 'r')],
    ['a path under /opt/homebrew', () => '/opt/homebrew/var/x'],
    ['a path that climbs out of the home with ..', () => join(home, 'a', '..', '..', 'elsewhere')],
    ['a path that climbs into the checkout with ..', () => join(home, 'a', '..', 'checkout', 'r')],
  ])('%s is refused with the rule', (_, path) => {
    expect(() => checkOutput(path(), home, checkout, temporary)).toThrow(/must lie inside the home folder/);
  });

  test('a symlink inside the home that points into the checkout is refused', () => {
    symlinkSync(checkout, join(home, 'results-link'));
    expect(() => checkOutput(join(home, 'results-link', 'run'), home, checkout, temporary)).toThrow(/must lie inside/);
  });

  test('a symlink inside the home that points outside the home is refused', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(home, 'out-link'));
    expect(() => checkOutput(join(home, 'out-link', 'run'), home, checkout, temporary)).toThrow(/must lie inside/);
  });
});
