import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  canonicalJson,
  diffInputs,
  FINGERPRINT_SCHEMA,
  isUncertain,
  mergeInputs,
  preimage,
  preimageHash,
  type Input,
  type Preimage,
} from '../fingerprint/key.ts';
import { staticInputs, type StaticContext, type StaticTarget } from '../fingerprint/inputs.ts';

/**
 * One entry per schema, never edited once released: a change to the preimage format or to which rows the static
 * stages produce must bump FINGERPRINT_SCHEMA and add the next entry.
 */
const GOLDEN: Record<number, Record<'preimage' | 'cng' | 'bare' | 'monorepo', string>> = {
  1: {
    preimage: '4f336b7a45203709f7ba86755a7545755829cfd44e39774d83151213d31ee8c2',
    cng: '47bf96f7fd76a5efb02a76cc41714643c283270cd6369c54bf27ae0093744611',
    bare: 'ae3536e6a0cc0374ccf91d4a60104d4b661068f5d5646657c5d051ebfaa0905a',
    monorepo: 'eeedc14d5845a9bbb9d2525da78fb88660986b454853bbc28c90b3fdb8675aa7',
  },
  2: {
    preimage: 'd79850961fc73802e8b5133c398dfce8a72ce24074e014d4611f309aa05d3784',
    cng: '5d5ed18489cfb8c72f7dbece65ba0c92d64a4c8b03f1ecd677199ab5f359383e',
    bare: 'dc67d949fa858c081d157332fd7c9ce98751962baa909231bb2b4b30c81e3105',
    monorepo: '9ffaf874910d7278ad17ec3edeec429d4e78a3d1f5db2b9235cc5a059c65c477',
  },
  3: {
    preimage: '2b2a001dce1e1312d994039301df296f1793f884864bab973c24b6441d0b9b0e',
    cng: '27c79c91684e9de01acd3e04b3eb29f1d1a8ce7861c4e5e4c5d2dead268f1ffc',
    bare: '7f8dd29221e7a5f28f1e9d8ac391713b8b8bbc44c6d47f5082759cce8613fb77',
    monorepo: 'bbd47b37ce4d3b1378a57d9bb8b715d37f528b46cf7a1e7077eceefefa1e30d7',
  },
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-golden-')));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function keyOf(
  root: string,
  app: string,
  context: Omit<StaticContext, 'root' | 'tracked'>,
  target: StaticTarget,
  tracked: string[],
) {
  const result = staticInputs(
    { ...context, root: join(root, app), tracked: new Set(tracked.map((path) => join(root, path))) },
    target,
  );
  if (isUncertain(result)) throw new Error(result.uncertain);
  return preimageHash(preimage(target.platform, result.native, result.layout, result.inputs));
}

const fixedPreimage: Preimage = {
  schema: FINGERPRINT_SCHEMA,
  platform: 'ios',
  native: 'tracked',
  layout: { projectPath: 'ios', gradleRoot: null, module: null },
  inputs: [
    ['env:EXPO_USE_SOURCE', 'env', '0'.repeat(64)],
    ['ios/Podfile', 'file', 'a'.repeat(64)],
    ['package:react-native', 'package', 'b'.repeat(64)],
  ],
};

