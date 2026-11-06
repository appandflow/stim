import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  canonicalJson,
  diffInputs,
  FINGERPRINT_SCHEMA,
  isUncertain,
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
    cng: keyOf(cng, '.', { expoResolves: true, config: { icon: './assets/icon.png' } }, { platform: 'ios' }, [
      'package.json',
    ]),
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
  test(`the preimage format and the static stages match the golden of schema ${FINGERPRINT_SCHEMA}`, () => {
    const golden = GOLDEN[FINGERPRINT_SCHEMA];
    expect(golden, `add a golden entry for schema ${FINGERPRINT_SCHEMA}`).toBeDefined();
    expect(goldenHashes()).toEqual(golden);
  });

  test('canonical JSON sorts keys by code unit at every depth and has no whitespace', () => {
    expect(canonicalJson({ b: 1, B: [{ z: null, a: 'x' }], a: { y: true, x: false }, skip: undefined })).toBe(
      '{"B":[{"a":"x","z":null}],"a":{"x":false,"y":true},"b":1}',
    );
    expect(canonicalJson({ é: 1, z: 2, '😀': 3 })).toBe('{"z":2,"é":1,"😀":3}');
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
