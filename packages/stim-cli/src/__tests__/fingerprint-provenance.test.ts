import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { lockfileClassifier } from '../fingerprint/provenance.ts';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stim-fp-prov-'));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const npmLock = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/reg': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz',
      integrity: 'sha512-reg',
    },
    'node_modules/linked': { resolved: '../linked', link: true },
    'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/b.git#abc' },
    'node_modules/bare-tarball': { version: '1.0.0', resolved: 'https://example.com/b.tgz' },
  },
});

const pnpmLock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies: {}

packages:

  reg@1.0.0:
    resolution: {integrity: sha512-reg}

  patched@2.0.0:
    resolution: {integrity: sha512-patched}

  '@scope/tar@1.0.0':
    resolution: {tarball: https://example.com/tar.tgz}

  forked@https://codeload.github.com/a/forked/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/a/forked/tar.gz/abc}
    version: 1.0.0

  forked@1.0.0:
    resolution: {integrity: sha512-forked}

snapshots:

  reg@1.0.0: {}

  patched@2.0.0(patch_hash=aaaa)(reg@1.0.0(patch_hash=bbbb)): {}
`;

const yarnClassicLock = `# yarn lockfile v1


reg@^1.0.0:
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#abc"
  integrity sha512-reg

"local@file:../local":
  version "1.0.0"

"gitdep@git+https://github.com/a/gitdep.git":
  version "1.0.0"
  resolved "git+https://github.com/a/gitdep.git#abc"
`;

const yarnBerryLock = `__metadata:
  version: 8

"reg@npm:^1.0.0":
  version: 1.0.0
  resolution: "reg@npm:1.0.0"
  checksum: 10c0/reg

"pat@npm:2.0.0":
  version: 2.0.0
  resolution: "pat@npm:2.0.0"
  checksum: 10c0/pat

"pat@patch:pat@npm%3A2.0.0#~/.yarn/patches/pat.patch":
  version: 2.0.0
  resolution: "pat@patch:pat@npm%3A2.0.0#~/.yarn/patches/pat.patch::version=2.0.0&hash=cafe"
  checksum: 10c0/patched

"ws@workspace:packages/ws":
  version: 0.0.0
  resolution: "ws@workspace:packages/ws"
`;

const bunLock = `{
  "lockfileVersion": 1,
  "packages": {
    "reg": ["reg@1.0.0", "", {}, "sha512-reg"],
    "gh": ["gh@github:a/gh#abc", {}, "a-gh-abc"],
    "parent/reg": ["reg@2.0.0", "", {}, "sha512-reg2"],
  },
}
`;

describe('package provenance from the lockfile', () => {
  test.each<[string, Record<string, string>, string, string, string, object]>([
    [
      'npm registry entry',
      { 'package-lock.json': npmLock },
      'node_modules/reg',
      'reg',
      '1.0.0',
      {
        mode: 'identity',
        integrity: 'sha512-reg',
        resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz',
      },
    ],
    [
      'npm workspace link',
      { 'package-lock.json': npmLock },
      'node_modules/linked',
      'linked',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'npm git dependency',
      { 'package-lock.json': npmLock },
      'node_modules/from-git',
      'from-git',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'npm tarball without integrity',
      { 'package-lock.json': npmLock },
      'node_modules/bare-tarball',
      'b',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'npm entry missing',
      { 'package-lock.json': npmLock },
      'node_modules/other',
      'other',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'npm lockfile v1, which has no install paths',
      { 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: {} }) },
      'node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'pnpm registry entry in its store directory',
      { 'pnpm-lock.yaml': pnpmLock },
      'node_modules/.pnpm/reg@1.0.0/node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'identity', integrity: 'sha512-reg' },
    ],
    [
      'pnpm patched copy, with its own patch hash and not a dependency patch',
      { 'pnpm-lock.yaml': pnpmLock },
      'node_modules/.pnpm/patched@2.0.0_patch_hash=aaaa_reg@1.0.0/node_modules/patched',
      'patched',
      '2.0.0',
      { mode: 'identity', integrity: 'sha512-patched', patch: 'aaaa' },
    ],
    [
      'pnpm tarball resolution',
      { 'pnpm-lock.yaml': pnpmLock },
      'node_modules/.pnpm/@scope+tar@1.0.0/node_modules/@scope/tar',
      '@scope/tar',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'pnpm git copy whose version a registry entry shares',
      { 'pnpm-lock.yaml': pnpmLock },
      'node_modules/.pnpm/forked@https+++codeload.github.com+a+forked+tar.gz+abc/node_modules/forked',
      'forked',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'pnpm hoisted copy of a name that also has a git origin',
      { 'pnpm-lock.yaml': pnpmLock },
      'node_modules/forked',
      'forked',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'pnpm store directory of another version',
      { 'pnpm-lock.yaml': pnpmLock },
      'node_modules/.pnpm/reg@1.0.0-beta/node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'yarn classic registry entry',
      { 'yarn.lock': yarnClassicLock },
      'node_modules/reg',
      'reg',
      '1.0.0',
      {
        mode: 'identity',
        integrity: 'sha512-reg',
        resolved: 'https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#abc',
      },
    ],
    [
      'yarn classic file: dependency',
      { 'yarn.lock': yarnClassicLock },
      'node_modules/local',
      'local',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'yarn classic git dependency',
      { 'yarn.lock': yarnClassicLock },
      'node_modules/gitdep',
      'gitdep',
      '1.0.0',
      { mode: 'content' },
    ],
    [
      'yarn berry registry entry',
      { 'yarn.lock': yarnBerryLock },
      'node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'identity', integrity: '10c0/reg' },
    ],
    [
      'yarn berry patch over a registry entry',
      { 'yarn.lock': yarnBerryLock },
      'node_modules/pat',
      'pat',
      '2.0.0',
      { mode: 'identity', integrity: '10c0/pat', patch: 'cafe' },
    ],
    ['yarn berry workspace', { 'yarn.lock': yarnBerryLock }, 'node_modules/ws', 'ws', '0.0.0', { mode: 'content' }],
    [
      'bun registry tuple',
      { 'bun.lock': bunLock },
      'node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'identity', integrity: 'sha512-reg' },
    ],
    [
      'bun nested registry tuple',
      { 'bun.lock': bunLock },
      'node_modules/parent/node_modules/reg',
      'reg',
      '2.0.0',
      { mode: 'identity', integrity: 'sha512-reg2' },
    ],
    [
      'yarn link of a registry name and version',
      { 'yarn.lock': yarnClassicLock },
      'packages/reg',
      'reg',
      '1.0.0',
      { mode: 'content' },
    ],
    ['bun github tuple', { 'bun.lock': bunLock }, 'node_modules/gh', 'gh', '1.0.0', { mode: 'content' }],
    [
      'binary bun.lockb',
      { 'bun.lockb': '\u0000\u0001binary' },
      'node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'content' },
    ],
    ['no lockfile', {}, 'node_modules/reg', 'reg', '1.0.0', { mode: 'content' }],
    [
      "npm's install state when the lockfile is unreadable",
      { 'bun.lockb': '\u0000', 'node_modules/.package-lock.json': npmLock },
      'node_modules/reg',
      'reg',
      '1.0.0',
      { mode: 'identity', integrity: 'sha512-reg', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz' },
    ],
  ])('%s', (_case, files, dir, name, version, expected) => {
    const root = install(files);
    const provenance = lockfileClassifier(root).classify(join(root, dir), { name, version });
    expect(provenance).toEqual(expected);
  });
});