function goldenHashes(): Record<'preimage' | 'cng' | 'bare' | 'monorepo', string> {
  const cng = tree({
    'package-lock.json': '{}\n',
    'package.json':
      '{"name":"app","version":"1.0.0","scripts":{"start":"expo start"},"expo":{"install":{"exclude":["x"]}}}\n',
    'app.json': '{"expo":{"icon":"./assets/icon.png"}}\n',
    'assets/icon.png': 'icon\n',
    'patches/expo-image+1.0.0.patch': 'diff\n',
    '.fingerprintignore': '# local\nassets/*.tmp\n',
    'assets/scratch.tmp': 'ignored\n',
    'ios/Podfile': 'generated\n',
  });
  const bare = tree({
    'package-lock.json': '{}\n',
    'package.json': '{"name":"bare","dependencies":{"react-native":"0.88.0"}}\n',
    'ios/Podfile': "platform :ios, '16.0'\n",
    'ios/Podfile.lock': 'PODS:\n  - React (0.88.0)\n\nCOCOAPODS: 1.16.2\n',
    'ios/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n',
    'ios/App.xcworkspace/contents.xcworkspacedata': '<Workspace/>\n',
    'ios/Pods/Manifest.lock': 'PODS:\n',
    'ios/build/App.app/App': 'binary\n',
    'ios/App/AppDelegate.swift': 'import UIKit\n',
  });
  const monorepo = tree({
    'pnpm-lock.yaml':
      "lockfileVersion: '9.0'\n\npatchedDependencies:\n  foo@1.0.0:\n    hash: abc\n    path: patches/foo@1.0.0.patch\n",
    'patches/foo@1.0.0.patch': 'diff foo\n',
    'apps/mobile/package.json': '{"name":"mobile","dependencies":{"expo":"58.0.0"}}\n',
    'apps/mobile/modules/session/expo-module.config.json': '{"platforms":["apple","android"]}\n',
    'apps/mobile/modules/session/android/build.gradle': 'apply plugin: "com.android.library"\n',
    'apps/mobile/modules/session/android/src/main/java/Session.kt': 'class Session\n',
    'apps/mobile/modules/session/src/index.ts': 'export {};\n',
  });
  return {
    preimage: preimageHash(fixedPreimage),
    cng: keyOf(
      cng,
      '.',
      { expoResolves: true, config: { icon: './assets/icon.png', assetsDir: './assets' } },
      { platform: 'ios' },
      ['package.json'],
    ),
    bare: keyOf(bare, '.', { expoResolves: false }, { platform: 'ios' }, [
      'ios/Podfile',
      'ios/Podfile.lock',
      'ios/App.xcodeproj/project.pbxproj',
      'ios/App/AppDelegate.swift',
    ]),
    monorepo: keyOf(
      monorepo,
      'apps/mobile',
      {
        expoResolves: true,
        fingerprintConfig: {
          extraSources: [
            { type: 'dir', filePath: 'modules/session' },
            { type: 'contents', id: 'flavor', contents: 'beta' },
          ],
        },
      },
      { platform: 'android' },
      ['pnpm-lock.yaml', 'apps/mobile/package.json'],
    ),
  };
}

