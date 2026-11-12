import { MOBILE_MODULES, SLOW, temps, write, expoApp, baseEnv, key, refusal } from './fingerprint-evaluate-harness.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';

describe.skipIf(!existsSync(MOBILE_MODULES))('fingerprint evaluators on the installed Expo SDK', () => {
  test.each([
    { name: 'absent credential', code: 'process.env.STIM_ACCESS_TICKET', present: false, refused: false },
    { name: 'unread credential', code: "'constant'", present: true, refused: false },
    { name: 'read credential', code: 'process.env.STIM_ACCESS_TICKET', present: true, refused: true },
    { name: 'enumerated credential', code: 'Object.keys(process.env).length', present: true, refused: true },
  ])('embedded config handles an $name without persisting its value', SLOW, async ({ code, present, refused }) => {
    const secret = 'private-fingerprint-fixture-value';
    const root = expoApp({
      'app.config.js': `module.exports = ({ config }) => ({ ...config, extra: { value: ${code} } });\n`,
    });
    const env = baseEnv(present ? { STIM_ACCESS_TICKET: secret } : {});
    const result = await fingerprint(root, { platform: 'ios' }, { env, embedMode: 'development', index: 'use' });
    expect(isUncertain(result)).toBe(refused);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(isUncertain(result) ? result.uncertain : '').toContain(refused ? 'private Stim credential' : '');
    const home = process.env.STIM_HOME;
    if (!home) throw new Error('The fixture has no Stim home.');
    const files = readdirSync(home, { recursive: true });
    const contents = files
      .map((file) => join(home, String(file)))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, 'utf8'));
    expect(contents.join('\n')).not.toContain(secret);
    const pending = fingerprintPendingVerifyDir();
    expect(refused && existsSync(pending) ? readdirSync(pending) : []).toEqual([]);
    expect(refused && existsSync(join(home, 'fingerprint', 'ios'))).toBe(false);
  });

  test(
    'package.json read by the config moves no key, and a workspace native package is keyed by content',
    SLOW,
    async () => {
      const mono = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-mono-')));
      temps.push(mono);
      const root = join(mono, 'apps', 'app');
      write(join(mono, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp' } }));
      write(
        join(root, 'app.config.js'),
        "module.exports = ({ config }) => ({ ...config, extra: { name: require('./package.json').name } });\n",
      );
      const manifest = (version: string) =>
        JSON.stringify({
          name: 'fp-app',
          version,
          dependencies: { expo: '*', 'expo-constants': '*', 'react-native': '*', 'native-lib': '*' },
        });
      write(join(root, 'package.json'), manifest('1.0.0'));
      const lib = join(mono, 'packages', 'native-lib');
      write(join(lib, 'package.json'), JSON.stringify({ name: 'native-lib', version: '1.0.0' }));
      write(
        join(lib, 'expo-module.config.json'),
        JSON.stringify({ platforms: ['apple'], apple: { modules: ['NativeLibModule'] } }),
      );
      write(join(lib, 'ios', 'NativeLib.podspec'), "Pod::Spec.new do |s|\n  s.name = 'NativeLib'\nend\n");
      write(join(lib, 'ios', 'NativeLibModule.swift'), '// one\n');
      const modules = join(root, 'node_modules');
      mkdirSync(modules);
      for (const name of readdirSync(MOBILE_MODULES)) symlinkSync(join(MOBILE_MODULES, name), join(modules, name));
      symlinkSync(lib, join(modules, 'native-lib'));
      const before = await key(root, baseEnv());
      expect(before.nativePackages).toContain('native-lib');
      write(join(root, 'package.json'), manifest('2.0.0'));
      expect((await key(root, baseEnv())).hash).toBe(before.hash);
      write(join(lib, 'ios', 'NativeLibModule.swift'), '// two\n');
      expect((await key(root, baseEnv())).hash).not.toBe(before.hash);
    },
  );

  test('EAS_BUILD evaluates the config in production mode, so .env.production moves the Debug key', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        'module.exports = ({ config }) => ({ ...config, extra: { label: process.env.LABEL ?? null } });\n',
      '.env.production': 'LABEL=one\n',
    });
    const eas = baseEnv({ EAS_BUILD: 'true' });
    const before = await key(root, eas);
    expect(before.config?.extra).toEqual({ label: 'one' });
    write(join(root, '.env.production'), 'LABEL=two\n');
    expect((await key(root, eas)).hash).not.toBe(before.hash);
    expect((await key(root, baseEnv())).config?.extra).not.toEqual({ label: 'two' });
  });

  test(
    'a config branching on CI keys a Release build by the build env, which the pins do not reach',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js': 'module.exports = ({ config }) => ({ ...config, extra: { ci: process.env.CI ?? null } });\n',
      });
      const local = await key(root, baseEnv(), 'production');
      const ci = await key(root, baseEnv({ CI: '1' }), 'production');
      expect(ci.hash).not.toBe(local.hash);
    },
  );

  test(
    'a config that spawns a child keys no unrelated env, and one reading a build script path name keys it once',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js': [
          "const { execFileSync } = require('node:child_process');",
          "execFileSync(process.execPath, ['-e', '0']);",
          'module.exports = ({ config }) => ({ ...config, extra: { hermes: process.env.HERMES_ENGINE_TARBALL_PATH ?? null } });',
          '',
        ].join('\n'),
      });
      const tarball = join(root, 'hermes.tar.gz');
      write(tarball, 'tarball');
      const first = await key(root, baseEnv({ HERMES_ENGINE_TARBALL_PATH: tarball, ITERM_SESSION_ID: 'w0t0' }));
      expect(first.opaque).toEqual(expect.arrayContaining([expect.stringContaining('child_process')]));
      expect((await key(root, baseEnv({ HERMES_ENGINE_TARBALL_PATH: tarball, SOME_TAB: 'w1t3' }))).hash).toBe(
        first.hash,
      );
    },
  );

  test('a file the config only probes for is keyed', SLOW, async () => {
    const root = expoApp({
      'app.config.js': "require('node:fs').existsSync('./flag');\nmodule.exports = ({ config }) => config;\n",
    });
    const before = await key(root, baseEnv());
    write(join(root, 'flag'), '');
    expect((await key(root, baseEnv())).hash).not.toBe(before.hash);
  });

  test(
    'a file outside the app that the config names by a relative path is hashed, and an installed one keys its package',
    SLOW,
    async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-outside-')));
      temps.push(outside);
      const plist = join(outside, 'GoogleService-Info.plist');
      write(plist, 'one');
      const root = expoApp({});
      write(
        join(root, 'app.config.js'),
        `module.exports = ({ config }) => ({ ...config, ios: { ...config.ios, googleServicesFile: ${JSON.stringify(relative(root, plist))} }, extra: { messages: require.resolve('@lingui/core/package.json') } });\n`,
      );
      const before = await key(root, baseEnv());
      expect(before.portable).toBe(false);
      expect(before.inputs.map((input) => input.name)).toContain('package:@lingui/core');
      write(plist, 'two');
      expect((await key(root, baseEnv())).hash).not.toBe(before.hash);
    },
  );

  test('a config that throws yields no key, naming the evaluator and its stderr', SLOW, async () => {
    const root = expoApp({ 'app.config.js': "throw new Error('config exploded');\n" });
    const result = await refusal(root);
    expect(result.evaluator).toBe('config');
    expect(result.uncertain).toMatch(/exited 1/);
    expect(result.stderrTail?.join('\n')).toContain('config exploded');
    expect(result.remedy).toBeTruthy();
  });

  test('autolinking output without the expo module yields no key', SLOW, async () => {
    const root = expoApp({}, []);
    const result = await refusal(root);
    expect(result.evaluator).toBe('expoAutolinking');
  });
});
