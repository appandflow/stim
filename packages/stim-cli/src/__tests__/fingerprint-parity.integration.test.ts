import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExecutor } from '../exec.ts';
import {
  cleanupWorktrees,
  hashes,
  mutation,
  temporaryWorktree,
  type Measurement,
} from './fingerprint-parity-harness.ts';
import { git, rows, verdict, write } from './fingerprint-parity-rows.ts';

const MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const SLOW = 120_000;
let fixtures: Record<'generated' | 'tracked', { root: string; baseline: Measurement; commit: string }>;
const temps: string[] = [];
const retained = new Set<string>();

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
    `const variant = process.env.PARITY_NATIVE ?? 'production';
if (variant !== 'production' && variant !== 'development') throw new Error('Invalid PARITY_NATIVE');
module.exports = ({ config }) => ({ ...config, extra: { native: variant } });
`,
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
      generated: {
        root: generated,
        baseline: await hashes(generated, 'ios', true),
        commit: git(generated, 'rev-parse', 'HEAD'),
      },
      tracked: {
        root: tracked,
        baseline: await hashes(tracked, 'ios', true),
        commit: git(tracked, 'rev-parse', 'HEAD'),
      },
    };
  }, SLOW);
  beforeEach(() => {
    if (retained.size) throw new Error('A parity fixture has unverified oracle cleanup; remaining cases cannot run.');
  });
  afterEach(() => {
    cleanupWorktrees();
    for (const { root, commit } of Object.values(fixtures ?? {})) {
      if (retained.has(root)) continue;
      git(root, 'reset', '--hard', commit);
      git(root, 'clean', '-ffdx', '-e', 'node_modules');
    }
  });
  afterAll(() => {
    for (const root of temps) if (!retained.has(root)) rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.env.FINGERPRINT_LEGACY_ORACLE !== '1').each([
    ['generated', 'ios'],
    ['generated', 'android'],
    ['tracked', 'ios'],
    ['tracked', 'android'],
  ] as const)(
    'matches the committed legacy oracle for %s %s',
    async (kind, platform) => {
      const baseline = '6c5ef3bfcde179bcfe1f9d9186c399d3e313d44f';
      const repo = fileURLToPath(new URL('../../../..', import.meta.url));
      const temp = mkdtempSync(join(tmpdir(), 'stim-legacy-oracle-'));
      const signal = AbortSignal.timeout(80_000);
      const run = (file: string, args: string[]) =>
        getExecutor().runFileAsync(file, args, {
          cwd: repo,
          signal,
          timeoutMs: 80_000,
          cleanupOnExit: true,
          containProcessTree: true,
        });
      const script = fileURLToPath(
        new URL('../../../../scripts/agent-benchmark/verify-legacy-oracle.mjs', import.meta.url),
      );
      let cleanup = true;
      try {
        const archive = join(temp, 'baseline.tar');
        await run('git', ['archive', `--output=${archive}`, baseline, 'packages/stim-cli']);
        await run('tar', ['-xf', archive, '-C', temp]);
        const original = join(temp, 'packages/stim-cli');
        symlinkSync(join(repo, 'packages/stim-cli/node_modules'), join(original, 'node_modules'), 'junction');
        symlinkSync(join(repo, 'node_modules'), join(temp, 'node_modules'), 'junction');
        const adapter = fileURLToPath(new URL('./fingerprint-parity-legacy.ts', import.meta.url));
        const output = await run(process.execPath, [
          '--experimental-strip-types',
          script,
          join(original, 'src/cache/build-cache.ts'),
          adapter,
          fixtures[kind].root,
          platform,
        ]);
        const result = JSON.parse(output);
        expect(result).toMatchObject({ platform, hash: expect.any(String), sources: expect.any(Number) });
        const version = JSON.parse(
          readFileSync(join(repo, 'packages/stim-cli/node_modules/@expo/fingerprint/package.json'), 'utf8'),
        ).version;
        console.log(JSON.stringify({ ...result, baseline, expoFingerprint: version }));
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'reportCleanup' in error) {
          cleanup = false;
          retained.add(fixtures[kind].root);
          console.error(`Unverified oracle cleanup; retained ${temp} and ${fixtures[kind].root}`);
        }
        throw error;
      } finally {
        if (cleanup) rmSync(temp, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it.each(rows)(
    '$id [$class]: $description',
    async (row) => {
      const tracked = ['swift', 'xcuserdata', 'worktree', 'pod-install-in-worktree'].includes(row.id);
      const { root, baseline, commit } = fixtures[tracked ? 'tracked' : 'generated'];
      expect(git(root, 'rev-parse', 'HEAD')).toBe(commit);
      expect(row.applies(root), `${row.id} must be exercised by the fixture`).toBe(true);
      const result = await mutation(row, root, baseline, 'ios', true);
      const outcome = verdict(row, result);
      console.log(JSON.stringify({ row: row.id, class: row.class, ...result, verdict: outcome.label }));
      expect(outcome.ok, `${row.id}: ${outcome.label}`).toBe(true);
    },
    SLOW,
  );

  it(
    'measures a mutation against its own checkout',
    async () => {
      const checkout = temporaryWorktree(fixtures.generated.root);
      try {
        const row = rows.find((candidate) => candidate.id === 'js');
        assert(row);
        expect(await mutation(row, checkout.root, undefined, 'ios', true)).toMatchObject({
          expoMoved: false,
          stimMoved: false,
        });
      } finally {
        checkout.cleanup();
      }
    },
    SLOW,
  );

  it.each([
    { expression: `process.env.PARITY_NATIVE === 'development'`, applies: true },
    { expression: `['production', 'development'].includes(variant)`, applies: true },
    { expression: 'variant', applies: false },
  ])('derives a config environment alternative from $expression', ({ expression, applies }) => {
    const { root } = fixtures.generated;
    write(
      join(root, 'app.config.js'),
      `const variant = process.env.PARITY_NATIVE ?? 'production';\nmodule.exports = ${expression};\n`,
    );
    const row = rows.find((candidate) => candidate.id === 'config-env');
    assert(row);
    expect(row.applies(root)).toBe(applies);
    expect(row.env?.(root)).toEqual(applies ? { PARITY_NATIVE: 'development' } : undefined);
  });

  it.each(['success', 'remove', 'add'])('cleans up a temporary worktree after %s', async (stage) => {
    const failure = new Error(`${stage} failed`);
    const calls: string[] = [];
    let path = '';
    const command = vi
      .spyOn(await import('./fingerprint-parity-rows.ts'), 'git')
      .mockImplementation((root, ...args) => {
        if (args[0] === 'rev-parse') return root;
        calls.push(args[1] ?? '');
        if (args[1] === 'add') {
          path = args[4] ?? '';
          write(join(path, 'partial'), 'checkout');
          if (stage === 'add') throw failure;
        }
        if (args[1] === 'remove' && stage !== 'success') {
          throw stage === 'remove' ? failure : new Error('remove failed');
        }
        if (args[1] === 'prune') throw new Error('prune failed');
        return '';
      });
    try {
      let caught: unknown;
      try {
        const checkout = temporaryWorktree(fixtures.generated.root);
        checkout.cleanup();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(stage === 'success' ? undefined : failure);
      expect(calls).toEqual(stage === 'success' ? ['add', 'remove'] : ['add', 'remove', 'prune']);
      expect(existsSync(dirname(path))).toBe(false);
      cleanupWorktrees();
    } finally {
      command.mockRestore();
    }
  });
});
