import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { benchmarkEnvironment, isolatedShellEnvironment } from './shell-environment.mjs';

const probe =
  'console.log(JSON.stringify(Object.fromEntries(["LANG","LC_ALL","LC_CTYPE","LC_MESSAGES","GEM_HOME","PATH"].map(k=>[k,process.env[k]??null]))))';

test('preparation and runner children receive the same locale despite inherited differences', () => {
  const inherited = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    LC_MESSAGES: 'fr_CA.UTF-8',
    GEM_HOME: '/unrelated/ruby',
  };
  const run = (env) =>
    JSON.parse(execFileSync(process.execPath, ['-e', probe], { env: benchmarkEnvironment(env), encoding: 'utf8' }));
  const prepared = run({ ...inherited, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LC_CTYPE: 'C.UTF-8' });
  expect(run(inherited)).toEqual(prepared);
  expect(prepared).toEqual({
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_CTYPE: 'C.UTF-8',
    LC_MESSAGES: null,
    GEM_HOME: null,
    PATH: inherited.PATH,
  });
  expect(inherited.LANG).toBe('en_US.UTF-8');
});

describe.skipIf(!existsSync('/bin/zsh'))('isolated agent shell', () => {
  test.each(['-c', '-lc'])('restores pinned locale and PATH in %s commands', (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'stim-bench-shell-'));
    try {
      const pinnedPath = "/tmp/bench path's tools:/usr/bin:/bin";
      const env = isolatedShellEnvironment({ ...process.env, PATH: pinnedPath }, directory);
      const output = execFileSync('/bin/zsh', [mode, `"${process.execPath}" -e '${probe}'`], {
        env: {
          ...env,
          PATH: '/wrong',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          LC_CTYPE: 'UTF-8',
          LC_MESSAGES: 'fr_CA.UTF-8',
        },
        encoding: 'utf8',
      });
      expect(JSON.parse(output)).toEqual({
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        LC_CTYPE: 'C.UTF-8',
        LC_MESSAGES: null,
        GEM_HOME: null,
        PATH: pinnedPath,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
