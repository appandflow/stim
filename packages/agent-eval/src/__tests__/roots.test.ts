import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { expect, test } from 'vitest';
import { readablePaths } from '../drivers/shared.ts';
import { productionRoots, resultsRoot } from '../roots.ts';

test('the production roots come from the OS user and ignore HOME and any override in the environment', () => {
  const plain = productionRoots({});
  const hostile = productionRoots({ HOME: '/tmp/fake-home', STIM_EVAL_HOME: '/tmp/other-home', TMPDIR: '/tmp/x' });
  expect(hostile).toEqual(plain);
  expect(plain.home).toBe(userInfo().homedir);
  expect(resultsRoot(plain)).toBe(join(userInfo().homedir, '.stim-agent-eval', 'results'));
});

test('a CODEX_HOME outside the real home is refused, because the agents can read what is outside it', () => {
  expect(() => productionRoots({ CODEX_HOME: '/opt/homebrew/codex' })).toThrow(/must be inside the home folder/);
  expect(productionRoots({ CODEX_HOME: join(userInfo().homedir, 'elsewhere', '.codex') }).codexHome).toBe(
    join(userInfo().homedir, 'elsewhere', '.codex'),
  );
});

test('the results root is not inside any path either driver lets an agent read', () => {
  const results = resultsRoot(productionRoots({}));
  for (const readable of readablePaths())
    expect([readable, results === readable || results.startsWith(`${readable}${sep}`)]).toEqual([readable, false]);
});
