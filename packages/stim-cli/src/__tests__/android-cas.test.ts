import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAndroidCas } from '../engine/android-cas.ts';
import { buildCacheKey } from '@stim-cli/core';

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

test('workspaces share CAS while compiler replacements invalidate APK and generated compiler state', () => {
  const compiler = join(root, 'compiler');
  writeFileSync(compiler, 'compiler v1');
  const ndk = join(root, 'ndk');
  mkdirSync(ndk);
  writeFileSync(join(ndk, 'source.properties'), 'Pkg.Revision = 28.2.13676358\n');
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
      resourceDir: join(root, 'resource'),
    }),
  );
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
