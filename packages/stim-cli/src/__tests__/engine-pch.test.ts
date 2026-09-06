import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import { relocatePchArguments } from '../engine/pch-compiler.ts';
import { resolvePch } from '../engine/pch.ts';

let root: string;
let savedHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-pch-'));
  savedHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(root, 'home');
});
afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = savedHome;
});

test('canonicalizes only a relocatable PCH cc1 root and preserves the Android driver sysroot', () => {
  const nested = join(root, 'build');
  mkdirSync(nested);
  const relativeRoot = join(nested, '..');
  const args = [
    '--sysroot=/ndk/sysroot',
    '-Xclang',
    '-relocatable-pch',
    '-Xclang',
    '-isysroot',
    '-Xclang',
    relativeRoot,
    '-c',
    'a.cpp',
  ];
  expect(relocatePchArguments(args)).toEqual([...args.slice(0, 6), realpathSync(root), ...args.slice(7)]);
  expect(args[6]).toBe(relativeRoot);
  const search = ['-relocatable-pch', `-I${nested}/..`, '-isystem', `${nested}/..`];
  expect(relocatePchArguments(search)).toEqual([
    '-relocatable-pch',
    `-I${realpathSync(root)}`,
    '-isystem',
    realpathSync(root),
  ]);
  expect(relocatePchArguments([...search, '-E'])).toEqual([...search, '-E']);
  expect(relocatePchArguments(['-isysroot', 'missing-sdk', '-c', 'a.c'])).toEqual([
    '-isysroot',
    'missing-sdk',
    '-c',
    'a.c',
  ]);
});

test('a missing relocation root fails instead of compiling against a different checkout', () => {
  expect(() =>
    relocatePchArguments(['-relocatable-pch', '-Xclang', '-isysroot', '-Xclang', join(root, 'missing')]),
  ).toThrow(/ENOENT/);
});

test('preserves ccache prefix wrappers from environment or ccache configuration', () => {
  const ccache = { dir: root, statsLog: join(root, 'stats'), env: { CMAKE_CXX_COMPILER_LAUNCHER: '/ccache' } };
  setExecutor({ runFileQuiet: () => '' });
  expect(resolvePch(root, ccache, { CCACHE_PREFIX: 'distcc' })).toBeNull();
  expect(resolvePch(root, ccache, { CCACHE_PREFIX_CPP: 'custom-preprocessor' })).toBeNull();
  setExecutor({
    runFileQuiet: (_binary: string, args: string[]) => (args[1] === 'prefix_command_cpp' ? 'wrapper' : ''),
  });
  expect(resolvePch(root, ccache, {})).toBeNull();
  setExecutor({ runFileQuiet: () => null });
  expect(resolvePch(root, ccache, {})).toBeNull();
});
