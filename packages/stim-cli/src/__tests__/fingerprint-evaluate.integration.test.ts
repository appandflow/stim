import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { fingerprint, type EvalUncertain, type Fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';

const MOBILE_MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const SLOW = { timeout: 120_000 };
const temps: string[] = [];
let spawned: string[][] = [];

afterEach(() => {
  resetExecutor();
  spawned = [];
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A CNG Expo app outside any git work tree that installs nothing of its own: its node_modules is apps/mobile's, so
 * the evaluators run the Expo SDK, autolinking and expo-constants this repository installs.
 */
function expoApp(files: Record<string, string>, dependencies = ['expo', 'expo-constants', 'react-native']): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-eval-')));
  temps.push(root);
  const manifest = {
    name: 'fp-app',
    version: '1.0.0',
    dependencies: Object.fromEntries(dependencies.map((name) => [name, '*'])),
  };
  write(join(root, 'package.json'), JSON.stringify(manifest));
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  write(
    join(root, 'app.json'),
    JSON.stringify({ expo: { name: 'fp', slug: 'fp', ios: { config: { usesNonExemptEncryption: false } } } }),
  );
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  symlinkSync(MOBILE_MODULES, join(root, 'node_modules'));
  return root;
}

const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, ...extra });

function recordSpawns(): void {
  const real = getExecutor();
  setExecutor({
    ...real,
    spawn: (file: string, args: string[], options: object) => {
      spawned.push([file, ...args]);
      return real.spawn(file, args, options);
    },
  });
}

async function key(
  root: string,
  env: NodeJS.ProcessEnv,
  embedMode: 'development' | 'production' = 'development',
  platform: 'ios' | 'android' = 'ios',
): Promise<Fingerprint> {
  const result = await fingerprint(root, { platform }, { env, embedMode });
  if (isUncertain(result)) throw new Error(JSON.stringify(result, null, 2));
  return result;
}

async function refusal(root: string, env = baseEnv()): Promise<EvalUncertain> {
  const result = await fingerprint(root, { platform: 'ios' }, { env, embedMode: 'development' });
  if (!isUncertain(result)) throw new Error(`expected no key, got ${result.hash}`);
  return result;
}

const embedSpawns = () => spawned.filter((argv) => argv.includes('embed')).length;

describe.skipIf(!existsSync(MOBILE_MODULES))('fingerprint evaluators on the installed Expo SDK', () => {
  test('a Terminal-shaped and a CI-shaped shell give one key, and no evaluator reaches npx', SLOW, async () => {
    const root = expoApp({ 'app.config.js': 'module.exports = ({ config }) => config;\n' });
    const trap = join(root, 'trap');
    write(join(trap, 'npx'), `#!/bin/sh\ntouch "${join(trap, 'ran')}"\nexit 1\n`);
    chmodSync(join(trap, 'npx'), 0o755);
    const path = [trap, process.env.PATH].join(delimiter);
    recordSpawns();
    const terminal = await key(
      root,
      baseEnv({
        PATH: path,
        HOME: '/Users/someone',
        USER: 'someone',
        SHELL: '/bin/zsh',
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'Apple_Terminal',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/var/folders/x/T/',
        SHLVL: '2',
        SSH_AUTH_SOCK: '/private/tmp/agent',
      }),
    );
    const ci = await key(
      root,
      baseEnv({
        PATH: [trap, '/usr/local/bin', process.env.PATH].join(delimiter),
        HOME: '/home/runner',
        USER: 'runner',
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        RUNNER_OS: 'Linux',
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        DEBUG: 'expo:*',
      }),
    );
    expect(ci.hash).toBe(terminal.hash);
    expect(terminal.native).toBe('generated');
    expect(terminal.nativePackages).toEqual(expect.arrayContaining(['expo', 'expo-constants']));
    expect(existsSync(join(trap, 'ran'))).toBe(false);
    expect(spawned.length).toBeGreaterThan(0);
    for (const [file, ...args] of spawned) {
      expect(file).toMatch(/[\\/]node(?:\.exe)?$/);
      expect(args.join(' ')).not.toMatch(/\bnpx\b/);
    }
  });

  test(
    '.env.production moves the Release key and not the Debug key; a Debug embed reuses the config run',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js':
          'module.exports = ({ config }) => ({ ...config, extra: { label: process.env.LABEL ?? null } });\n',
        '.env.production': 'LABEL=one\n',
      });
      recordSpawns();
      const debug = await key(root, baseEnv());
      expect(embedSpawns()).toBe(0);
      const release = await key(root, baseEnv(), 'production');
      expect(embedSpawns()).toBe(1);
      expect(release.hash).not.toBe(debug.hash);
      write(join(root, '.env.production'), 'LABEL=two\n');
      expect((await key(root, baseEnv())).hash).toBe(debug.hash);
      expect((await key(root, baseEnv(), 'production')).hash).not.toBe(release.hash);
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

/** A bare app whose community CLI is a stand-in exporting only the sync `loadConfig`, under pnpm's isolated layout. */
function bareApp(platforms: Record<string, unknown>, project: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-bare-')));
  temps.push(root);
  write(join(root, 'package.json'), JSON.stringify({ name: 'bare', version: '1.0.0' }));
  write(join(root, 'package-lock.json'), '{}\n');
  const cli = join(root, 'node_modules', '@react-native-community', 'cli');
  write(join(cli, 'package.json'), JSON.stringify({ name: '@react-native-community/cli', version: '13.6.9' }));
  const config = join(cli, 'node_modules', '@react-native-community', 'cli-config');
  write(
    join(config, 'package.json'),
    JSON.stringify({ name: '@react-native-community/cli-config', version: '13.6.9', main: 'index.js' }),
  );
  write(
    join(config, 'index.js'),
    `exports.loadConfig = ({ projectRoot }) => ({ root: projectRoot, platforms: ${JSON.stringify(platforms)}, project: ${JSON.stringify(project)}, dependencies: {} });\n`,
  );
  write(join(root, 'ios', 'App', 'AppDelegate.swift'), '// app\n');
  return root;
}

describe('fingerprint evaluators on a bare React Native app', () => {
  test('keys the config the community CLI resolves from the app', SLOW, async () => {
    const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
    const result = await key(root, baseEnv());
    expect(result.native).toBe('tracked');
    expect(result.inputs.map((input) => input.name)).toEqual(
      expect.arrayContaining(['autolinking:rn', 'ios/App/AppDelegate.swift']),
    );
  });

  test('refuses a config without the platform, which a wrong cwd silently produces', SLOW, async () => {
    const root = bareApp({}, {});
    const result = await refusal(root);
    expect(result.evaluator).toBe('rnConfig');
    expect(result.stderrTail?.join('\n')).toMatch(/no ios platform/);
  });
});
