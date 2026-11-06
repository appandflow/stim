import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupWorktrees, hashes, mutation, type Measurement } from './fingerprint-parity-harness.ts';
import { git, rows, verdict, write } from './fingerprint-parity-rows.ts';

const MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const SLOW = 120_000;
let fixtures: Record<'generated' | 'tracked', { root: string; baseline: Measurement }>;
const temps: string[] = [];

function fixture(native: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-parity-fixture-')));
  temps.push(root);
  write(join(root, '.gitignore'), 'node_modules/\n.expo/\nios/Pods/\nios/*.xcworkspace/\n**/xcuserdata/\n');
  write(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'parity-app',
      version: '1.0.0',
      dependencies: { expo: '*', 'expo-constants': '*', 'react-native': '*' },
    }),
  );
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  write(join(root, 'parity-source.js'), 'export const parity = 1;\n');
  write(
    join(root, 'app.json'),
    JSON.stringify({
      expo: {
        name: 'Parity',
        slug: 'parity',
        version: '1.0.0',
        ios: { version: '1.0.0', buildNumber: '1' },
        android: { version: '1.0.0', versionCode: 1 },
        plugins: ['./parity-input.cjs'],
      },
    }),
  );
  write(
    join(root, 'app.config.js'),
    'module.exports = ({ config }) => ({ ...config, extra: { native: process.env.PARITY_NATIVE ?? "initial" } });\n',
  );
  write(
    join(root, 'parity-input.cjs'),
    "const { withInfoPlist } = require('expo/config-plugins'); module.exports = config => withInfoPlist(config, mod => { mod.modResults.StimParity = config.ios?.infoPlist?.StimParity ?? 'initial'; return mod; });\n",
  );
  write(
    join(root, 'parity-plugin.cjs'),
    'module.exports = config => ({ ...config, ios: { ...config.ios, supportsTablet: true } });\n',
  );
  write(join(root, 'modules/parity/package.json'), '{"name":"parity-module","version":"1.0.0"}\n');
  write(
    join(root, 'modules/parity/expo-module.config.json'),
    '{"platforms":["apple"],"apple":{"modules":["ParityModule"]}}\n',
  );
  write(
    join(root, 'modules/parity/ios/Parity.podspec'),
    "Pod::Spec.new do |s|\n  s.name = 'Parity'\n  s.version = '1.0.0'\nend\n",
  );
  if (native) {
    write(
      join(root, 'ios/Podfile'),
      `platform :ios, '16.0'
config_command = ['node', '--eval', 'require(require.resolve("expo/bin/autolinking"))(process.argv.slice(1))', 'react-native-config', '--json', '--platform', 'ios']
config = use_native_modules!(config_command)
`,
    );
    write(
      join(root, 'ios/Podfile.lock'),
      `PODS:\n  - Parity (1.0.0)\n\nSPEC CHECKSUMS:\n  Parity: ${'0'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`,
    );
    write(join(root, 'ios/Parity.xcodeproj/project.pbxproj'), '// !$*UTF8*$!\n');
    write(join(root, 'ios/AppDelegate.swift'), 'let parity = 1\n');
  }
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Parity');
  git(root, 'config', 'user.email', 'parity@example.com');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  symlinkSync(MODULES, join(root, 'node_modules'), 'junction');
  return root;
}

describe.skipIf(!existsSync(MODULES))('fingerprint change-detection parity', () => {
  beforeAll(async () => {
    const generated = fixture(false);
    const tracked = fixture(true);
    fixtures = {
      generated: { root: generated, baseline: await hashes(generated, 'ios', true) },
      tracked: { root: tracked, baseline: await hashes(tracked, 'ios', true) },
    };
  }, SLOW);
  afterEach(() => {
    cleanupWorktrees();
    for (const { root } of Object.values(fixtures ?? {})) {
      git(root, 'checkout', '--', '.');
      git(root, 'clean', '-ffdx', '-e', 'node_modules');
    }
  });
  afterAll(() => {
    for (const root of temps) rmSync(root, { recursive: true, force: true });
  });

  it.each(rows)(
    '$id [$class]: $description',
    async (row) => {
      const tracked = ['swift', 'xcuserdata', 'worktree', 'pod-install-in-worktree'].includes(row.id);
      const { root, baseline } = fixtures[tracked ? 'tracked' : 'generated'];
      expect(row.applies(root), `${row.id} must be exercised by the fixture`).toBe(true);
      const result = await mutation(row, root, baseline, 'ios', true);
      const outcome = verdict(row, result);
      console.log(JSON.stringify({ row: row.id, class: row.class, ...result, verdict: outcome.label }));
      expect(outcome.ok, `${row.id}: ${outcome.label}`).toBe(true);
    },
    SLOW,
  );
});
