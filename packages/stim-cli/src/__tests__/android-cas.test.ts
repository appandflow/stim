import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAndroidCas } from '../engine/android-cas.ts';
import { getExecutor } from '../exec.ts';
import { buildCacheKey } from '@stim-cli/core';

const CAS_COMPILER = join(import.meta.dirname, '../../dist/android-cas-compiler.mjs');

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cas-')));
  savedHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(root, 'state');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = savedHome;
});

function writeToolchain(): { manifest: string; compiler: string; ndk: string; resourceDir: string } {
  const compiler = join(root, 'compiler');
  writeFileSync(
    compiler,
    `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const argv = process.argv.slice(2);
const at = argv.indexOf('-resource-dir');
if (at < 0 || !existsSync(argv[at + 1])) {
  process.stderr.write("fatal error: 'stddef.h' file not found");
  process.exit(1);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  const ndk = join(root, 'ndk');
  mkdirSync(ndk);
  writeFileSync(join(ndk, 'source.properties'), 'Pkg.Revision = 28.2.13676358\n');
  const resourceDir = join(root, 'resource');
  mkdirSync(resourceDir);
  const manifest = join(root, 'toolchain.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      clang: compiler,
      clangxx: compiler,
      lld: compiler,
      ar: compiler,
      ranlib: compiler,
      ndk,
      resourceDir,
    }),
  );
  return { manifest, compiler, ndk, resourceDir };
}

test('workspaces share CAS while compiler replacements invalidate APK and generated compiler state', () => {
  const { manifest, compiler } = writeToolchain();
  const a = join(root, 'A');
  const b = join(root, 'different', 'B');
  mkdirSync(a);
  mkdirSync(b, { recursive: true });
  const env = { STIM_ANDROID_CAS_TOOLCHAIN: manifest };
  const first = resolveAndroidCas(a, env)!;
  const second = resolveAndroidCas(b, env)!;
  expect(first.dir).toBe(second.dir);
  expect(first.id).toBe(second.id);
  expect(first.env.STIM_ANDROID_CAS_STATE).not.toBe(second.env.STIM_ANDROID_CAS_STATE);
  expect(JSON.parse(readFileSync(second.env.STIM_ANDROID_CAS_CONTEXT!, 'utf8')).source).toBe(b);
  expect(realpathSync(join(second.env.STIM_ANDROID_CAS_STATE!, 'clang++'))).toMatch(/android-cas-compiler.mjs$/);
  const key = buildCacheKey('android', 'same-source', { compiler: first.id });
  expect(key).not.toBe(buildCacheKey('android', 'same-source'));
  writeFileSync(compiler, 'compiler v2');
  const replaced = resolveAndroidCas(a, env)!;
  expect(replaced.dir).not.toBe(first.dir);
  expect(replaced.env.STIM_ANDROID_CAS_STATE).not.toBe(first.env.STIM_ANDROID_CAS_STATE);
  expect(buildCacheKey('android', 'same-source', { compiler: replaced.id })).not.toBe(key);
});

test('a manifest that parses but names no compiler says which fields it lacks', () => {
  const manifest = join(root, 'toolchain.json');
  writeFileSync(manifest, JSON.stringify({ ndk: join(root, 'ndk'), lld: 5 }));
  expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
    `${manifest} declares no clang, clangxx, lld, ar, ranlib, resourceDir.`,
  );
});

test('the compiler the setup produces compiles through the resource directory the manifest names', () => {
  const { manifest, resourceDir } = writeToolchain();
  const setup = resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })!;
  const state = setup.env.STIM_ANDROID_CAS_STATE!;
  getExecutor().runFile(process.execPath, [join(state, 'clang'), '-c', 'source.c'], {
    env: { STIM_ANDROID_CAS_CONTEXT: setup.env.STIM_ANDROID_CAS_CONTEXT! },
  });
  const record = JSON.parse(readFileSync(join(state, 'compiler.jsonl'), 'utf8'));
  expect(record.code).toBe(0);
  expect(record.argv).toEqual(expect.arrayContaining(['-resource-dir', resourceDir]));
});

test('a resourceDir the compiler cannot use is refused at setup instead of failing the compile', () => {
  const { manifest, compiler, ndk } = writeToolchain();
  const gone = join(root, 'gone');
  const context = join(root, 'context.json');
  writeFileSync(
    context,
    JSON.stringify({
      clang: compiler,
      clangxx: compiler,
      lld: compiler,
      ndk,
      resourceDir: gone,
      source: root,
      state: root,
      cache: join(root, 'cache'),
    }),
  );
  expect(
    getExecutor().runFileQuiet(process.execPath, [CAS_COMPILER, '-c', 'source.c'], {
      env: { STIM_ANDROID_CAS_CONTEXT: context },
    }),
  ).toBeNull();
  expect(JSON.parse(readFileSync(join(root, 'compiler.jsonl'), 'utf8')).stderr).toContain("'stddef.h' file not found");
  const fields = { clang: compiler, clangxx: compiler, lld: compiler, ar: compiler, ranlib: compiler, ndk };
  writeFileSync(manifest, JSON.stringify(fields));
  expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
    `${manifest} declares no resourceDir.`,
  );
  writeFileSync(manifest, JSON.stringify({ ...fields, resourceDir: gone }));
  expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
    `${manifest} names resourceDir ${gone}, which is not a directory.`,
  );
});

test('a compiler that is readable but not executable is refused at setup instead of spawning EACCES', () => {
  const { manifest, compiler } = writeToolchain();
  chmodSync(compiler, 0o644);
  expect(() => getExecutor().runFile(compiler, [])).toThrow(/EACCES/);
  expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
    `${manifest} names no executable clang, clangxx, lld, ar, ranlib.`,
  );
});

test('compiler evidence waits for inherited stderr to close after the compiler exits', () => {
  const compiler = join(root, 'compiler.cjs');
  writeFileSync(
    compiler,
    `#!/usr/bin/env node
require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.stderr.write("late compile job cache miss"), 80)'], { stdio: ['ignore', 'ignore', 2] }).unref();
process.exit(0);
`,
    { mode: 0o755 },
  );
  const context = join(root, 'context.json');
  writeFileSync(
    context,
    JSON.stringify({
      clang: compiler,
      clangxx: compiler,
      source: root,
      state: root,
      cache: join(root, 'cache'),
      resourceDir: root,
    }),
  );
  getExecutor().runFile(process.execPath, [CAS_COMPILER, '-c', 'source.c'], {
    env: { STIM_ANDROID_CAS_CONTEXT: context },
  });
  const record = JSON.parse(readFileSync(join(root, 'compiler.jsonl'), 'utf8'));
  expect(record.code).toBe(0);
  expect(record.stderr).toBe('late compile job cache miss');
});
