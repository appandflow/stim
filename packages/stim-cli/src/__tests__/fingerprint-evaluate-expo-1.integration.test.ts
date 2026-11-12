import {
  MOBILE_MODULES,
  SLOW,
  spawned,
  write,
  expoApp,
  baseEnv,
  recordSpawns,
  key,
} from './fingerprint-evaluate-harness.ts';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';

const embedSpawns = () => spawned.filter((argv) => argv.includes('embed')).length;

describe.skipIf(!existsSync(MOBILE_MODULES))('fingerprint evaluators on the installed Expo SDK', () => {
  test('embedded env enumeration does not reuse the pinned prebuild config', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        "module.exports = ({ config }) => ({ ...config, extra: { ci: Object.entries(process.env).find(([key]) => key === 'CI')?.[1] ?? null } });\n",
    });
    const first = await key(root, baseEnv({ CI: 'one' }));
    const second = await key(root, baseEnv({ CI: 'two' }));
    expect(second.hash).not.toBe(first.hash);
  });

  test('embedded config that enumerates env keys app STIM_ values', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        "module.exports = ({ config }) => ({ ...config, extra: { push: Object.entries(process.env).find(([key]) => key === 'STIM_APP_PUSH')?.[1] ?? null } });\n",
    });
    const first = await key(root, baseEnv({ STIM_APP_PUSH: 'one' }));
    const second = await key(root, baseEnv({ STIM_APP_PUSH: 'two' }));
    expect(second.hash).not.toBe(first.hash);
  });

  test.skipIf(process.platform === 'win32')(
    'case-colliding inputs keep a local key but refuse offload',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js':
          'module.exports = ({ config }) => ({ ...config, extra: { a: process.env.FP_FLAG, b: process.env.fp_flag } });\n',
      });
      const result = await key(root, baseEnv({ FP_FLAG: 'one', fp_flag: 'two' }));
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.portable).toBe(false);
    },
  );

  test('replay keeps a project input override instead of applying extraSources', SLOW, async () => {
    const root = expoApp({
      'fingerprint.config.js': "module.exports = { extraSources: [{ type: 'file', filePath: 'old.txt' }] };\n",
      'old.txt': 'old',
      'new.txt': 'new',
    });
    const env = baseEnv();
    const initial = await fingerprint(
      root,
      { platform: 'ios', fingerprintInputs: ['new.txt'] },
      { env, embedMode: 'development' },
    );
    if (isUncertain(initial)) throw new Error(initial.uncertain);
    const sources = initial.inputs.map(({ name, kind, hash }) => ({ id: name, kind, hash }));
    const replayed = await fingerprint(
      root,
      { platform: 'ios' },
      {
        env,
        embedMode: 'development',
        replay: { native: initial.native, sources },
      },
    );
    expect(isUncertain(replayed) ? replayed : replayed.hash).toBe(initial.hash);
  });

  test('inputs a project declares change the key', SLOW, async () => {
    const root = expoApp({
      'fingerprint.config.js':
        "module.exports = { extraSources: [{ type: 'file', filePath: 'declared.txt' }, { type: 'contents', id: 'flavor', contents: process.env.FP_DECLARED ?? '' }] };\n",
      'declared.txt': 'one',
      'listed.txt': 'one',
    });
    const compute = (env: NodeJS.ProcessEnv, fingerprintInputs?: string[]) =>
      fingerprint(root, { platform: 'ios', fingerprintInputs }, { env, embedMode: 'development' });
    const hashOf = async (result: ReturnType<typeof compute>) => {
      const value = await result;
      if (isUncertain(value)) throw new Error(value.uncertain);
      return value.hash;
    };
    const base = await hashOf(compute(baseEnv({ FP_DECLARED: 'a' })));
    expect(await hashOf(compute(baseEnv({ FP_DECLARED: 'a' })))).toBe(base);
    expect(await hashOf(compute(baseEnv({ FP_DECLARED: 'b' })))).not.toBe(base);
    write(join(root, 'declared.txt'), 'two');
    expect(await hashOf(compute(baseEnv({ FP_DECLARED: 'a' })))).not.toBe(base);
    const listed = await hashOf(compute(baseEnv(), ['listed.txt']));
    write(join(root, 'listed.txt'), 'two');
    expect(await hashOf(compute(baseEnv(), ['listed.txt']))).not.toBe(listed);
  });

  test('a copied Expo plugin callback is keyed and invalidates the evaluator index', SLOW, async () => {
    const root = expoApp({});
    const modules = join(root, 'node_modules');
    rmSync(modules);
    mkdirSync(modules);
    for (const name of readdirSync(MOBILE_MODULES))
      if (name !== '.package-lock.json' && name !== 'local-plugin')
        symlinkSync(join(MOBILE_MODULES, name), join(modules, name), 'junction');
    const dependency = join(modules, 'local-plugin');
    const plugin = join(dependency, 'app.plugin.js');
    write(join(dependency, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.0.0' }));
    write(join(dependency, 'ios', 'Module.m'), '// unchanged native file\n');
    write(plugin, "module.exports = config => ({ ...config, mods: { ios: { dangerous: () => 'first' } } });\n");
    write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp', plugins: ['local-plugin'] } }));
    write(join(modules, '.package-lock.json'), '{}');
    const compute = (index: 'use' | 'skip') =>
      fingerprint(root, { platform: 'ios' }, { env: baseEnv(), embedMode: 'development', index });
    const before = await compute('skip');
    const indexed = await compute('use');
    const warm = await compute('use');
    if (isUncertain(before) || isUncertain(indexed) || isUncertain(warm))
      throw new Error('The Expo plugin fixture did not produce a fingerprint.');
    expect(indexed.hash).toBe(before.hash);
    expect(warm).toMatchObject({ hash: before.hash, from: 'index' });
    write(plugin, "module.exports = config => ({ ...config, mods: { ios: { dangerous: () => 'changed' } } });\n");
    const after = await compute('skip');
    const indexedAfter = await compute('use');
    if (isUncertain(after) || isUncertain(indexedAfter)) throw new Error('The plugin edit produced no fingerprint.');
    expect(after.hash).not.toBe(before.hash);
    expect(indexedAfter.hash).toBe(after.hash);
  });

  test('listed-file replay ignores an unlisted file and refuses a changed listed file', SLOW, async () => {
    const root = expoApp({
      'fingerprint.config.js': "module.exports = { extraSources: [{ type: 'file', filePath: 'native-input.txt' }] };\n",
      'native-input.txt': 'before',
    });
    const env = baseEnv();
    const initial = await key(root, env);
    const sources = initial.inputs.map(({ name, kind, hash }) => ({ id: name, kind, hash }));
    write(join(root, 'unlisted.txt'), 'worker-only');
    const replay = () =>
      fingerprint(
        root,
        { platform: 'ios' },
        {
          env,
          embedMode: 'development',
          replay: { native: initial.native, sources },
        },
      );
    const same = await replay();
    expect(isUncertain(same) ? same : same.hash).toBe(initial.hash);
    write(join(root, 'native-input.txt'), 'changed');
    expect(isUncertain(await replay())).toBe(true);
  });

  test('a nested package env path keeps a local key but is not portable to a worker', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        'module.exports = ({ config }) => ({ ...config, extra: { nativePath: process.env.NATIVE_PATH } });\n',
    });
    const modules = join(root, 'node_modules');
    rmSync(modules);
    mkdirSync(modules);
    for (const name of ['expo', 'expo-constants', 'react-native'])
      symlinkSync(join(MOBILE_MODULES, name), join(modules, name));
    write(join(modules, 'dual', 'package.json'), JSON.stringify({ name: 'dual', version: '1.0.0' }));
    const nested = join(modules, 'owner', 'node_modules', 'dual');
    write(join(nested, 'package.json'), JSON.stringify({ name: 'dual', version: '2.0.0' }));
    write(join(nested, 'native.dat'), 'nested native content');
    const result = await key(root, baseEnv({ NATIVE_PATH: join(nested, 'native.dat') }));
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.portable).toBe(false);
  });

  test('a Terminal-shaped and a CI-shaped shell give one key, and no evaluator reaches npx', SLOW, async () => {
    const root = expoApp({
      'app.config.js': "module.exports = ({ config }) => ({ ...config, extra: { route: '/tmp' } });\n",
    });
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
    expect(terminal.portable).toBe(true);
    expect(terminal.nativePackages).toEqual(expect.arrayContaining(['expo', 'expo-constants']));
    expect(existsSync(join(trap, 'ran'))).toBe(false);
    expect(spawned.length).toBeGreaterThan(0);
    for (const [file, ...args] of spawned) {
      expect(file).toMatch(/[\\/]node(?:\.exe)?$/);
      expect(args.join(' ')).not.toMatch(/\bnpx\b/);
    }
  });

  test(
    "the embedded config follows the build env's NODE_ENV, as the installed expo-constants loads .env",
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js':
          "module.exports = ({ config }) => ({ ...config, extra: { api: process.env.NODE_ENV === 'development' ? process.env.DEV_API : process.env.API, push: process.env.STIM_APP_PUSH ?? null } });\n",
        '.env.production': 'API=one\n',
      });
      recordSpawns();
      const debug = await key(root, baseEnv({ API: 'p1' }));
      expect(embedSpawns()).toBe(1);
      expect((await key(root, baseEnv({ API: 'p2' }))).hash).not.toBe(debug.hash);
      expect((await key(root, baseEnv({ API: 'p1', STIM_APP_PUSH: '1' }))).hash).not.toBe(debug.hash);
      const release = await key(root, baseEnv(), 'production');
      const nodeEnvRelease = await key(root, baseEnv({ NODE_ENV: 'production' }), 'production');
      write(join(root, '.env.production'), 'API=two\n');
      expect((await key(root, baseEnv({ API: 'p1' }))).hash).toBe(debug.hash);
      const byMode = readFileSync(
        join(MOBILE_MODULES, 'expo-constants', 'scripts', 'getAppConfig.js'),
        'utf8',
      ).includes('loadProjectEnv');
      expect((await key(root, baseEnv(), 'production')).hash === release.hash).toBe(!byMode);
      expect((await key(root, baseEnv({ NODE_ENV: 'production' }), 'production')).hash).not.toBe(nodeEnvRelease.hash);
    },
  );
});