describe('fingerprint key', () => {
  test('project fingerprint inputs override extraSources, including an explicit empty list', () => {
    const root = tree({ 'package.json': '{"name":"app"}', 'old.txt': 'old', 'new.txt': 'new' });
    const context = {
      root,
      expoResolves: false,
      tracked: new Set<string>(),
      fingerprintConfig: { extraSources: [{ type: 'file', filePath: 'old.txt' }] },
    };
    const selected = staticInputs(context, { platform: 'ios', fingerprintInputs: ['new.txt'] });
    if (isUncertain(selected)) throw new Error(selected.uncertain);
    expect(selected.inputs.map((input) => input.name)).toContain('new.txt');
    expect(selected.inputs.map((input) => input.name)).not.toContain('old.txt');
    expect(selected.inputs.map((input) => input.name)).toContain('stim:fingerprintInputs');
    const empty = staticInputs(context, { platform: 'ios', fingerprintInputs: [] });
    if (isUncertain(empty)) throw new Error(empty.uncertain);
    expect(empty.inputs.map((input) => input.name)).not.toContain('old.txt');
    expect(empty.inputs.map((input) => input.name)).toContain('stim:fingerprintInputs');
    expect(empty.inputs.find((input) => input.name === 'stim:fingerprintInputs')?.hash).not.toBe(
      selected.inputs.find((input) => input.name === 'stim:fingerprintInputs')?.hash,
    );
  });

  test('a missing tracked iOS Podfile.lock is keyed unless explicitly ignored', () => {
    const root = tree({ 'package.json': '{"name":"app"}', 'ios/Podfile': 'platform :ios' });
    const context = { root, expoResolves: false, tracked: new Set([join(root, 'ios/Podfile')]) };
    const before = staticInputs(context, { platform: 'ios' });
    if (isUncertain(before)) throw new Error(before.uncertain);
    const absent = before.inputs.find((input) => input.name === 'ios/Podfile.lock');
    expect(absent).toMatchObject({ kind: 'file' });
    writeFileSync(join(root, 'ios/Podfile.lock'), 'PODS:\n  - Example (1.0)\n');
    const after = staticInputs(context, { platform: 'ios' });
    if (isUncertain(after)) throw new Error(after.uncertain);
    expect(after.inputs.find((input) => input.name === 'ios/Podfile.lock')?.hash).not.toBe(absent?.hash);
    rmSync(join(root, 'ios/Podfile.lock'));
    writeFileSync(join(root, '.fingerprintignore'), 'ios/Podfile.lock\n');
    const ignored = staticInputs(context, { platform: 'ios' });
    if (isUncertain(ignored)) throw new Error(ignored.uncertain);
    expect(ignored.inputs.find((input) => input.name === 'ios/Podfile.lock')).toBeUndefined();
  });

  test(`the preimage format and the static stages match the golden of schema ${FINGERPRINT_SCHEMA}`, () => {
    const golden = GOLDEN[FINGERPRINT_SCHEMA];
    expect(golden, `add a golden entry for schema ${FINGERPRINT_SCHEMA}`).toBeDefined();
    expect(goldenHashes()).toEqual(golden);
  });

  test('canonical JSON sorts keys by code unit at every depth and has no whitespace', () => {
    expect(canonicalJson({ b: 1, B: [{ z: null, a: 'x' }], a: { y: true, x: false }, skip: undefined })).toBe(
      '{"B":[{"a":"x","z":null}],"a":{"x":false,"y":true},"b":1}',
    );
    const [accent, emoji] = [String.fromCodePoint(0xe9), String.fromCodePoint(0x1f600)];
    expect(canonicalJson({ [emoji]: 3, [accent]: 1, z: 2 })).toBe(`{"z":2,"${accent}":1,"${emoji}":3}`);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/no form/);
    expect(() => canonicalJson(new Date(0))).toThrow(/no form/);
  });

  test('rows two stages produce merge, and rows that disagree under one name throw', () => {
    const row: Input = { name: 'ios/Podfile', kind: 'file', hash: 'a'.repeat(64) };
    const layout = { projectPath: 'ios', gradleRoot: null, module: null };
    expect(preimage('ios', 'tracked', layout, [row, row]).inputs).toHaveLength(1);
    expect(() => preimage('ios', 'tracked', layout, [row, { ...row, hash: 'b'.repeat(64) }])).toThrow(/disagree/);
    expect(preimageHash(preimage('ios', 'tracked', layout, [row]))).not.toBe(
      preimageHash(preimage('ios', 'generated', layout, [row])),
    );
  });

  test('installed copies of one package are named by version only when versions differ', () => {
    const copy = (name: string, version: string, hash: string): Input => ({ name, kind: 'file', hash, version });
    const names = (inputs: Input[]) => mergeInputs(inputs).map((input) => [input.name, input.hash]);
    const v5 = copy('npm:@scope/color/index.js', '5.5.0', 'a'.repeat(64));
    const v7 = copy('npm:@scope/color/index.js', '7.2.0', 'b'.repeat(64));
    const only7 = copy('npm:@scope/color/lib/extra.js', '7.2.0', 'c'.repeat(64));
    expect(names([v7, only7])).toEqual([
      ['npm:@scope/color/index.js', 'b'.repeat(64)],
      ['npm:@scope/color/lib/extra.js', 'c'.repeat(64)],
    ]);
    expect(names([only7, v7, v5])).toEqual([
      ['npm:@scope/color@5.5.0/index.js', 'a'.repeat(64)],
      ['npm:@scope/color@7.2.0/index.js', 'b'.repeat(64)],
      ['npm:@scope/color@7.2.0/lib/extra.js', 'c'.repeat(64)],
    ]);
    const patched = { ...v7, hash: 'd'.repeat(64) };
    const shared = names([v5, v7, patched]);
    expect(names([patched, v5, v7])).toEqual(shared);
    expect(shared.map(([name]) => name)).toEqual([
      'npm:@scope/color@5.5.0/index.js',
      'npm:@scope/color@7.2.0/index.js',
    ]);
    expect(shared[1]?.[1]).not.toBe(names([v5, v7, { ...v7, hash: 'e'.repeat(64) }])[1]?.[1]);
    expect(shared[1]?.[1]).not.toBe(names([v5, v7, v7])[1]?.[1]);
  });

  test('diffInputs reports added, removed and changed rows in name order whatever the input order', () => {
    const row = (name: string, hash: string): Input => ({ name, kind: 'file', hash });
    expect(
      diffInputs([row('b', '1'), row('a', '1'), row('c', '1')], [row('d', '1'), row('c', '2'), row('a', '1')]),
    ).toEqual([
      { name: 'b', kind: 'file', change: 'removed' },
      { name: 'c', kind: 'file', change: 'changed' },
      { name: 'd', kind: 'file', change: 'added' },
    ]);
    expect(diffInputs([row('a', '1')], [{ name: 'a', kind: 'env', hash: '1' }])).toEqual([
      { name: 'a', kind: 'env', change: 'changed' },
    ]);
  });
});
