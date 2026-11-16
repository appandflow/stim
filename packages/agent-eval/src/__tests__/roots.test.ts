import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readablePaths } from '../drivers/shared.ts';
import { prepareResultsRoot, productionRoots, requireConfined } from '../roots.ts';
import type { Roots } from '../types.ts';

test('the production roots come from the OS user only', () => {
  const roots = productionRoots();
  expect(roots.codexHome).toBe(join(roots.home, '.codex'));
  expect(roots.claudeProjects).toBe(join(roots.home, '.claude', 'projects'));
});

describe.skipIf(process.platform === 'win32')('where a login and the results may sit', () => {
  let root: string;
  let roots: Roots;
  let readableDir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'confine-')));
    roots = { home: join(root, 'home'), claudeProjects: '', claudeTmp: '', codexHome: join(root, 'home', '.codex') };
    readableDir = join(root, 'home', 'checkout', 'packages', 'stim-cli');
    mkdirSync(readableDir, { recursive: true });
    mkdirSync(roots.codexHome);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const readable = () => [readableDir];

  test('a login at the default place inside the home passes', () => {
    writeFileSync(join(roots.codexHome, 'auth.json'), '{}');
    expect(requireConfined(join(roots.codexHome, 'auth.json'), roots.home, 'the Codex login', readable())).toBe(
      join(roots.codexHome, 'auth.json'),
    );
  });

  test.each([
    [
      'a path that climbs out of the home',
      () => join(root, 'home', '..', 'outside', 'auth.json'),
      /must be inside the home/,
    ],
    ['a login inside a readable package folder', () => join(readableDir, 'auth.json'), /agents can read/],
    ['a symlinked auth.json pointing into the checkout', () => join(roots.codexHome, 'auth.json'), /agents can read/],
    ['the home itself', () => roots.home, /must be inside the home/],
  ])('%s is refused', (_, path, message) => {
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside', 'auth.json'), '{}');
    writeFileSync(join(readableDir, 'auth.json'), '{}');
    symlinkSync(join(readableDir, 'auth.json'), join(roots.codexHome, 'auth.json'));
    expect(() => requireConfined(path(), roots.home, 'the Codex login', readable())).toThrow(message);
  });

  test('a login whose symlink leads out of the home is refused', () => {
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'auth.json'), '{}');
    symlinkSync(join(root, 'outside', 'auth.json'), join(roots.codexHome, 'auth.json'));
    expect(() =>
      requireConfined(join(roots.codexHome, 'auth.json'), roots.home, 'the Codex login', readable()),
    ).toThrow(/must be inside the home/);
  });

  test('the results root is created private and passes the production check against the real readable list', () => {
    expect(prepareResultsRoot(roots, readablePaths())).toBe(join(roots.home, '.stim-agent-eval', 'results'));
  });

  test('a results ancestor that is a symlink into a readable place is refused', () => {
    symlinkSync(readableDir, join(roots.home, '.stim-agent-eval'));
    expect(() => prepareResultsRoot(roots, readable())).toThrow(/agents can read/);
  });

  test('a results ancestor that is a symlink out of the home is refused', () => {
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(roots.home, '.stim-agent-eval'));
    expect(() => prepareResultsRoot(roots, readable())).toThrow(/must be inside the home/);
  });
});
