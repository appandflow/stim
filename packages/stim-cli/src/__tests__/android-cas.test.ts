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
    `#!${process.execPath}
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

test.skipIf(process.platform === 'win32')(
  'generated C and C++ compilers use Stim Node when the project shadows node on PATH',
  () => {
    const { manifest, compiler, ndk, resourceDir } = writeToolchain();
    const clangxx = join(root, 'compiler++');
    writeFileSync(clangxx, readFileSync(compiler), { mode: 0o755 });
    const fields = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(manifest, JSON.stringify({ ...fields, clangxx }));
    const bin = join(root, 'project-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const setup = resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })!;
    const state = setup.env.STIM_ANDROID_CAS_STATE!;
    const args = ['-c', "source file's.c", '-DVALUE=a b'];
    for (const name of ['clang', 'clang++']) {
      getExecutor().runFile(join(state, name), args, {
        timeoutMs: 60_000,
        cwd: root,
        env: { STIM_ANDROID_CAS_CONTEXT: setup.env.STIM_ANDROID_CAS_CONTEXT!, PATH: bin },
      });
    }
    const records = readFileSync(join(state, 'compiler.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.argv[0])).toEqual([compiler, clangxx]);
    for (const record of records) {
      expect(record.code).toBe(0);
      expect(record.cwd).toBe(root);
      expect(record.argv.slice(-args.length)).toEqual(args);
      expect(record.argv).toEqual(expect.arrayContaining(['-resource-dir', resourceDir]));
    }
    expect(records[0].argv).not.toContain('-nostdinc++');
    expect(records[1].argv).toEqual(
      expect.arrayContaining([
        '-nostdinc++',
        '-isystem',
        join(ndk, 'toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/include/c++/v1'),
      ]),
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'a resourceDir the compiler cannot use is refused at setup instead of failing the compile (spawns a POSIX shebang compiler; skipped on win32)',
  () => {
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
        timeoutMs: 60_000,
        env: { STIM_ANDROID_CAS_CONTEXT: context },
      }),
    ).toBeNull();
    expect(JSON.parse(readFileSync(join(root, 'compiler.jsonl'), 'utf8')).stderr).toContain(
      "'stddef.h' file not found",
    );
    const fields = { clang: compiler, clangxx: compiler, lld: compiler, ar: compiler, ranlib: compiler, ndk };
    writeFileSync(manifest, JSON.stringify(fields));
    expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
      `${manifest} declares no resourceDir.`,
    );
    writeFileSync(manifest, JSON.stringify({ ...fields, resourceDir: gone }));
    expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
      `${manifest} names resourceDir ${gone}, which is not a directory.`,
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'a compiler that is readable but not executable is refused at setup instead of spawning EACCES (POSIX executable bit; skipped on win32)',
  () => {
    const { manifest, compiler } = writeToolchain();
    chmodSync(compiler, 0o644);
    expect(() => getExecutor().runFile(compiler, [], { timeoutMs: 60_000 })).toThrow(/EACCES/);
    expect(() => resolveAndroidCas(root, { STIM_ANDROID_CAS_TOOLCHAIN: manifest })).toThrow(
      `${manifest} names no executable clang, clangxx, lld, ar, ranlib.`,
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'compiler evidence waits for inherited stderr to close after the compiler exits (spawns a POSIX shebang compiler; skipped on win32)',
  () => {
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
      timeoutMs: 60_000,
      env: { STIM_ANDROID_CAS_CONTEXT: context },
    });
    const record = JSON.parse(readFileSync(join(root, 'compiler.jsonl'), 'utf8'));
    expect(record.code).toBe(0);
    expect(record.stderr).toBe('late compile job cache miss');
  },
);
